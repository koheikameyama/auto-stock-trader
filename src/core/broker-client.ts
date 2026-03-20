/**
 * 立花証券 e支店 APIクライアント
 *
 * セッション管理、リクエスト送信、レスポンス変換を担当。
 * シングルトンで使用し、ログイン時に取得する仮想URLを全リクエストで共有する。
 */

import dayjs from "dayjs";
import {
  TACHIBANA_API_URLS,
  TACHIBANA_CLMID,
  TACHIBANA_SESSION,
  type TachibanaEnv,
} from "../lib/constants/broker";
import { mapNumericKeys } from "../lib/tachibana-key-map";

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

    // 金商法のお知らせ未読チェック
    if (raw.sKinsyouhouMidokuFlg === "1") {
      throw new Error(
        "Tachibana login blocked: 金商法のお知らせが未読です。Webで確認してください。",
      );
    }

    this.session = {
      urlRequest: raw.sUrlRequest as string,
      urlMaster: raw.sUrlMaster as string,
      urlPrice: raw.sUrlPrice as string,
      urlEvent: raw.sUrlEvent as string,
      urlEventWebSocket: raw.sUrlEventWebSocket as string,
      loginAt: new Date(),
    };

    console.log(
      `[TachibanaClient] Login successful (${this.env}) at ${this.session.loginAt.toISOString()}`,
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
    const fullParams = {
      ...params,
      p_no: this.nextRequestNo(),
      p_sd_date: this.formatTimestamp(),
    };

    const url = `${virtualUrl}?${this.encodeParams(fullParams)}`;
    return this.fetchWithDecode(url);
  }

  /**
   * REQUEST仮想URLにリクエスト送信（注文・口座系）
   */
  async request(
    params: TachibanaRequestParams,
  ): Promise<TachibanaResponse> {
    this.ensureSession();
    return this.requestToVirtualUrl(this.session!.urlRequest, params);
  }

  /**
   * MASTER仮想URLにリクエスト送信
   */
  async requestMaster(
    params: TachibanaRequestParams,
  ): Promise<TachibanaResponse> {
    this.ensureSession();
    return this.requestToVirtualUrl(this.session!.urlMaster, params);
  }

  /**
   * PRICE仮想URLにリクエスト送信
   */
  async requestPrice(
    params: TachibanaRequestParams,
  ): Promise<TachibanaResponse> {
    this.ensureSession();
    return this.requestToVirtualUrl(this.session!.urlPrice, params);
  }

  // ========================================
  // セッション管理
  // ========================================

  /**
   * 30分ごとに自動再ログインを開始
   */
  startAutoRefresh(): void {
    this.stopAutoRefresh();

    this.refreshTimer = setInterval(async () => {
      try {
        console.log("[TachibanaClient] Auto-refreshing session...");
        await this.login();
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

  // ========================================
  // 内部ユーティリティ
  // ========================================

  private ensureSession(): void {
    if (!this.session) {
      throw new Error(
        "TachibanaClient is not logged in. Call login() first.",
      );
    }
  }

  private nextRequestNo(): string {
    this.requestCounter += 1;
    return String(this.requestCounter);
  }

  private formatTimestamp(): string {
    return dayjs().format("YYYY.MM.DD-HH:mm:ss.SSS");
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
