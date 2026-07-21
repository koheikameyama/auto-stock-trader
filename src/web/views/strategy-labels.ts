/**
 * 戦略のフロント表示ラベル（単一の定義元）
 *
 * - gapup → GU
 * - post-surge-consolidation → PSC
 *
 * short: バッジやテーブルセル用の短縮表記
 * full:  ポジションバナー等の補足付き表記
 * badgeClass: styles.ts の .badge-* に対応するクラス名
 */
export const STRATEGY_LABELS: Record<
  string,
  { short: string; full: string; badgeClass: string }
> = {
  breakout: { short: "BO", full: "ブレイクアウト", badgeClass: "badge-breakout" },
  gapup: { short: "GU", full: "GU（ギャップアップ）", badgeClass: "badge-gapup" },
  "post-surge-consolidation": {
    short: "PSC",
    full: "PSC（高騰後押し目）",
    badgeClass: "badge-psc",
  },
  us_etf: { short: "ETF", full: "ETF（米株連動）", badgeClass: "badge-us_etf" },
};

/** バッジ・テーブル用の短縮ラベル（未定義の戦略はキーをそのまま返す） */
export function strategyShortLabel(strategy: string): string {
  return STRATEGY_LABELS[strategy]?.short ?? strategy;
}

/** 補足付きのフルラベル（未定義の戦略はキーをそのまま返す） */
export function strategyFullLabel(strategy: string): string {
  return STRATEGY_LABELS[strategy]?.full ?? strategy;
}

/** バッジ用CSSクラス名（未定義の戦略は badge-${strategy} にフォールバック） */
export function strategyBadgeClass(strategy: string): string {
  return STRATEGY_LABELS[strategy]?.badgeClass ?? `badge-${strategy}`;
}
