/**
 * 立花証券 e支店 APIクライアント
 *
 * セッション管理、リクエスト送信、レスポンス変換を担当。
 * シングルトンで使用し、ログイン時に取得する仮想URLを全リクエストで共有する。
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import {
  TACHIBANA_API_URLS,
  TACHIBANA_CLMID,
  TACHIBANA_SESSION,
  type TachibanaEnv,
} from "../lib/constants/broker";
import { mapNumericKeys } from "../lib/tachibana-key-map";
import { TIMEZONE } from "../lib/constants";
import { notifyBrokerError, notifyBrokerLoginArmRequired } from "../lib/slack";
import { prisma } from "../lib/prisma";

dayjs.extend(utc);
dayjs.extend(timezone);

// ========================================
// 型定義
// ========================================

export interface TachibanaSession {
  /** 業務機能用URL */
  urlRequest: string;
  /** マスタ機能用URL */
  urlMaster: string;
  /** 時価情報用URL */
  urlPrice: string;
  /** EVENT I/F用URL（Long Polling） */
  urlEvent: string;
  /** WebSocket用URL */
  urlEventWebSocket: string;
  /** ログイン時刻 */
  loginAt: Date;
}

export interface TachibanaRequestParams {
  sCLMID: string;
  [key: string]: string;
}

export interface TachibanaResponse {
  sResultCode: string;
  sResultText?: string;
  sCLMID: string;
  [key: string]: unknown;
}

// ========================================
// TachibanaClient
// ========================================

export class TachibanaClient {
  private session: TachibanaSession | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private requestCounter = 0;
  private env: TachibanaEnv;
  private baseUrl: string;
  /** 再ログイン中の Promise（同時多発再ログインを防ぐ） */
  private reLoginPromise: Promise<void> | null = null;
  private ensureSessionPromise: Promise<void> | null = null;
  /** ログインロック検出時刻（nullなら正常） */
  private loginLockedUntil: Date | null = null;
  /** ログインロックのSlack通知済みフラグ（重複通知防止） */
  private loginLockNotified = false;
  /** 最後に「arm 必要」Slack通知を送った時刻（スパム防止） */
  private lastArmRequiredNotifiedAt: number = 0;
  /** ログインロック：手動解除まで無期限停止（Prisma/PostgreSQL互換の遠未来日時） */
  private static readonly INDEFINITE_LOCK_DATE = new Date("9999-12-31T23:59:59.999Z");
  /**
   * リクエストのシリアライズ用ミューテックス
   * p_no採番〜HTTPレスポンス受信までをアトミックにし、
   * 複数ジョブからの並行呼び出しによるp_no順序エラーを防ぐ。
   */
  private requestMutex: Promise<void> = Promise.resolve();
  /** セッション確立時に1回だけ呼ばれるコールバック（遅延ログイン用） */
  private sessionReadyCallbacks: Array<(session: TachibanaSession) => void> = [];

  constructor(env?: TachibanaEnv) {
    this.env = env ?? ((process.env.TACHIBANA_ENV as TachibanaEnv) || "demo");
    this.baseUrl = TACHIBANA_API_URLS[this.env];
  }

  // ========================================
  // 認証
  // ========================================

  /**
   * ログイン — 仮想URLを5つ取得しセッションに保持
   */
  async login(): Promise<TachibanaSession> {
    // ログインロック中はDBから確認してクールダウン期間スキップ
    let dbLockedUntil: Date | null = null;
    try {
      const configForLockCheck = await prisma.tradingConfig.findFirst({
        orderBy: { createdAt: "desc" },
        select: { loginLockedUntil: true },
      });
      dbLockedUntil = configForLockCheck?.loginLockedUntil ?? null;
    } catch (err) {
      console.warn("[TachibanaClient] Failed to read loginLockedUntil from DB, falling back to in-memory state", err);
      dbLockedUntil = this.loginLockedUntil;
    }
    if (dbLockedUntil && new Date() < dbLockedUntil) {
      this.loginLockedUntil = dbLockedUntil;
      throw new Error(
        `Tachibana login is locked until ${dbLockedUntil.toISOString()}. Call the support center to unlock.`,
      );
    }

    // ログイン承認（arm）ゲート — productionではダッシュボードでのボタン押下が必須
    await this.requireLoginArm();

    const userId = process.env.TACHIBANA_USER_ID;
    const password = process.env.TACHIBANA_PASSWORD;

    if (!userId || !password) {
      throw new Error(
        "TACHIBANA_USER_ID and TACHIBANA_PASSWORD are required in environment variables",
      );
    }

    const params = {
      p_no: this.nextRequestNo(),
      p_sd_date: this.formatTimestamp(),
      sCLMID: TACHIBANA_CLMID.LOGIN,
      sUserId: userId,
      sPassword: password,
    };

    const url = `${this.baseUrl}auth/?${this.encodeParams(params)}`;
    const raw = await this.fetchWithDecode(url);

    if (raw.sResultCode !== "0") {
      throw new Error(
        `Tachibana login failed: [${raw.sResultCode}] ${raw.sResultText ?? ""}`,
      );
    }

    // アカウントロック検出（パスワード間違い規定回数超過）
    const orderResultCode = raw.sOrderResultCode as string | undefined;
    if (orderResultCode === "10033" || orderResultCode === "10089") {
      await this.handleAccountLock(raw, orderResultCode);
    }

    // ログインロック解除（正常ログイン成功時）
    await this.clearLockOnSuccess();

    // 金商法のお知らせ未読チェック
    if (raw.sKinsyouhouMidokuFlg === "1") {
      throw new Error(
        "Tachibana login blocked: 金商法のお知らせが未読です。Webで確認してください。",
      );
    }

    // デバッグ: 仮想URL取得確認
    const urlRequest = raw.sUrlRequest as string | undefined;
    const urlMaster = raw.sUrlMaster as string | undefined;
    const urlPrice = raw.sUrlPrice as string | undefined;
    const urlEvent = raw.sUrlEvent as string | undefined;
    const urlEventWebSocket = raw.sUrlEventWebSocket as string | undefined;

    if (!urlRequest || !urlMaster || !urlPrice) {
      console.error("[TachibanaClient] Login response missing virtual URLs. Raw keys:", Object.keys(raw));
      console.error("[TachibanaClient] Raw response (partial):", JSON.stringify(raw, null, 2).slice(0, 2000));
      throw new Error(
        `Tachibana login succeeded but virtual URLs are missing: urlRequest=${urlRequest}, urlMaster=${urlMaster}, urlPrice=${urlPrice}`,
      );
    }

    this.session = {
      urlRequest,
      urlMaster,
      urlPrice,
      urlEvent: urlEvent ?? "",
      urlEventWebSocket: urlEventWebSocket ?? "",
      loginAt: new Date(),
    };

    console.log(
      `[TachibanaClient] Login successful (${this.env}) at ${this.session.loginAt.toISOString()}`,
    );
    console.log(
      `[TachibanaClient] Virtual URLs: request=${urlRequest?.slice(0, 60)}..., master=${urlMaster?.slice(0, 60)}..., price=${urlPrice?.slice(0, 60)}...`,
    );

    // セッションをDBに保存（デプロイ後の復元用）
    await this.saveSession(this.session);

    return this.session;
  }

  /**
   * ログアウト
   */
  async logout(): Promise<void> {
    this.stopAutoRefresh();

    if (!this.session) return;

    try {
      await this.requestToVirtualUrl(this.session.urlRequest, {
        sCLMID: TACHIBANA_CLMID.LOGOUT,
      });
      console.log("[TachibanaClient] Logout successful");
    } catch (e) {
      console.warn("[TachibanaClient] Logout error (ignored):", e);
    } finally {
      this.session = null;
    }
  }

  // ========================================
  // リクエスト送信
  // ========================================

  /**
   * 仮想URLに対してリクエストを送信
   */
  async requestToVirtualUrl(
    virtualUrl: string,
    params: TachibanaRequestParams,
  ): Promise<TachibanaResponse> {
    let resolve!: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    const prev = this.requestMutex;
    this.requestMutex = next;

    await prev;

    try {
      const fullParams = {
        ...params,
        p_no: this.nextRequestNo(),
        p_sd_date: this.formatTimestamp(),
      };

      const url = `${virtualUrl}?${this.encodeParams(fullParams)}`;
      let res = await this.fetchWithDecode(url);

      // p_no順序エラー: サーバー側の最終p_noを解析してカウンターを修正し1回リトライ
      if (this.isPNoError(res)) {
        this.fixPNoCounter(res);
        const retryParams = {
          ...params,
          p_no: this.nextRequestNo(),
          p_sd_date: this.formatTimestamp(),
        };
        res = await this.fetchWithDecode(`${virtualUrl}?${this.encodeParams(retryParams)}`);
      }

      if (!["0", "2"].includes(res.sResultCode)) {
        const logParams = (fullParams as Record<string, string>).sSecondPassword
          ? { ...fullParams, sSecondPassword: "***" }
          : fullParams;
        console.error(
          `[TachibanaClient] error response:`,
          JSON.stringify(res),
          "request:",
          JSON.stringify(logParams),
        );
      }
      return res;
    } finally {
      resolve();
    }
  }

  /**
   * REQUEST仮想URLにリクエスト送信（注文・口座系）
   */
  async request(
    params: TachibanaRequestParams,
  ): Promise<TachibanaResponse> {
    return this.requestWithRetry(() => this.session!.urlRequest, params);
  }

  /**
   * MASTER仮想URLにリクエスト送信
   */
  async requestMaster(
    params: TachibanaRequestParams,
  ): Promise<TachibanaResponse> {
    return this.requestWithRetry(() => this.session!.urlMaster, params);
  }

  /**
   * PRICE仮想URLにリクエスト送信
   * 読み取り専用のためミューテックスを使用せず並列実行可能。
   * p_noはJS単一スレッド内でのインクリメントのため採番順序は保証される。
   */
  async requestPrice(
    params: TachibanaRequestParams,
  ): Promise<TachibanaResponse> {
    await this.ensureSession();
    const res = await this.fetchPriceWithRetry(params);
    return res;
  }

  private async fetchPriceWithRetry(
    params: TachibanaRequestParams,
  ): Promise<TachibanaResponse> {
    const fullParams = {
      ...params,
      p_no: this.nextRequestNo(),
      p_sd_date: this.formatTimestamp(),
    };
    const url = `${this.session!.urlPrice}?${this.encodeParams(fullParams)}`;
    let res = await this.fetchWithDecode(url);

    // p_no順序エラー: カウンターを修正して1回リトライ
    if (this.isPNoError(res)) {
      this.fixPNoCounter(res);
      const retryParams = {
        ...params,
        p_no: this.nextRequestNo(),
        p_sd_date: this.formatTimestamp(),
      };
      res = await this.fetchWithDecode(`${this.session!.urlPrice}?${this.encodeParams(retryParams)}`);
    }

    if (this.isSessionError(res)) {
      console.warn(
        `[TachibanaClient] Session disconnected (${res.sResultText ?? ""}), re-logging in...`,
      );
      await this.reLoginOnce();
      const retryParams = {
        ...params,
        p_no: this.nextRequestNo(),
        p_sd_date: this.formatTimestamp(),
      };
      const retryUrl = `${this.session!.urlPrice}?${this.encodeParams(retryParams)}`;
      return this.fetchWithDecode(retryUrl);
    }

    return res;
  }

  // ========================================
  // セッション管理
  // ========================================

  /**
   * 30分ごとに自動再ログインを開始
   *
   * @param onRefresh - 再ログイン成功時のコールバック（WebSocket再接続等に使用）
   */
  startAutoRefresh(onRefresh?: (session: TachibanaSession) => void): void {
    this.stopAutoRefresh();

    this.refreshTimer = setInterval(async () => {
      try {
        console.log("[TachibanaClient] Auto-refreshing session...");
        const session = await this.login();
        onRefresh?.(session);
      } catch (e) {
        console.error("[TachibanaClient] Auto-refresh failed:", e);
      }
    }, TACHIBANA_SESSION.AUTO_REFRESH_INTERVAL_MS);
  }

  /**
   * 自動再ログインを停止
   */
  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * セッションURLをDBに保存（デプロイ後の復元用）
   */
  private async saveSession(session: TachibanaSession): Promise<void> {
    try {
      await prisma.brokerSession.upsert({
        where: { env: this.env },
        create: {
          env: this.env,
          urlRequest: session.urlRequest,
          urlMaster: session.urlMaster,
          urlPrice: session.urlPrice,
          urlEvent: session.urlEvent,
          urlEventWebSocket: session.urlEventWebSocket,
          loginAt: session.loginAt,
        },
        update: {
          urlRequest: session.urlRequest,
          urlMaster: session.urlMaster,
          urlPrice: session.urlPrice,
          urlEvent: session.urlEvent,
          urlEventWebSocket: session.urlEventWebSocket,
          loginAt: session.loginAt,
        },
      });
      console.log(`[TachibanaClient] Session saved to DB (${this.env})`);
    } catch (err) {
      console.warn("[TachibanaClient] Failed to save session to DB:", err);
    }
  }

  /**
   * DBからセッションを復元のみ（APIログインはしない）。
   * デプロイ時の起動処理で使用。セッションがなければ null を返し、
   * 実際のAPI呼び出し時に ensureSession() 経由で遅延ログインする。
   */
  async restoreFromDB(): Promise<TachibanaSession | null> {
    try {
      const saved = await prisma.brokerSession.findUnique({
        where: { env: this.env },
      });
      if (saved) {
        this.session = {
          urlRequest: saved.urlRequest,
          urlMaster: saved.urlMaster,
          urlPrice: saved.urlPrice,
          urlEvent: saved.urlEvent,
          urlEventWebSocket: saved.urlEventWebSocket,
          loginAt: saved.loginAt,
        };
        // セッション復元時はp_noをUnixタイムスタンプ秒にセットする。
        // p_noはセッション内で単調増加である必要があるため、
        // 0から再開すると前回セッションの値以下になりエラーになる。
        this.requestCounter = Math.floor(Date.now() / 1000);
        console.log(
          `[TachibanaClient] Session restored from DB (${this.env}), loginAt=${saved.loginAt.toISOString()}, p_no start=${this.requestCounter}`,
        );
        return this.session;
      }
    } catch (err) {
      console.warn("[TachibanaClient] Failed to restore session from DB:", err);
    }

    return null;
  }

  /**
   * DBからセッションを復元するか、なければ新規ログイン。
   * ensureSession() から呼ばれる遅延ログイン用。
   * セッションの有効性はテストしない — 最初のAPI呼び出しで sResultCode=2 が来れば
   * 既存の reLoginOnce() が自動で対応する。
   */
  async restoreOrLogin(): Promise<TachibanaSession> {
    const restored = await this.restoreFromDB();
    if (restored) {
      this.fireSessionReadyCallbacks();
      return restored;
    }

    console.log("[TachibanaClient] No saved session found, logging in...");
    const session = await this.login();
    this.fireSessionReadyCallbacks();
    return session;
  }

  /**
   * セッション確立時のコールバックを登録。
   * 既にセッションがあれば即座に呼び出す。
   * まだなければ、初回 ensureSession() でセッション確立後に呼び出す。
   */
  onSessionReady(callback: (session: TachibanaSession) => void): void {
    if (this.session) {
      callback(this.session);
    } else {
      this.sessionReadyCallbacks.push(callback);
    }
  }

  private fireSessionReadyCallbacks(): void {
    if (this.sessionReadyCallbacks.length === 0 || !this.session) return;
    const callbacks = this.sessionReadyCallbacks;
    this.sessionReadyCallbacks = [];
    for (const cb of callbacks) {
      try {
        cb(this.session);
      } catch (err) {
        console.error("[TachibanaClient] onSessionReady callback error:", err);
      }
    }
  }

  /**
   * セッションが有効かどうか
   */
  isLoggedIn(): boolean {
    return this.session !== null;
  }

  /**
   * 現在のセッション情報を取得
   */
  getSession(): TachibanaSession | null {
    return this.session;
  }

  /**
   * ログインロックの状態を取得
   */
  getLoginLockStatus(): { isLocked: boolean; lockedUntil: Date | null } {
    const isLocked = this.loginLockedUntil !== null && new Date() < this.loginLockedUntil;
    return {
      isLocked,
      lockedUntil: isLocked ? this.loginLockedUntil : null,
    };
  }

  /**
   * ログインロックを手動解除（コールセンターで解除後に使用）
   */
  async clearLoginLock(): Promise<void> {
    this.loginLockedUntil = null;
    this.loginLockNotified = false;
    this.session = null;
    console.log("[TachibanaClient] Login lock cleared manually");

    const config = await prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } });
    if (config) {
      await prisma.tradingConfig.update({
        where: { id: config.id },
        data: { loginLockedUntil: null, loginLockReason: null },
      });
    }
  }

  // ========================================
  // ログイン承認（arm）
  // ========================================

  /**
   * ログイン承認ゲート。production ではダッシュボードでの承認ボタン押下が必須。
   * 電話番号認証(10089)が login() で誘発されても利用者が対応できる状態を保証する。
   *
   * 有効時: loginArmedUntil > now の間 login() を通す（複数回のログインを許可）。
   * 無効時: Slack通知（スロットル付き）を送ってエラーを投げる。
   *
   * demo環境または `TACHIBANA_REQUIRE_LOGIN_ARM=false` ではスキップ。
   */
  private async requireLoginArm(): Promise<void> {
    if (!this.isLoginArmRequired()) return;

    const armedUntil = await this.readLoginArmedUntil();
    if (armedUntil && new Date() < armedUntil) return;

    // 未承認 → 通知とスロー
    const now = Date.now();
    const throttleMs = 5 * 60 * 1000;
    if (now - this.lastArmRequiredNotifiedAt > throttleMs) {
      this.lastArmRequiredNotifiedAt = now;
      notifyBrokerLoginArmRequired({
        reason: armedUntil ? "承認の有効期限切れ" : "未承認",
      }).catch(() => {});
    }
    throw new Error(
      "Tachibana login is not armed. Press 'ログイン承認' on the dashboard before login.",
    );
  }

  /** production 環境かつ opt-out されていなければ arm 必須 */
  private isLoginArmRequired(): boolean {
    if (process.env.TACHIBANA_REQUIRE_LOGIN_ARM === "false") return false;
    if (process.env.TACHIBANA_REQUIRE_LOGIN_ARM === "true") return true;
    return this.env === "production";
  }

  private async readLoginArmedUntil(): Promise<Date | null> {
    try {
      const config = await prisma.tradingConfig.findFirst({
        orderBy: { createdAt: "desc" },
        select: { loginArmedUntil: true },
      });
      return config?.loginArmedUntil ?? null;
    } catch (err) {
      console.warn("[TachibanaClient] Failed to read loginArmedUntil", err);
      return null;
    }
  }

  /**
   * ログインを承認する — 指定時間（ミリ秒）だけ login() を許可する。
   * TTL 超過後は再度 arm が必要。
   */
  async armLogin(ttlMs: number = TACHIBANA_SESSION.LOGIN_ARM_TTL_MS): Promise<Date> {
    const now = new Date();
    const until = new Date(now.getTime() + ttlMs);
    const config = await prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } });
    if (!config) {
      throw new Error("TradingConfig not found — cannot arm login.");
    }
    await prisma.tradingConfig.update({
      where: { id: config.id },
      data: { loginArmedUntil: until, loginArmedAt: now },
    });
    this.lastArmRequiredNotifiedAt = 0; // 次回未承認時に即通知できるようリセット
    console.log(`[TachibanaClient] Login armed until ${until.toISOString()}`);
    return until;
  }

  /** ログイン承認を解除 */
  async disarmLogin(): Promise<void> {
    const config = await prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } });
    if (!config) return;
    await prisma.tradingConfig.update({
      where: { id: config.id },
      data: { loginArmedUntil: null },
    });
    console.log("[TachibanaClient] Login disarmed");
  }

  /** ログイン承認状態を取得 */
  async getLoginArmStatus(): Promise<{
    required: boolean;
    armed: boolean;
    armedUntil: Date | null;
    armedAt: Date | null;
  }> {
    const required = this.isLoginArmRequired();
    const config = await prisma.tradingConfig.findFirst({
      orderBy: { createdAt: "desc" },
      select: { loginArmedUntil: true, loginArmedAt: true },
    });
    const armedUntil = config?.loginArmedUntil ?? null;
    const armed = !!(armedUntil && new Date() < armedUntil);
    return {
      required,
      armed,
      armedUntil,
      armedAt: config?.loginArmedAt ?? null,
    };
  }

  // ========================================
  // 内部ユーティリティ
  // ========================================

  /**
   * アカウントロック検出時の処理
   * - トレーディング停止（isActive=false）
   * - ロック理由・発生日時をDB永続化
   * - Slack通知（初回のみ）
   */
  private async handleAccountLock(
    raw: TachibanaResponse,
    orderResultCode: string,
  ): Promise<never> {
    const lockedUntil = TachibanaClient.INDEFINITE_LOCK_DATE;
    this.loginLockedUntil = lockedUntil;
    const isAccountLock = orderResultCode === "10033";
    const reason = isAccountLock ? "アカウントロック" : "電話番号認証が必要";
    const errorMsg = (raw.sOrderResultText as string) || reason;
    console.error(`[TachibanaClient] ${reason}: ${errorMsg}`);

    // DB書き込み: isActive停止 + ロック理由 + 発生日時を1回で更新
    try {
      const config = await prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } });
      if (config) {
        await prisma.tradingConfig.update({
          where: { id: config.id },
          data: {
            isActive: false,
            loginLockedUntil: lockedUntil,
            loginLockReason: reason,
            loginLockOccurredAt: new Date(),
          },
        });
      }
    } catch {
      // loginLockOccurredAt 列未存在でもフォールバック
      try {
        const config = await prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } });
        if (config) {
          await prisma.tradingConfig.update({
            where: { id: config.id },
            data: { isActive: false, loginLockedUntil: lockedUntil, loginLockReason: reason },
          });
        }
      } catch (innerErr) {
        console.warn("[TachibanaClient] Failed to persist account lock to DB", innerErr);
        // isActive=false だけでも試みる
        try {
          const config = await prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } });
          if (config) {
            await prisma.tradingConfig.update({
              where: { id: config.id },
              data: { isActive: false },
            });
          }
        } catch (e) {
          console.warn("[TachibanaClient] Failed to set isActive=false", e);
        }
      }
    }

    if (!this.loginLockNotified) {
      this.loginLockNotified = true;
      notifyBrokerError(
        reason,
        isAccountLock
          ? `立花証券のログインがロックされました。\n📞 サポートセンター: 03-3669-0777 ／ 電話認証: 050-3102-6575\n\nエラー: ${errorMsg}`
          : `立花証券のログインに電話番号認証が必要です。\n登録の電話番号から認証番号へ電話後、ダッシュボードの「再開」ボタンを押してください。\n\nエラー: ${errorMsg}`,
      ).catch(() => {});
    }

    throw new Error(`Tachibana login blocked (${reason}): ${errorMsg}`);
  }

  /**
   * 正常ログイン成功時にロック状態をクリア
   */
  private async clearLockOnSuccess(): Promise<void> {
    this.loginLockedUntil = null;
    this.loginLockNotified = false;

    try {
      const config = await prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } });
      if (config) {
        await prisma.tradingConfig.update({
          where: { id: config.id },
          data: { loginLockedUntil: null, loginLockReason: null },
        });
      }
    } catch (err) {
      console.warn("[TachibanaClient] Failed to clear login lock from DB", err);
    }
  }

  /**
   * セッション切断エラーかどうか判定
   */
  private isSessionError(res: TachibanaResponse): boolean {
    return res.sResultCode === "2";
  }

  /**
   * p_no順序エラーかどうか判定（前要求のp_no以下の値を送った場合）
   */
  private isPNoError(res: TachibanaResponse): boolean {
    return (
      res.sResultCode === "6" &&
      typeof res.sResultText === "string" &&
      res.sResultText.includes("前要求.p_no")
    );
  }

  /**
   * p_noエラーのレスポンスからサーバー側の最終p_noを読み取りカウンターを修正する。
   * エラーメッセージ例: 引数（p_no:[xxx] <= 前要求.p_no:[1776059556]）エラー。
   */
  private fixPNoCounter(res: TachibanaResponse): void {
    const match = /前要求\.p_no:\[(\d+)\]/.exec(res.sResultText as string);
    if (match) {
      const serverLastPNo = parseInt(match[1], 10);
      if (serverLastPNo >= this.requestCounter) {
        this.requestCounter = serverLastPNo;
        console.warn(
          `[TachibanaClient] p_no counter fixed: jumped to ${this.requestCounter} (was behind server's last p_no)`,
        );
      }
    }
  }

  /**
   * セッション切断時に自動再ログイン＋リトライ付きリクエスト
   *
   * 1回目のリクエストでセッション切断を検知した場合、
   * 再ログインして新しい仮想URLで1回だけリトライする。
   * 複数リクエストが同時に切断を検知した場合、再ログインは1回だけ実行し
   * 他のリクエストはその完了を待つ（競合状態を防ぐ）。
   */
  private async requestWithRetry(
    getUrl: () => string,
    params: TachibanaRequestParams,
  ): Promise<TachibanaResponse> {
    await this.ensureSession();
    const res = await this.requestToVirtualUrl(getUrl(), params);

    if (this.isSessionError(res)) {
      console.warn(
        `[TachibanaClient] Session disconnected (${res.sResultText ?? ""}), re-logging in...`,
      );
      await this.reLoginOnce();
      return this.requestToVirtualUrl(getUrl(), params);
    }

    return res;
  }

  /**
   * 再ログインを1回だけ実行する（同時多発呼び出し時は同一 Promise を共有）
   */
  private async reLoginOnce(): Promise<void> {
    if (!this.reLoginPromise) {
      this.reLoginPromise = this.login()
        .then(() => {
          this.reLoginPromise = null;
        })
        .catch((e) => {
          this.reLoginPromise = null;
          throw e;
        });
    }
    await this.reLoginPromise;
  }

  private async ensureSession(): Promise<void> {
    if (this.session) return;
    if (!this.ensureSessionPromise) {
      this.ensureSessionPromise = this.restoreOrLogin()
        .then(() => {
          this.ensureSessionPromise = null;
        })
        .catch((e) => {
          this.ensureSessionPromise = null;
          throw e;
        });
    }
    await this.ensureSessionPromise;
  }

  private nextRequestNo(): string {
    this.requestCounter += 1;
    return String(this.requestCounter);
  }

  private formatTimestamp(): string {
    return dayjs().tz(TIMEZONE).format("YYYY.MM.DD-HH:mm:ss.SSS");
  }

  private encodeParams(params: Record<string, string>): string {
    const json = JSON.stringify(params, null, 0);
    return encodeURIComponent(json);
  }

  private async fetchWithDecode(url: string): Promise<TachibanaResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      TACHIBANA_SESSION.REQUEST_TIMEOUT_MS,
    );

    try {
      const res = await fetch(url, { signal: controller.signal });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      // Shift_JISをデコード
      const buffer = await res.arrayBuffer();
      const decoder = new TextDecoder("shift_jis");
      const text = decoder.decode(buffer);

      // JSONパース → 数値キーを名前付きキーに変換
      const raw = JSON.parse(text) as Record<string, unknown>;
      return mapNumericKeys(raw) as TachibanaResponse;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ========================================
// シングルトン
// ========================================

let clientInstance: TachibanaClient | null = null;

/**
 * TachibanaClientのシングルトンインスタンスを取得
 */
export function getTachibanaClient(): TachibanaClient {
  if (!clientInstance) {
    clientInstance = new TachibanaClient();
  }
  return clientInstance;
}

/**
 * シングルトンインスタンスをリセット（テスト用）
 */
export function resetTachibanaClient(): void {
  if (clientInstance) {
    clientInstance.stopAutoRefresh();
    clientInstance = null;
  }
}

// ========================================
// バッチジョブ用初期化
// ========================================

/**
 * バッチジョブ用ブローカーセッション初期化
 *
 * GitHub Actionsでスタンドアロン実行されるジョブ向け。
 * WebSocket接続・自動リフレッシュは不要（バッチは15分以内に完了）。
 * 戻り値の cleanup() をジョブ終了時に呼ぶこと。
 */
export async function initBrokerForBatch(
  mode: "demo" | "live" | "dry_run",
): Promise<{ cleanup: () => Promise<void> }> {
  console.log(`[broker] ${mode} mode, logging in...`);
  const client = getTachibanaClient();
  await client.login();
  console.log("[broker] login successful");

  return {
    cleanup: async () => {
      try {
        if (client.isLoggedIn()) {
          await client.logout();
        }
      } catch (e) {
        console.warn("[broker] logout error (ignored):", e);
      }
      resetTachibanaClient();
    },
  };
}
