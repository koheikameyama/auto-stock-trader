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
import { notifyBrokerError } from "../lib/slack";
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
  /** ログインロック検出時刻（nullなら正常） */
  private loginLockedUntil: Date | null = null;
  /** ログインロックのSlack通知済みフラグ（重複通知防止） */
  private loginLockNotified = false;
  /** ログインロック時のクールダウン（30分） */
  private static readonly LOGIN_LOCK_COOLDOWN_MS = 30 * 60 * 1000;
  /**
   * リクエストのシリアライズ用ミューテックス
   * p_no採番〜HTTPレスポンス受信までをアトミックにし、
   * 複数ジョブからの並行呼び出しによるp_no順序エラーを防ぐ。
   */
  private requestMutex: Promise<void> = Promise.resolve();

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
    const configForLockCheck = await prisma.tradingConfig.findFirst({
      orderBy: { createdAt: "desc" },
      select: { loginLockedUntil: true },
    });
    const dbLockedUntil = configForLockCheck?.loginLockedUntil ?? null;
    if (dbLockedUntil && new Date() < dbLockedUntil) {
      this.loginLockedUntil = dbLockedUntil;
      throw new Error(
        `Tachibana login is locked until ${dbLockedUntil.toISOString()}. Call the support center to unlock.`,
      );
    }

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
    if (orderResultCode === "10033") {
      const lockedUntil = new Date(Date.now() + TachibanaClient.LOGIN_LOCK_COOLDOWN_MS);
      this.loginLockedUntil = lockedUntil;
      const errorMsg = (raw.sOrderResultText as string) || "アカウントがロックされています";
      console.error(`[TachibanaClient] Account locked: ${errorMsg}`);

      // DBに永続化
      const configToUpdate = await prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } });
      if (configToUpdate) {
        await prisma.tradingConfig.update({
          where: { id: configToUpdate.id },
          data: { loginLockedUntil: lockedUntil, loginLockReason: errorMsg },
        });
      }

      if (!this.loginLockNotified) {
        this.loginLockNotified = true;
        notifyBrokerError(
          "アカウントロック",
          `立花証券のログインがロックされました。\n📞 サポートセンター: 03-3669-0777 ／ 電話認証: 050-3102-6575\n\nエラー: ${errorMsg}`,
        ).catch(() => {});
      }

      throw new Error(`Tachibana account locked: ${errorMsg}`);
    }

    // ログインロック解除（正常ログイン成功時）
    this.loginLockedUntil = null;
    this.loginLockNotified = false;

    // DBもクリア
    const configToClear = await prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } });
    if (configToClear) {
      await prisma.tradingConfig.update({
        where: { id: configToClear.id },
        data: { loginLockedUntil: null, loginLockReason: null },
      });
    }

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
      const res = await this.fetchWithDecode(url);

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
    const res = await this.fetchWithDecode(url);

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
  // 内部ユーティリティ
  // ========================================

  /**
   * セッション切断エラーかどうか判定
   */
  private isSessionError(res: TachibanaResponse): boolean {
    return res.sResultCode === "2";
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
    if (!this.session) {
      await this.login();
    }
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
