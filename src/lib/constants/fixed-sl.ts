/**
 * 固定SL戦略の定義 (KOH-555)
 *
 * GU/PSC/breakout は「ATRトレーリング + 最大3%損切り」で、SL は建値から近く・保有も1-2日。
 * 一方 buyback / panic は **-12% の固定カタストロフ損切り + 20営業日タイムストップ** で動く
 * 「辛抱型ドリフト」戦略で、出口思想が真逆（`.claude/rules/backtest.md`「出口思想はエッジの
 * 性質に合わせる」/ 却下リスト: buyback にタイトATRトレールを当てて勝率56%→21%・PF 0.79 に崩壊）。
 *
 * この違いが2箇所で牙を剥くため、戦略名から「固定SLか」を引けるようにする:
 *
 * 1. `broker-fill-handler.recalculateExitPrices()` が `validateStopLoss()` を無条件に通し、
 *    3%超のSLを一律 -3% にクランプする（`risk-manager.ts` ルール1）。-12% で発注しても
 *    ポジションには -3% が書かれ、ブローカー逆指値も -3% で建つ。パニック底で確実に刈られる。
 * 2. `broker-sl-manager.submitBrokerSL()` の逆指値期限が暦日固定で、20営業日を保有しきれない。
 *
 * ⚠️ 立花の `sOrderExpireDay` は **最大10営業日**（`.claude/rules/tachibana-api.md`）。
 *    20営業日の SL は物理的に1本では張れず、期限内に更新が必ず入る。期限を上限まで延ばすのは
 *    「更新回数を減らして無保護窓とリトライ消費を減らす」ためであって、更新をなくす手段ではない。
 */

/** 固定SL戦略 → タイムストップ日数（営業日）。ここに無い戦略は従来どおりの扱い */
export const FIXED_SL_STRATEGIES: Readonly<Record<string, number>> = {
  /** 自社株買いカタリスト (KOH-502/504)。-12% 固定SL + 20営業日 */
  buyback: 20,
  /** パニック底反発 (KOH-531/554)。-12% 固定SL + 20営業日 */
  panic: 20,
};

/**
 * 固定SL戦略か（= 注文時に指定したSLを約定時に再検証・クランプしてはいけない戦略か）。
 *
 * us_etf は -2% 固定SLだが 3% 未満なのでクランプに掛からず、保有も5営業日で期限内に収まる。
 * 実害が無いためあえて含めない（挙動を変えない）。
 */
export function isFixedSlStrategy(strategy: string): boolean {
  return Object.prototype.hasOwnProperty.call(FIXED_SL_STRATEGIES, strategy);
}

/** 固定SL戦略のタイムストップ日数（営業日）。固定SL戦略でなければ null */
export function getFixedSlTimeStopDays(strategy: string): number | null {
  return FIXED_SL_STRATEGIES[strategy] ?? null;
}
