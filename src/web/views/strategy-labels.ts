/**
 * 戦略のフロント表示ラベル（単一の定義元）
 *
 * - gapup → GU
 * - post-surge-consolidation → PSC
 *
 * short: バッジやテーブルセル用の短縮表記
 * full:  ポジションバナー等の補足付き表記
 * badgeClass: styles.ts の .badge-* に対応するクラス名
 * color: 戦略の識別色（全ページ共通。ここが色の唯一の定義元）
 * bg:    バッジ背景色（color の薄い版）
 */
export const STRATEGY_LABELS: Record<
  string,
  { short: string; full: string; badgeClass: string; color: string; bg: string }
> = {
  breakout: {
    short: "BO",
    full: "ブレイクアウト",
    badgeClass: "badge-breakout",
    color: "#3b82f6",
    bg: "rgba(59,130,246,0.15)",
  },
  gapup: {
    short: "GU",
    full: "GU（ギャップアップ）",
    badgeClass: "badge-gapup",
    color: "#a855f7",
    bg: "rgba(168,85,247,0.15)",
  },
  "post-surge-consolidation": {
    short: "PSC",
    full: "PSC（高騰後押し目）",
    badgeClass: "badge-psc",
    color: "#fb923c",
    bg: "rgba(251,146,60,0.15)",
  },
  us_etf: {
    short: "ETF",
    full: "ETF（米株連動）",
    badgeClass: "badge-us_etf",
    color: "#0ea5e9",
    bg: "rgba(14,165,233,0.15)",
  },
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

/** 戦略の識別色（全ページ共通。未定義はミュート色にフォールバック） */
export function strategyColor(strategy: string): string {
  return STRATEGY_LABELS[strategy]?.color ?? "#94a3b8";
}
