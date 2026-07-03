/**
 * 自社株買いカタリスト戦略の定数 (KOH-502 / KOH-504)
 *
 * TDnet「自己株式取得に係る事項の決定」を idle帯(breadth<54%)で捕捉し、
 * 開示翌営業日引けエントリー、-12%固定SL + 20営業日タイムストップ。
 * 検証: 単独8年8勝(idle帯 PF 2.11)。詳細は .claude/rules/backtest.md。
 */

export const BUYBACK = {
  /** やのしんTDnet WEB-API ベースURL(非公式・無料) */
  YANOSHIN_BASE: "https://webapi.yanoshin.jp/webapi/tdnet",
  /** -12% 固定カタストロフ損切り */
  SL_PCT: 0.12,
  /** 20営業日タイムストップ */
  TIME_STOP_DAYS: 20,
  /** 1トレードあたりリスク% */
  RISK_PCT: 0.02,
  /** 100株単位(通常株) */
  UNIT_SHARES: 100,
  /**
   * Phase A: 観察モード(発注しない)。Phase B で false に切り替えて実弾発注。
   * 環境変数 BUYBACK_OBSERVE_ONLY=false で上書き可。
   */
  OBSERVE_ONLY: (process.env.BUYBACK_OBSERVE_ONLY || "true") !== "false",
  /** 開示がこの時刻(JST hour)以降なら翌営業日エントリー(引け後開示) */
  POST_CLOSE_HOUR: 15,
} as const;

/**
 * 「自己株式取得に係る事項の決定」= 新規買付枠の発表(強気)のみを拾い、
 * 処分(RSU報酬)/消却/無償取得/進捗報告/訂正 を除外するキーワード判定。
 * KOH-502 の Python classify を移植。
 */
export function classifyBuybackTitle(title: string): "buyback_decision" | null {
  const t = title ?? "";
  if (t.includes("訂正")) return null;
  // 除外(処分=RSU報酬 / 消却 / 無償取得 / 進捗・結果報告 / 終了)
  if (/処分|消却|無償|取得状況|取得結果|終了/.test(t)) return null;
  if (t.includes("自己株式取得に係る事項の決定")) return "buyback_decision";
  return null;
}

/** やのしんの company_code(5桁: 4桁+パディング) → 4桁に normalize。"31340"→"3134", "339A0"→"339A" */
export function normalizeBuybackCode(raw: string): string {
  return (raw ?? "").slice(0, 4);
}
