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
  TACHIBANA_BUSY_RESULT_CODE,
  TACHIBANA_CLMID,
  TACHIBANA_PNO,
  TACHIBANA_SESSION,
  type TachibanaEnv,
} from "../lib/constants/broker";
import { sleep } from "../lib/retry-utils";
import { mapNumericKeys } from "../lib/tachibana-key-map";
import {
  decryptVirtualUrl,
  loadTachibanaPrivateKey,
} from "../lib/tachibana-crypto";
import { TIMEZONE } from "../lib/constants";
import { notifyBrokerError, notifySlack } from "../lib/slack";
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
  private requestCounter = 0;
  private env: TachibanaEnv;
  private baseUrl: string;
  /** 実行中のログイン Promise（どの経路から呼ばれても同時に1本しか飛ばさない） */
  private loginPromise: Promise<TachibanaSession> | null = null;
  /** セッション回復（DB採用 or 再ログイン）中の Promise（同時多発を防ぐ） */
  private recoverPromise: Promise<void> | null = null;
  /** このプロセスで最後にログインを試行した時刻（再ログインの間隔制限用） */
  private lastLoginAttemptAt: Date | null = null;
  private ensureSessionPromise: Promise<void> | null = null;
  /** ログインロック検出時刻（nullなら正常） */
  private loginLockedUntil: Date | null = null;
  /** ログインロックのSlack通知済みフラグ（重複通知防止） */
  private loginLockNotified = false;
  /** 最後に通知した保守予定日キー（"webDoc:YYYYMMDD|apiSpec:YYYYMMDD"）。同値なら再通知しない */
  private lastMaintenanceNoticeKey: string | null = null;
  /** ログインロック：手動解除まで無期限停止（Prisma/PostgreSQL互換の遠未来日時） */
  private static readonly INDEFINITE_LOCK_DATE = new Date("9999-12-31T23:59:59.999Z");
  /**
   * TODO(temp-debug, v4r10移行調査): sCLMIDごとに最初の1回だけ生レスポンスをログ出力する
   * ための既出クラスセット。原因判明後、このプロパティごと削除する。
   */
  private static loggedDebugClmids = new Set<string>();
  /**
   * リクエストのシリアライズ用ミューテックス
   * p_no採番〜HTTPレスポンス受信までをアトミックにし、
   * 複数ジョブからの並行呼び出しによるp_no順序エラーを防ぐ。
   */
  private requestMutex: Promise<void> = Promise.resolve();
  /** セッション確立時に1回だけ呼ばれるコールバック（遅延ログイン用） */
  private sessionReadyCallbacks: Array<(session: TachibanaSession) => void> = [];
  /** ログイン成功のたびに毎回呼ばれる永続コールバック（WebSocketのURL追従用、KOH-640） */
  private sessionRefreshCallbacks: Array<(session: TachibanaSession) => void> = [];

  constructor(env?: TachibanaEnv) {
    this.env = env ?? ((process.env.TACHIBANA_ENV as TachibanaEnv) || "demo");
    this.baseUrl = TACHIBANA_API_URLS[this.env];
  }

  // ========================================
  // 認証
  // ========================================

  /**
   * ログイン — 仮想URLを5つ取得しセッションに保持
   *
   * 立花は「1日1回ログインすれば当該営業日は継続利用できる」としており、ログイン連打は
   * 高負荷として利用停止の対象になる（2026-10-02 警告）。経路（日次ログイン / セッション回復 /
   * 手動再開）が同時に呼んでも実際のログインは1本に束ねる。
   */
  async login(): Promise<TachibanaSession> {
    if (!this.loginPromise) {
      this.loginPromise = this.doLogin().finally(() => {
        this.loginPromise = null;
      });
    }
    return this.loginPromise;
  }

  private async doLogin(): Promise<TachibanaSession> {
    // ログインロック中はDBから確認してクールダウン期間スキップ
    let dbLockedUntil: Date | null = null;
    let dbLockReason: string | null = null;
    try {
      const configForLockCheck = await prisma.tradingConfig.findFirst({
        orderBy: { createdAt: "desc" },
        select: { loginLockedUntil: true, loginLockReason: true },
      });
      dbLockedUntil = configForLockCheck?.loginLockedUntil ?? null;
      dbLockReason = configForLockCheck?.loginLockReason ?? null;
    } catch (err) {
      console.warn("[TachibanaClient] Failed to read loginLockedUntil from DB, falling back to in-memory state", err);
      dbLockedUntil = this.loginLockedUntil;
    }
    if (dbLockedUntil && new Date() < dbLockedUntil) {
      this.loginLockedUntil = dbLockedUntil;
      throw new Error(
        `Tachibana login is locked until ${dbLockedUntil.toISOString()}${dbLockReason ? ` (${dbLockReason})` : ""}. ` +
          "原因を解消してからダッシュボードの「再開」で解除してください。",
      );
    }

    const authId = process.env.TACHIBANA_AUTH_ID;

    if (!authId) {
      throw new Error(
        "TACHIBANA_AUTH_ID is required in environment variables",
      );
    }

    const params = {
      p_no: this.nextRequestNo(),
      p_sd_date: this.formatTimestamp(),
      sCLMID: TACHIBANA_CLMID.LOGIN,
      sAuthId: authId,
    };

    const url = `${this.baseUrl}auth/?${this.encodeParams(params)}`;
    this.lastLoginAttemptAt = new Date();
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

    // 金商法のお知らせ（交付書面等）未読チェック
    // v4r10 のログイン応答では数値キー "542" が sKinsyouhouMidokuFlg（2026-10-01 本番実測:
    // 交付書面の確認前 "1" → 確認後 "0" に変化し、同時に仮想URLが空→発行に変わった）。
    // キーマップは全レスポンス共通のフラット構造で "542" は注文一覧の sOrderStatus に
    // 割り当て済みのため、ログイン応答に限ってここで読み替える（ログイン応答に注文状態は無い）。
    const kinsyouhouMidoku = raw.sKinsyouhouMidokuFlg ?? raw.sOrderStatus;
    if (kinsyouhouMidoku === "1") {
      const webDoc = typeof raw.sUpdateInformWebDocument === "string" ? raw.sUpdateInformWebDocument : "";
      await this.persistTemporaryLoginBlock("交付書面未確認");
      await this.notifyLoginBlockedByUnreadDocument(webDoc);
      throw new Error(
        "Tachibana login blocked: 金商法のお知らせ（交付書面等）が未読です。e支店の標準Webで確認してください。",
      );
    }

    // v4r9 numeric key map 検証用: ログイン応答に含まれる全キーをログ出力
    // （URL値はマスク。本来 5本の仮想URL がどの数値キーに入っているかを特定するため）
    console.log(
      "[TachibanaClient] Login raw response keys:",
      JSON.stringify(
        Object.fromEntries(
          Object.entries(raw).map(([k, v]) => [
            k,
            typeof v === "string" && v.length > 40 ? `${v.slice(0, 40)}…(len=${v.length})` : v,
          ]),
        ),
      ),
    );

    // 保守予定日（交付書面更新 / API リリース）の通知（v4r9）
    // 数値キーは公式ドキュメントに記載なし。名前付きキーで返るケースをフォールバック検出。
    // 数値キーで返る場合はログ dump（上の console.log）から発見次第 tachibana-key-map.ts に追加する。
    await this.checkMaintenanceNotices(raw);

    // 仮想URLは公開鍵で暗号化されているので秘密鍵で復号する（v4r9）
    const encRequest = raw.sUrlRequest as string | undefined;
    const encMaster = raw.sUrlMaster as string | undefined;
    const encPrice = raw.sUrlPrice as string | undefined;
    const encEvent = raw.sUrlEvent as string | undefined;
    const encEventWebSocket = raw.sUrlEventWebSocket as string | undefined;

    if (!encRequest || !encMaster || !encPrice) {
      console.error("[TachibanaClient] Login response missing virtual URLs. Raw keys:", Object.keys(raw));
      console.error("[TachibanaClient] Raw response (partial):", JSON.stringify(raw, null, 2).slice(0, 2000));
      return this.throwMissingVirtualUrls(raw, encRequest, encMaster, encPrice);
    }

    const privateKey = loadTachibanaPrivateKey();
    const urlRequest = this.decryptUrlOrThrow(encRequest, privateKey, "request");
    const urlMaster = this.decryptUrlOrThrow(encMaster, privateKey, "master");
    const urlPrice = this.decryptUrlOrThrow(encPrice, privateKey, "price");
    const urlEvent = encEvent
      ? this.decryptUrlOrThrow(encEvent, privateKey, "event")
      : "";
    const urlEventWebSocket = encEventWebSocket
      ? this.decryptUrlOrThrow(encEventWebSocket, privateKey, "eventWebSocket")
      : "";

    // v4r10 で仮想URLの数値キー順が未確定のため、復号後のパスセグメントで
    // キー割り当てが正しいか検証する。ズレていた場合、誤った urlRequest 等を
    // DBに保存してしまうと以降の全リクエストが壊れたセッションで404を繰り返す
    // ため、保存前に検知して例外で止める（2026-09-29 KOH-未採番）。
    this.assertVirtualUrlShape(urlRequest, "/request/", "urlRequest");
    this.assertVirtualUrlShape(urlMaster, "/master/", "urlMaster");
    this.assertVirtualUrlShape(urlPrice, "/price/", "urlPrice");
    if (urlEvent) this.assertVirtualUrlShape(urlEvent, "/event/", "urlEvent");
    if (urlEventWebSocket) {
      if (!urlEventWebSocket.startsWith("wss://")) {
        throw new Error(
          `Tachibana login: urlEventWebSocket does not look like a WebSocket URL (expected wss://): ${urlEventWebSocket.slice(0, 60)}...`,
        );
      }
    }

    // ログインロック解除（仮想URLまで揃った完全な成功時のみ。ブロック中のクールダウンを消さないため）
    await this.clearLockOnSuccess();

    this.session = {
      urlRequest,
      urlMaster,
      urlPrice,
      urlEvent,
      urlEventWebSocket,
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

    // 新セッションのURLをリスナーに通知（EVENT I/F WebSocket の再接続等）。
    // どの経路のログイン（auto-refresh / reLoginOnce / 手動）でも必ず発火する —
    // 旧実装は auto-refresh 経由のみで、reLoginOnce() が走ると旧セッションが
    // 無効化されたまま WebSocket が取り残されていた（KOH-640）
    this.fireSessionRefreshCallbacks();

    return this.session;
  }

  /**
   * ログアウト
   */
  async logout(): Promise<void> {
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
      let fullParams = {
        ...params,
        p_no: this.nextRequestNo(),
        p_sd_date: this.formatTimestamp(),
      };
      let res = await this.fetchWithDecodeOrSessionError(`${virtualUrl}?${this.encodeParams(fullParams)}`);

      // p_no順序エラー: fix→retry 間に他プロセス／並行リクエストが p_no を進めると
      // retry も同じエラーになることがあるため MAX_RETRIES 回までリトライする。
      for (
        let attempt = 0;
        attempt < TACHIBANA_PNO.MAX_RETRIES && this.isPNoError(res);
        attempt += 1
      ) {
        this.fixPNoCounter(res);
        fullParams = {
          ...params,
          p_no: this.nextRequestNo(),
          p_sd_date: this.formatTimestamp(),
        };
        res = await this.fetchWithDecodeOrSessionError(`${virtualUrl}?${this.encodeParams(fullParams)}`);
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
    let fullParams = {
      ...params,
      p_no: this.nextRequestNo(),
      p_sd_date: this.formatTimestamp(),
    };
    let res = await this.fetchWithDecodeOrSessionError(`${this.session!.urlPrice}?${this.encodeParams(fullParams)}`);

    // p_no順序エラー: fix→retry 間に他プロセス／並行リクエストが p_no を進めると
    // retry も同じエラーになることがあるため MAX_RETRIES 回までリトライする。
    for (
      let attempt = 0;
      attempt < TACHIBANA_PNO.MAX_RETRIES && this.isPNoError(res);
      attempt += 1
    ) {
      this.fixPNoCounter(res);
      fullParams = {
        ...params,
        p_no: this.nextRequestNo(),
        p_sd_date: this.formatTimestamp(),
      };
      res = await this.fetchWithDecodeOrSessionError(`${this.session!.urlPrice}?${this.encodeParams(fullParams)}`);
    }

    if (this.isSessionError(res)) {
      console.warn(
        `[TachibanaClient] Session disconnected (${res.sResultText ?? ""}), re-logging in...`,
      );
      await this.recoverSession();
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
   * 日次ログイン（worker の cron から平日朝に1回呼ぶ）。
   *
   * 当日分のセッションを既に持っている（このプロセス or 別プロセスがDBに保存済み）なら
   * ログインしない。立花は「1日1回の仮想URL取得で当該営業日は継続利用可」としている。
   * 失敗してもリトライタイマーは張らない — 以降はセッション切れ検知時の recoverSession()
   * が間隔制限付きで回復する（旧 auto-refresh の30分リトライが 2026-10-01 に一晩中
   * ログインを繰り返した反省）。
   */
  async ensureDailySession(): Promise<void> {
    const dayStart = dayjs()
      .tz(TIMEZONE)
      .startOf("day")
      .hour(TACHIBANA_SESSION.SESSION_DAY_START_HOUR);

    if (this.session && !dayjs(this.session.loginAt).isBefore(dayStart)) {
      console.log("[TachibanaClient] Daily login: 当日のセッションを保持済み — スキップ");
      return;
    }

    const saved = await this.loadSavedSession();
    if (saved && !dayjs(saved.loginAt).isBefore(dayStart)) {
      console.log("[TachibanaClient] Daily login: 当日のセッションをDBから採用 — ログインしない");
      this.adoptSession(saved);
      return;
    }

    console.log("[TachibanaClient] Daily login: ログインします");
    await this.login();
  }

  /**
   * セッション切れ（sResultCode=2 / EVENT I/F の session inactive）からの回復。
   *
   * 1. 別プロセスがより新しいセッションをDBに保存していればそれを採用する（ログインしない）。
   *    立花は新規ログインで旧セッションを無効化するため、各プロセスが自前でログインすると
   *    互いのセッションを潰し合う連鎖になる（2026-10-01 に worker と各ジョブで発生）。
   * 2. 直近ログイン（このプロセスの試行 / DB上の成功）から RELOGIN_MIN_INTERVAL_MS 以内なら
   *    ログインせずエラーにする。直前に取ったセッションがもう切れているなら再ログインでは
   *    解消しない異常で、連打は高負荷として利用停止の対象になる。
   * 3. それ以外のときだけ再ログインする。
   *
   * 同時多発呼び出しは同一 Promise を共有する。
   */
  async recoverSession(): Promise<void> {
    if (!this.recoverPromise) {
      this.recoverPromise = this.doRecoverSession().finally(() => {
        this.recoverPromise = null;
      });
    }
    await this.recoverPromise;
  }

  private async doRecoverSession(): Promise<void> {
    const saved = await this.loadSavedSession();
    if (
      saved &&
      (!this.session || dayjs(saved.loginAt).isAfter(this.session.loginAt))
    ) {
      console.log(
        `[TachibanaClient] より新しいセッションがDBにあるため採用します（loginAt=${saved.loginAt.toISOString()}）`,
      );
      this.adoptSession(saved);
      return;
    }

    const now = dayjs();
    const minInterval = TACHIBANA_SESSION.RELOGIN_MIN_INTERVAL_MS;
    const recentAttempt =
      this.lastLoginAttemptAt && now.diff(this.lastLoginAttemptAt) < minInterval
        ? this.lastLoginAttemptAt
        : saved && now.diff(saved.loginAt) < minInterval
          ? saved.loginAt
          : null;
    if (recentAttempt) {
      throw new Error(
        `Tachibana re-login throttled: 直近のログイン（${recentAttempt.toISOString()}）から` +
          `${minInterval / 60_000}分以内のため再ログインしません（立花へのログイン連打防止）`,
      );
    }

    console.warn("[TachibanaClient] セッション切れのため再ログインします");
    await this.login();
  }

  /** DBに保存されたセッションを読む（失敗時は null） */
  private async loadSavedSession(): Promise<TachibanaSession | null> {
    try {
      const saved = await prisma.brokerSession.findUnique({
        where: { env: this.env },
      });
      if (!saved) return null;
      return {
        urlRequest: saved.urlRequest,
        urlMaster: saved.urlMaster,
        urlPrice: saved.urlPrice,
        urlEvent: saved.urlEvent,
        urlEventWebSocket: saved.urlEventWebSocket,
        loginAt: saved.loginAt,
      };
    } catch (err) {
      console.warn("[TachibanaClient] Failed to load session from DB:", err);
      return null;
    }
  }

  /**
   * 別プロセスが取得したセッションを採用する（ログインしない）。
   * p_no はセッション内で単調増加が必要なので restoreFromDB と同じく秒タイムスタンプから再開し、
   * EVENT I/F の URL 追従のため onSessionRefresh を発火する。
   */
  private adoptSession(session: TachibanaSession): void {
    this.session = session;
    this.requestCounter = Math.max(this.requestCounter, Math.floor(Date.now() / 1000));
    this.fireSessionRefreshCallbacks();
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
   * ログイン成功のたびに呼ばれる永続コールバックを登録（onSessionReady と違い毎回発火）。
   * どの経路のログイン（auto-refresh / reLoginOnce / 手動）でも新セッションが通知されるので、
   * EVENT I/F WebSocket のURL追従に使う。
   */
  onSessionRefresh(callback: (session: TachibanaSession) => void): void {
    this.sessionRefreshCallbacks.push(callback);
  }

  private fireSessionRefreshCallbacks(): void {
    if (!this.session) return;
    for (const cb of this.sessionRefreshCallbacks) {
      try {
        cb(this.session);
      } catch (err) {
        console.error("[TachibanaClient] onSessionRefresh callback error:", err);
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
  // 保守通知
  // ========================================

  /**
   * 人間の操作なしには解消しないログインブロック（交付書面未確認等）を検知したとき、
   * DB の loginLockedUntil にクールダウンを書いて全プロセスのログインを止める。
   * 2026-10-01 は書面確認までの約10時間、auto-refresh・各ジョブ・EVENT I/F の再ログインが
   * それぞれログインを繰り返し、立花から高負荷警告を受けた。isActive は変えない
   * （書面確認後にクールダウン経過 or 「再開」で自然に復帰させるため）。
   */
  private async persistTemporaryLoginBlock(reason: string): Promise<void> {
    const lockedUntil = dayjs().add(TACHIBANA_SESSION.LOGIN_BLOCK_COOLDOWN_MS, "millisecond").toDate();
    this.loginLockedUntil = lockedUntil;
    try {
      const config = await prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } });
      if (config) {
        await prisma.tradingConfig.update({
          where: { id: config.id },
          data: { loginLockedUntil: lockedUntil, loginLockReason: reason },
        });
      }
    } catch (err) {
      console.warn("[TachibanaClient] Failed to persist temporary login block to DB", err);
    }
  }

  /** 交付書面未確認でログインがブロックされた旨を 🚨 で通知する（人間の操作が必要なため） */
  private async notifyLoginBlockedByUnreadDocument(webDoc: string): Promise<void> {
    try {
      await notifySlack({
        title: "🚨 立花証券ログインがブロックされています（交付書面未確認）",
        message: [
          webDoc ? `交付書面更新日: ${webDoc}` : "",
          "ログインは成功扱いだが仮想URLが発行されず、API が一切使えない状態です。",
          "",
          `立花への負荷を避けるため、全プロセスのログインを${TACHIBANA_SESSION.LOGIN_BLOCK_COOLDOWN_MS / 60_000}分間停止しました。`,
          "",
          "対応: e支店の標準Webにログインして交付書面を確認 → ダッシュボードの「再開」で即時解除（または停止時間の経過を待つ）→ 失敗したジョブを再実行",
        ].filter(Boolean).join("\n"),
        color: "danger",
      });
    } catch (err) {
      console.error("[TachibanaClient] Failed to notify login block to Slack:", err);
    }
  }

  /**
   * ログインは sResultCode=0 で通ったのに仮想URLが空のときの例外を組み立てる。
   *
   * 交付書面更新日（sUpdateInformWebDocument）を過ぎて書面が未確認だと、立花はログインを
   * 成功扱いにしたまま仮想URLを空で返す（2026-10-01 本番で実測）。未読フラグのキーが
   * 将来またシフトして上の未読チェックをすり抜けた場合の保険として、更新日が今日以前なら
   * 書面未確認の可能性を明示する。
   */
  private async throwMissingVirtualUrls(
    raw: Record<string, unknown>,
    encRequest: string | undefined,
    encMaster: string | undefined,
    encPrice: string | undefined,
  ): Promise<never> {
    const webDoc = typeof raw.sUpdateInformWebDocument === "string" ? raw.sUpdateInformWebDocument : "";
    const today = dayjs().tz(TIMEZONE).format("YYYYMMDD");

    if (webDoc && webDoc <= today) {
      await this.persistTemporaryLoginBlock("交付書面未確認");
      await this.notifyLoginBlockedByUnreadDocument(webDoc);
      throw new Error(
        `Tachibana login blocked: 交付書面（更新日 ${webDoc}）が未確認の可能性があります。` +
          "e支店の標準Webにログインして書面を確認してください（仮想URLが空で返却された）",
      );
    }

    throw new Error(
      `Tachibana login succeeded but virtual URLs are missing: urlRequest=${encRequest}, urlMaster=${encMaster}, urlPrice=${encPrice}`,
    );
  }

  /**
   * 保守予定日（交付書面更新 / e支店APIリリース）の検出と Slack 通知
   *
   * `sUpdateInformWebDocument` / `sUpdateInformAPISpecFunction` は該当事象の予定日を
   * 事前にお知らせする項目で、予定日を過ぎても同じ値が返り続ける。
   * - 交付書面は予定日 > 当日（事前告知）のときだけ通知する。当日以降に未確認なら
   *   login() の未読フラグ検知が 🚨 を出すので、確認済みなのに予定日当日いっぱい
   *   📢 が鳴り続けるのを避ける（2026-10-01 に確認後も通知が繰り返された）
   * - dedup は DB（TradingConfig.maintenanceNoticeKey）で行う。GitHub Actions のジョブは
   *   毎回別プロセスでログインするため、in-memory だけではジョブの数だけ通知されていた
   */
  private async checkMaintenanceNotices(raw: Record<string, unknown>): Promise<void> {
    const webDoc = typeof raw.sUpdateInformWebDocument === "string" ? raw.sUpdateInformWebDocument : "";
    const apiSpec = typeof raw.sUpdateInformAPISpecFunction === "string" ? raw.sUpdateInformAPISpecFunction : "";

    if (!webDoc && !apiSpec) return;

    const today = dayjs().tz(TIMEZONE).format("YYYYMMDD");
    const upcoming: string[] = [];
    if (webDoc && webDoc > today) upcoming.push(`交付書面更新予定日: ${webDoc}`);
    if (apiSpec && apiSpec >= today) upcoming.push(`e支店・APIリリース予定日: ${apiSpec}`);

    if (!upcoming.length) return;

    const key = upcoming.join(" / ");
    if (this.lastMaintenanceNoticeKey === key) return;
    this.lastMaintenanceNoticeKey = key;

    try {
      const config = await prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } });
      if (config?.maintenanceNoticeKey === key) return;
      if (config) {
        await prisma.tradingConfig.update({
          where: { id: config.id },
          data: { maintenanceNoticeKey: key },
        });
      }
    } catch (err) {
      // DB で dedup できなくても通知自体は出す（重複より取りこぼしの方が困る）
      console.warn("[TachibanaClient] Failed to dedup maintenance notice via DB:", err);
    }

    console.warn(`[TachibanaClient] 立花証券保守通知: ${upcoming.join(" / ")}`);

    try {
      await notifySlack({
        title: "📢 立花証券 保守通知（v4r9）",
        message: [
          ...upcoming,
          "",
          "予定日までに対応してください:",
          "- 交付書面更新: 標準Webで書面確認",
          "- APIリリース: HPで変更内容を確認し必要な対処を実施",
        ].join("\n"),
        color: "warning",
      });
    } catch (err) {
      console.error("[TachibanaClient] Failed to notify maintenance notice to Slack:", err);
    }
  }

  // ========================================
  // 内部ユーティリティ
  // ========================================

  /**
   * 公開鍵で暗号化された仮想URLを秘密鍵で復号する。
   * 復号に失敗した場合は、鍵の不一致を示す明確なエラーを投げる。
   */
  private decryptUrlOrThrow(
    encrypted: string,
    privateKey: string,
    label: string,
  ): string {
    try {
      return decryptVirtualUrl(encrypted, privateKey);
    } catch (err) {
      throw new Error(
        `Failed to decrypt ${label} virtual URL. TACHIBANA_PRIVATE_KEY が利用設定画面で登録した公開鍵と対になっているか確認してください: ${(err as Error).message}`,
      );
    }
  }

  /**
   * 復号済み仮想URLが期待するパスセグメントを含むか検証する。
   * ログイン応答の数値キー→名前付きキー対応が誤っている場合、復号自体は
   * 成功する（5本とも同じ公開鍵で暗号化されているため）が別種のURLを
   * urlRequest 等に割り当ててしまう。DB保存前にここで検知する。
   */
  private assertVirtualUrlShape(
    url: string,
    expectedSegment: string,
    label: string,
  ): void {
    if (!url.includes(expectedSegment)) {
      throw new Error(
        `Tachibana login: ${label} does not contain expected segment "${expectedSegment}" — numeric key mapping is likely wrong. Got: ${url.slice(0, 60)}...`,
      );
    }
  }

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
      const appUrl = process.env.APP_URL?.replace(/\/$/, "");
      const resumeLink = appUrl
        ? `\nシステム再開: <${appUrl}/api/trading/resume|${appUrl}/api/trading/resume>`
        : "";
      notifyBrokerError(
        reason,
        isAccountLock
          ? `立花証券のログインがロックされました。\n📞 サポートセンター: <tel:0336690777|03-3669-0777> ／ 電話認証: <tel:0120286592|0120-286-592>\n\nエラー: ${errorMsg}`
          : `立花証券のログインに電話番号認証が必要です。\n登録の電話番号から <tel:0120286592|0120-286-592> に発信後、ダッシュボードの「再開」ボタンを押してください。${resumeLink}\n\nエラー: ${errorMsg}`,
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
   * システム混雑エラー(sResultCode=-2)かどうか判定。
   * 「ただいまシステムが大変混み合っております」= 一時的なサーバー高負荷。
   * セッションは生存しており、リクエストは処理前に拒否されているため安全にリトライ可能。
   */
  private isBusyError(res: TachibanaResponse): boolean {
    return res.sResultCode === TACHIBANA_BUSY_RESULT_CODE;
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
   *
   * サーバ最終p_no ちょうどに合わせると再送は +1 しか先行せず、セッションを共有する
   * 並行プロセス（常駐 worker 等）のバーストに即座に追い抜かれてリトライを使い切る。
   * SAFETY_MARGIN 分だけ上乗せして先行し、以後しばらくは fix 無しで走れるようにする。
   */
  private fixPNoCounter(res: TachibanaResponse): void {
    const match = /前要求\.p_no:\[(\d+)\]/.exec(res.sResultText as string);
    if (match) {
      const serverLastPNo = parseInt(match[1], 10);
      const target = serverLastPNo + TACHIBANA_PNO.FIX_SAFETY_MARGIN;
      if (target > this.requestCounter) {
        this.requestCounter = target;
        console.warn(
          `[TachibanaClient] p_no counter fixed: jumped to ${this.requestCounter} (server last=${serverLastPNo} + margin ${TACHIBANA_PNO.FIX_SAFETY_MARGIN})`,
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
    let res = await this.requestToVirtualUrl(getUrl(), params);

    if (this.isSessionError(res)) {
      console.warn(
        `[TachibanaClient] Session disconnected (${res.sResultText ?? ""}), re-logging in...`,
      );
      await this.recoverSession();
      res = await this.requestToVirtualUrl(getUrl(), params);
    }

    // システム混雑(-2)は一時的な高負荷。指数バックオフでリトライする。
    // 混雑エラーはリクエストが処理される前に拒否されるため、発注系でも
    // 二重発注のリスクなく再送できる。
    for (
      let attempt = 0;
      attempt < TACHIBANA_SESSION.BUSY_RETRY_MAX && this.isBusyError(res);
      attempt += 1
    ) {
      const waitMs = TACHIBANA_SESSION.BUSY_RETRY_BASE_MS * 2 ** attempt;
      console.warn(
        `[TachibanaClient] system busy (${res.sResultText ?? ""}), retrying in ${waitMs}ms (${attempt + 1}/${TACHIBANA_SESSION.BUSY_RETRY_MAX})`,
      );
      await sleep(waitMs);
      res = await this.requestToVirtualUrl(getUrl(), params);
    }

    return res;
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

  /**
   * fetchWithDecode を試み、HTTP層のエラー（404等）をセッション切断
   * （sResultCode="2"）相当として扱う。
   * DBから復元したセッションの仮想URLが失効している場合、立花サーバーは
   * JSONエラー応答ではなく素の HTTP 404 を返す（fetchWithDecodeが例外を投げる）ため、
   * 既存の isSessionError 起点の再ログインリトライに乗せるための変換。
   */
  private async fetchWithDecodeOrSessionError(url: string): Promise<TachibanaResponse> {
    try {
      return await this.fetchWithDecode(url);
    } catch (err) {
      if (err instanceof Error && /^HTTP \d+:/.test(err.message)) {
        console.warn(
          `[TachibanaClient] Virtual URL fetch failed (${err.message}), treating as session error`,
        );
        return { sResultCode: "2", sResultText: err.message, sCLMID: "" };
      }
      throw err;
    }
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

      // TODO(temp-debug, v4r10移行調査): 数値キーマッピングがずれていないか確認するため、
      // 変換前の生レスポンスを出力する。原因判明後に削除する。
      // urlそのものはログしない（仮想URLはセッショントークンを含むため）。sCLMIDで種別を識別する。
      // 種別（sCLMID）ごとに最初の1回だけ出力し、CLMMfdsGetMarketPrice 等の高頻度呼び出しで
      // ログが埋まらないようにする。
      const clmidForDebug = String(raw["334"] ?? raw["357"] ?? raw.sCLMID ?? "");
      if (clmidForDebug && !TachibanaClient.loggedDebugClmids.has(clmidForDebug)) {
        TachibanaClient.loggedDebugClmids.add(clmidForDebug);
        console.log(
          `[TachibanaClient][temp-debug] Raw response (numeric keys, pre-mapping, clmid=${clmidForDebug}):`,
          JSON.stringify(
            Object.fromEntries(
              Object.entries(raw).map(([k, v]) => [
                k,
                typeof v === "string" && v.length > 40 ? `${v.slice(0, 40)}…(len=${v.length})` : v,
              ]),
            ),
          ),
        );
      }

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
  clientInstance = null;
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
