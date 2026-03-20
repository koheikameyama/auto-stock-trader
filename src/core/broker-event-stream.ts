/**
 * 立花証券 EVENT I/F WebSocket クライアント
 *
 * ログイン時に取得した sUrlEventWebSocket（wss://）に接続し、
 * 約定通知（EC）やキープアライブ（KP）をリアルタイムで受信する。
 *
 * メッセージ形式: \x01（SOH）区切りのキー・バリューペア
 * 例: "p_no\x011\x01p_date\x012026.03.20-10:00:00.000\x01p_cmd\x01KP"
 */

import { EventEmitter } from "events";
import WebSocket from "ws";

// ========================================
// 定数
// ========================================

/** EVENT I/F のデフォルトサブスクリプション */
const DEFAULT_EVENT_TYPES = ["ST", "KP", "EC", "SS", "US"];

/** KP（キープアライブ）タイムアウト（ms）— 15秒以上 KP がなければ再接続 */
const KP_TIMEOUT_MS = 15_000;

/** 再接続の最大リトライ間隔（ms） */
const MAX_RECONNECT_DELAY_MS = 30_000;

/** 再接続の初期リトライ間隔（ms） */
const INITIAL_RECONNECT_DELAY_MS = 1_000;

/** EVENT I/F 接続パラメータ */
const EVENT_PARAMS = {
  p_rid: "22",
  p_board_no: "1000",
  p_eno: "0",
} as const;

// ========================================
// 型定義
// ========================================

export interface BrokerEventStreamOptions {
  /** 購読するイベント種別（デフォルト: ["ST", "KP", "EC", "SS", "US"]） */
  eventTypes?: string[];
}

export interface ExecutionEvent {
  /** 注文番号 */
  orderNumber: string;
  /** 営業日 (YYYYMMDD) */
  businessDay: string;
  /** パースされた全フィールド */
  raw: Record<string, string>;
}

// ========================================
// メッセージパーサー
// ========================================

/**
 * \x01 区切りメッセージをパースしてフィールドマップにする
 *
 * 例: "p_no\x011\x01p_cmd\x01KP" → { p_no: "1", p_cmd: "KP" }
 */
export function parseEventMessage(
  message: string,
): Record<string, string> {
  const fields: Record<string, string> = {};
  const parts = message.split("\x01");

  for (let i = 0; i < parts.length - 1; i += 2) {
    const key = parts[i]!.trim();
    const value = parts[i + 1] ?? "";
    if (key) fields[key] = value;
  }

  return fields;
}

// ========================================
// BrokerEventStream
// ========================================

export class BrokerEventStream extends EventEmitter {
  private ws: WebSocket | null = null;
  private wsUrl: string | null = null;
  private options: BrokerEventStreamOptions = {};
  private kpTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private intentionalClose = false;

  /**
   * WebSocket 接続を開始する
   */
  connect(wsUrl: string, options?: BrokerEventStreamOptions): void {
    this.wsUrl = wsUrl;
    this.options = options ?? {};
    this.intentionalClose = false;
    this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    this.doConnect();
  }

  /**
   * セッション更新時に新しいURLで再接続
   */
  reconnect(newWsUrl: string): void {
    this.wsUrl = newWsUrl;
    this.intentionalClose = true;
    this.closeWs();
    this.intentionalClose = false;
    this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    this.doConnect();
  }

  /**
   * 接続を切断する
   */
  disconnect(): void {
    this.intentionalClose = true;
    this.clearKpTimer();
    this.closeWs();
    this.wsUrl = null;
  }

  /**
   * 接続中かどうか
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ========================================
  // 内部実装
  // ========================================

  private doConnect(): void {
    if (!this.wsUrl) return;

    const eventTypes =
      this.options.eventTypes ?? DEFAULT_EVENT_TYPES;
    const queryParams = new URLSearchParams({
      ...EVENT_PARAMS,
      p_evt_cmd: eventTypes.join(","),
    });

    const fullUrl = `${this.wsUrl}?${queryParams.toString()}`;

    try {
      this.ws = new WebSocket(fullUrl);
    } catch (err) {
      this.emit("error", err);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      console.log("[BrokerEventStream] Connected");
      this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      this.resetKpTimer();
      this.emit("connected");
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const message =
          data instanceof Buffer
            ? data.toString("utf-8")
            : String(data);
        this.handleMessage(message);
      } catch (err) {
        this.emit("error", err);
      }
    });

    this.ws.on("error", (err: Error) => {
      console.error("[BrokerEventStream] WebSocket error:", err.message);
      this.emit("error", err);
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      console.log(
        `[BrokerEventStream] Disconnected (code=${code}, reason=${reason.toString()})`,
      );
      this.clearKpTimer();
      this.emit("disconnected", code);

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });
  }

  private handleMessage(message: string): void {
    const fields = parseEventMessage(message);
    const cmd = fields.p_cmd;

    if (!cmd) return;

    switch (cmd) {
      case "KP":
        this.resetKpTimer();
        this.emit("keepalive");
        break;

      case "EC":
        this.resetKpTimer();
        this.handleExecutionEvent(fields);
        break;

      case "ST":
      case "SS":
      case "US":
        this.resetKpTimer();
        this.emit("status", { type: cmd, fields });
        break;

      default:
        this.resetKpTimer();
        break;
    }
  }

  private handleExecutionEvent(fields: Record<string, string>): void {
    const orderNumber = fields.p_order_number ?? fields.sOrderNumber ?? "";
    const businessDay = fields.p_eigyou_day ?? fields.sEigyouDay ?? "";

    if (!orderNumber) {
      console.warn(
        "[BrokerEventStream] EC event without order number:",
        fields,
      );
      return;
    }

    const event: ExecutionEvent = {
      orderNumber,
      businessDay,
      raw: fields,
    };

    console.log(
      `[BrokerEventStream] Execution event: order=${orderNumber}, day=${businessDay}`,
    );
    this.emit("execution", event);
  }

  private resetKpTimer(): void {
    this.clearKpTimer();
    this.kpTimer = setTimeout(() => {
      console.warn(
        "[BrokerEventStream] KP timeout — reconnecting...",
      );
      this.closeWs();
      this.doConnect();
    }, KP_TIMEOUT_MS);
  }

  private clearKpTimer(): void {
    if (this.kpTimer) {
      clearTimeout(this.kpTimer);
      this.kpTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || !this.wsUrl) return;

    console.log(
      `[BrokerEventStream] Reconnecting in ${this.reconnectDelay}ms...`,
    );

    setTimeout(() => {
      if (!this.intentionalClose && this.wsUrl) {
        this.doConnect();
      }
    }, this.reconnectDelay);

    // 指数バックオフ
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      MAX_RECONNECT_DELAY_MS,
    );
  }

  private closeWs(): void {
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        // ignore close errors
      }
      this.ws = null;
    }
  }
}

// ========================================
// シングルトン
// ========================================

let streamInstance: BrokerEventStream | null = null;

/**
 * BrokerEventStream のシングルトンインスタンスを取得
 */
export function getBrokerEventStream(): BrokerEventStream {
  if (!streamInstance) {
    streamInstance = new BrokerEventStream();
  }
  return streamInstance;
}

/**
 * シングルトンインスタンスをリセット（テスト用）
 */
export function resetBrokerEventStream(): void {
  if (streamInstance) {
    streamInstance.disconnect();
    streamInstance = null;
  }
}
