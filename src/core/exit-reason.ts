/**
 * 決済理由（exit reason）のコード体系とラベル。
 *
 * `exitSnapshot.exitReason` には英語コードを保存する（日本語の合成文字列は保存しない）。
 * 日本語ラベルは表示・Slack 通知時に {@link exitReasonLabel} で導出する。
 *
 * ⚠️ 旧データ（2026-07 以前にクローズしたポジション）は日本語の合成文字列
 *   （例: "SL約定（ブローカー自律執行）" / "トレーリング建値撤退" /
 *    "crisis（日経/CMEキルスイッチ） 全ポジション即時決済（含み損益: -0.88%）"）で
 * 保存されているため、本モジュールの関数はコード・旧日本語の両方を受け付けて正規化する。
 */

/**
 * 決済理由コードの単一ソース（enum 代わりの const オブジェクト）。
 * 書き込み側は生の文字列リテラルでなく必ずこの定数を参照すること（タイポ防止）。
 */
export const EXIT_REASON = {
  TAKE_PROFIT: "take_profit",
  STOP_LOSS: "stop_loss",
  TRAILING_PROFIT: "trailing_profit",
  TRAILING_STOP: "trailing_stop",
  TIME_STOP: "time_stop",
  CRISIS: "crisis",
  EARNINGS: "earnings",
  SUPERVISION: "supervision",
} as const;

export type ExitReasonCode = (typeof EXIT_REASON)[keyof typeof EXIT_REASON];

/** コード → 日本語ラベル（position-monitor 旧 EXIT_REASON_LABELS と一致させ Slack 文言を不変に保つ） */
const CODE_LABELS: Record<ExitReasonCode, string> = {
  [EXIT_REASON.TAKE_PROFIT]: "利確",
  [EXIT_REASON.STOP_LOSS]: "損切り",
  [EXIT_REASON.TRAILING_PROFIT]: "トレーリング利確",
  [EXIT_REASON.TRAILING_STOP]: "トレーリング建値撤退",
  [EXIT_REASON.TIME_STOP]: "タイムストップ",
  [EXIT_REASON.CRISIS]: "防御決済（キルスイッチ）",
  [EXIT_REASON.EARNINGS]: "決算前強制決済",
  [EXIT_REASON.SUPERVISION]: "監理・整理強制売却",
};

const CODE_SET = new Set<string>(Object.values(EXIT_REASON));

/** 決済後に上がると「早く切りすぎ」の兆候になる守りの決済 */
const DEFENSIVE_CODES: ReadonlySet<ExitReasonCode> = new Set([
  EXIT_REASON.STOP_LOSS,
  EXIT_REASON.TRAILING_STOP,
  EXIT_REASON.TIME_STOP,
  EXIT_REASON.CRISIS,
]);

export interface ExitReasonInfo {
  /** 正準コード。分類不能な旧文字列は "other" */
  code: ExitReasonCode | "other";
  /** 表示・Slack 用の日本語ラベル */
  label: string;
  /** 守りの決済か（損切り・BE撤退・タイム・防御） */
  defensive: boolean;
}

/**
 * 生の exitReason（コード or 旧日本語ラベル）を正準バケットに正規化する。
 * 集計・分類・表示の単一ソース。
 */
export function classifyExitReason(raw: string | null | undefined): ExitReasonInfo {
  const r = raw ?? "";

  // 1) 既知コードそのもの
  if (CODE_SET.has(r)) {
    const code = r as ExitReasonCode;
    return { code, label: CODE_LABELS[code], defensive: DEFENSIVE_CODES.has(code) };
  }

  // 2) 旧日本語ラベル（合成文字列・損益埋め込み含む）を部分一致で束ねる
  let code: ExitReasonCode | "other";
  if (/建値撤退|break.?even/i.test(r)) code = "trailing_stop";
  else if (/トレーリング利確|トレール利確/i.test(r)) code = "trailing_profit";
  else if (/crisis|キルスイッチ|防御|全ポジション即時決済/i.test(r)) code = "crisis";
  else if (/決算前強制決済|決算まで/i.test(r)) code = "earnings";
  else if (/監理|整理/i.test(r)) code = "supervision";
  else if (/タイムストップ/i.test(r)) code = "time_stop";
  else if (/SL約定|SL|損切/i.test(r)) code = "stop_loss";
  else if (/利確/i.test(r)) code = "take_profit";
  else code = "other";

  const label = code === "other" ? (r || "不明") : CODE_LABELS[code];
  const defensive = code !== "other" && DEFENSIVE_CODES.has(code);
  return { code, label, defensive };
}

/** 表示・Slack 用の日本語ラベル。コードでも旧日本語でも受け付ける。 */
export function exitReasonLabel(raw: string | null | undefined): string {
  return classifyExitReason(raw).label;
}

/** 守りの決済か（損切り・BE撤退・タイム・防御）。コードでも旧日本語でも受け付ける。 */
export function isDefensiveExit(raw: string | null | undefined): boolean {
  return classifyExitReason(raw).defensive;
}
