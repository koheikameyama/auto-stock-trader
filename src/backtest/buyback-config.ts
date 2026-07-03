/**
 * 自社株買いカタリスト戦略 バックテスト設定 (KOH-502)
 *
 * 設計 (検証: memory/長期 + KOH-502 Phase 0):
 *   - シグナル: TDnet「自己株式取得に係る事項の決定」(新規買付枠の発表) を外部JSONで注入
 *   - エントリー: 開示翌営業日の終値 (開示は多くが引け後) × 日本株 breadth < 54% (idle帯) のみ
 *   - 出口: -12% 固定カタストロフ損切り + 20営業日タイムストップ、トレーリングなし
 *     (buyback は「将来の持続的買い需要」= 辛抱型ドリフト。GU/PSC の ATRトレーリングとは逆の出口思想)
 *   - 株数単位: 100株 (通常株)
 *   - 単独BT: idle帯 PF 2.11 / 期待値 +2.73% / 勝率59% / 8年中8年プラス (コスト0.5%往復)
 *
 * 出口が ETF と同型 (固定SL + タイムストップ) のため USEtfBacktestConfig 型を再利用し、
 * processEtfExits をそのまま流用する (ETF dip も同型再利用の前例あり)。
 * gap/vol/lookback フィールドは buyback では未使用。
 */

import { MARKET_BREADTH } from "../lib/constants/trading";
import type { USEtfBacktestConfig } from "./us-etf-config";

export const BUYBACK_DEFAULT_CONFIG: USEtfBacktestConfig = {
  tickers: [], // 未使用 (シグナルは外部JSONから注入)
  gapMinPct: 0, // 未使用
  volumeSurgeRatio: 0, // 未使用
  volumeLookbackDays: 25, // 未使用
  breadthMax: MARKET_BREADTH.THRESHOLD, // idle帯 (< 54%) のみ発火
  slPct: 0.12, // -12% 固定カタストロフ損切り
  timeStopDays: 20, // 20営業日タイムストップ
  riskPct: 0.02, // リスク2% (12%SLで cash の約16.7% ポジション)
  costModelEnabled: true,
  unitShares: 100, // 通常株は100株単位
};

/** リスク%を百分率(2 = 2%)に変換 */
export const BUYBACK_RISK_PER_TRADE_PCT = BUYBACK_DEFAULT_CONFIG.riskPct * 100;
