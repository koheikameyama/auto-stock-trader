/**
 * crisis（キルスイッチ）の発生源コードとラベル。
 *
 * `MarketAssessment.crisisSource` には英語コードを保存する（日本語の合成文字列は保存しない）。
 * 日本語ラベルは表示・Slack 通知時に {@link crisisSourceLabel} で導出する
 * （`exit-reason.ts` と同じ方針。理由は KOH-578）。
 *
 * ## なぜ発生源を区別する必要があるのか（KOH-591）
 *
 * `sentiment="crisis"` は2つの独立したキルスイッチが書くが、**防御決済（全ポジション成行）
 * としての妥当性が正反対**である。判断軸は「守るべきギャップが起きる前に撃てるか」:
 *
 * - `cme_divergence`: CME先物ナイトセッションの乖離 ≤ -3%。**寄付前**に判定できるので、
 *   ギャップダウンが逆指値SLを飛び越えるテールを実際に回避できる。防御決済として筋が通る。
 * - `nikkei_drop`: 日経の前日比 ≤ -3%。ただし market-assessment は 08:02 に
 *   **直近確定セッション**を読む（`getNikkeiLastSessionChange`, 却下 #48 で確定）ため、
 *   実効的に**1営業日遅れ**。暴落日Dは素通しで、**D+1 の朝に全決済する**。
 *   守るべきギャップは前日に終わっており、却下 #48 の実測では N225 暴落翌日は 22/36 で
 *   上昇（平均 +0.61%）＝**リバウンド日に投げることになる**。
 *
 * ⚠️ null は「crisis でない」または本カラム追加(2026-07-29)以前の古いレコードを意味する。
 *   古いレコードに対しては発生源を判定できないため、防御決済側は**発火する側**に倒す
 *   （保護を落とすより余計に売る方が安全側）。
 */

/**
 * crisis 発生源コードの単一ソース（enum 代わりの const オブジェクト）。
 * 書き込み側は生の文字列リテラルでなく必ずこの定数を参照すること（タイポ防止）。
 */
export const CRISIS_SOURCE = {
  /** 日経 ≤ -3%（1営業日遅れ判定。防御決済としては筋が通らない） */
  NIKKEI_DROP: "nikkei_drop",
  /** CME先物ナイトセッション乖離 ≤ -3%（寄付前に撃てる。防御決済として有効） */
  CME_DIVERGENCE: "cme_divergence",
} as const;

export type CrisisSourceCode = (typeof CRISIS_SOURCE)[keyof typeof CRISIS_SOURCE];

const CODE_LABELS: Record<CrisisSourceCode, string> = {
  [CRISIS_SOURCE.NIKKEI_DROP]: "日経急落キルスイッチ",
  [CRISIS_SOURCE.CME_DIVERGENCE]: "CME先物乖離キルスイッチ",
};

const CODE_SET = new Set<string>(Object.values(CRISIS_SOURCE));

/**
 * 防御決済（全ポジション即時成行決済）を発火させてよい発生源。
 *
 * `nikkei_drop` は意図的に**含めない**（1営業日遅れで、守るべきギャップの翌朝に撃つため）。
 * エントリー veto（`shouldTrade=false`）は発生源に関わらず従来どおり効く — 止めているのは
 * 「既存ポジションを投げる」判断だけ。
 */
const DEFENSIVE_EXIT_SOURCES: ReadonlySet<CrisisSourceCode> = new Set([
  CRISIS_SOURCE.CME_DIVERGENCE,
]);

/** 生値（コード / 旧データの null）を正規化する。判定不能なら null */
export function normalizeCrisisSource(raw: string | null | undefined): CrisisSourceCode | null {
  if (!raw) return null;
  if (CODE_SET.has(raw)) return raw as CrisisSourceCode;
  // 旧レコードは reasoning にしか情報が無く crisisSource は null。保険として文言も見る。
  if (/日経平均キルスイッチ|日経急落/.test(raw)) return CRISIS_SOURCE.NIKKEI_DROP;
  if (/CME/.test(raw)) return CRISIS_SOURCE.CME_DIVERGENCE;
  return null;
}

/** 表示・Slack 用の日本語ラベル */
export function crisisSourceLabel(raw: string | null | undefined): string {
  const code = normalizeCrisisSource(raw);
  return code ? CODE_LABELS[code] : "キルスイッチ";
}

/**
 * この発生源の crisis で防御決済（全ポジション成行）を撃ってよいか。
 *
 * @param raw `MarketAssessment.crisisSource`（null 可）
 * @returns true = 撃つ / false = 撃たない（エントリー veto は別途効いている）
 */
export function shouldTriggerDefensiveExit(raw: string | null | undefined): boolean {
  const code = normalizeCrisisSource(raw);
  // 判定不能（古いレコード等）は保護側に倒して撃つ
  if (code === null) return true;
  return DEFENSIVE_EXIT_SOURCES.has(code);
}
