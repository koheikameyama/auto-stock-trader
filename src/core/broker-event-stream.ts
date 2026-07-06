/**
 * 立花証券 EVENT I/F WebSocket クライアント
 *
 * ログイン時に取得した sUrlEventWebSocket（wss://）に接続し、
 * 約定通知（EC）やキープアライブ（KP）をリアルタイムで受信する。
 *
 * メッセージ形式: ペア間は \x01（SOH）区切り、キーと値の間は \x02（STX）区切り
 * 例: "p_no\x021\x01p_date\x022026.07.06-17:44:11.367\x01p_cmd\x02KP\x01"
 * （2026-07-06 デモ実測 + go-tachibanaapi 実装で確認。旧実装は「\x01 区切りでキー・値が
 *   交互」と誤解釈しており、p_cmd が一切取れず全メッセージを破棄 → KP タイマーが
 *   リセットされず30秒毎に再接続ループ + EC 約定通知の全取りこぼしが起きていた, KOH-528）
 */

import { EventEmitter } from "events";
import WebSocket from "ws";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import tz from "dayjs/plugin/timezone.js";
import { isMarketDay } from "../lib/market-date";
import { TIMEZONE } from "../lib/constants";
import { BROKER_WS_HOURS } from "../lib/constants/broker";

dayjs.extend(utc);
dayjs.extend(tz);

// ========================================
// 定数
// ========================================

/** EVENT I/F のデフォルトサブスクリプション */
const DEFAULT_EVENT_TYPES = ["ST", "KP", "EC", "SS", "US"];

/**
 * KP（キープアライブ）タイムアウト（ms）— この時間 KP/メッセージが途切れたら再接続。
 *
 * 立花の KP 送信間隔は 5秒（2026-07-06 デモ実測。旧記載の15秒は誤り）。
 * タイムアウト30秒 = KP 5〜6回分の無音を許容してから再接続する。
 * heartbeat == timeout アンチパターン（ジッタで誤再接続が頻発）を避けつつ、
 * 真の切断は30秒以内に検知でき、再接続 churn による EC 取りこぼしを防ぐ。
 */
const KP_TIMEOUT_MS = 30_000;

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
// 営業時間判定
// ========================================

/**
 * 現在がWebSocket接続を許可する時間帯かどうかを判定
 *
 * 条件: 東証営業日 かつ JST 07:00〜18:00
 */
export function isBrokerConnectionWindow(now?: Date): boolean {
  const d = dayjs(now).tz(TIMEZONE);
  const hour = d.hour();

  if (!isMarketDay(now)) return false;
  if (hour < BROKER_WS_HOURS.START_HOUR || hour >= BROKER_WS_HOURS.END_HOUR) {
    return false;
  }

  return true;
}

/**
 * 次の接続ウィンドウ開始までのミリ秒を計算
 */
export function msUntilNextConnectionWindow(now?: Date): number {
  const d = dayjs(now).tz(TIMEZONE);
  const hour = d.hour();

  // 今日の営業日でまだ START_HOUR 前 → 今日の START_HOUR まで
  if (isMarketDay(now) && hour < BROKER_WS_HOURS.START_HOUR) {
    const target = d.hour(BROKER_WS_HOURS.START_HOUR).minute(0).second(0).millisecond(0);
    return target.diff(d);
  }

  // それ以外 → 翌営業日の START_HOUR まで探索
  let check = d.add(1, "day").hour(BROKER_WS_HOURS.START_HOUR).minute(0).second(0).millisecond(0);
  for (let i = 0; i < 10; i++) {
    if (isMarketDay(check.toDate())) {
      return check.diff(d);
    }
    check = check.add(1, "day");
  }

  // フォールバック: 1時間後に再チェック
  return 60 * 60 * 1000;
}

// ========================================
// メッセージパーサー
// ========================================

/**
 * EVENT I/F メッセージをパースしてフィールドマップにする
 *
 * ペア間は \x01（SOH）、キーと値の間は \x02（STX）で区切られる。
 * 例: "p_no\x021\x01p_cmd\x02KP\x01" → { p_no: "1", p_cmd: "KP" }
 */
export function parseEventMessage(
  message: string,
): Record<string, string> {
  const fields: Record<string, string> = {};

  for (const pair of message.split("\x01")) {
    if (!pair) continue;
    const sep = pair.indexOf("\x02");
    if (sep === -1) {
      // 値なし（キーのみ）のペア
      const key = pair.trim();
      if (key) fields[key] = "";
      continue;
    }
    const key = pair.slice(0, sep).trim();
    if (key) fields[key] = pair.slice(sep + 1);
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
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.clearWindowTimer();
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

    // 営業時間外は接続しない — 次のウィンドウ開始時に自動再接続
    if (!isBrokerConnectionWindow()) {
      this.scheduleWindowOpen();
      return;
    }

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
      if (err.message.includes("503")) {
        console.warn("[BrokerEventStream] Server unavailable (503)");
      } else {
        console.error("[BrokerEventStream] WebSocket error:", err.message);
      }
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
    // どんなメッセージでも「受信できた」こと自体が接続の生存証明。
    // パース結果に依らず先にタイマーをリセットする（パース不能メッセージで
    // タイマーが放置され誤再接続する事故を防ぐ）。
    this.resetKpTimer();

    const fields = parseEventMessage(message);
    const cmd = fields.p_cmd;

    if (!cmd) {
      console.warn(
        `[BrokerEventStream] p_cmd なしメッセージ: ${JSON.stringify(message.slice(0, 200))}`,
      );
      return;
    }

    // サーバー側エラー通知（例: p_errno=2, p_err="session inactive."）
    if (fields.p_errno && fields.p_errno !== "0") {
      console.warn(
        `[BrokerEventStream] Server error: errno=${fields.p_errno} err=${fields.p_err ?? ""} (cmd=${cmd})`,
      );
      this.emit("serverError", { errno: fields.p_errno, message: fields.p_err ?? "", cmd });
    }

    switch (cmd) {
      case "KP":
        this.emit("keepalive");
        break;

      case "EC":
        this.handleExecutionEvent(fields);
        break;

      case "ST":
      case "SS":
      case "US":
        console.log(
          `[BrokerEventStream] ${cmd} message:`,
          JSON.stringify(fields),
        );
        this.emit("status", { type: cmd, fields });
        break;

      default:
        break;
    }
  }

  private handleExecutionEvent(fields: Record<string, string>): void {
    // v4r9 EVENT I/F の EC 通知フィールド: p_ON=注文番号, p_ED=営業日(YYYYMMDD)
    const orderNumber = fields.p_ON ?? "";
    const businessDay = fields.p_ED ?? "";

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

    // 営業時間外ならウィンドウ開始まで待機
    if (!isBrokerConnectionWindow()) {
      this.scheduleWindowOpen();
      return;
    }

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

  /**
   * 次の営業時間ウィンドウ開始時に自動接続をスケジュール
   */
  private scheduleWindowOpen(): void {
    if (this.intentionalClose || !this.wsUrl) return;

    this.clearWindowTimer();
    const waitMs = msUntilNextConnectionWindow();
    const waitMin = Math.round(waitMs / 60_000);

    console.log(
      `[BrokerEventStream] Outside connection window — waiting ${waitMin}min until next window`,
    );

    this.windowTimer = setTimeout(() => {
      this.windowTimer = null;
      if (!this.intentionalClose && this.wsUrl) {
        this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        this.doConnect();
      }
    }, waitMs);
  }

  private clearWindowTimer(): void {
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
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
