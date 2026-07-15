/**
 * パニック底反発戦略の定数 (KOH-531 検証 / KOH-554 本番化)
 *
 * VIX(前日終値) > 25 × breadth < 40% × N225連続下落≥3日（エピソード初日のみ）で
 * 1321（日経225ETF）を当日引け成行買い。-12% 固定カタストロフ損切り + 20営業日タイムストップ。
 *
 * 「価格由来だが発火が市況と逆相関」という唯一の戦略で、①fullcycle改善 ②D期無傷
 * ③buyback非競合 を同時に満たす（`.claude/rules/backtest.md`「事例: パニック底反発戦略の検証」）。
 *
 * ⚠️ 出口思想は GU/PSC と真逆。トレーリングを当ててはいけない（辛抱型ドリフトを殺す。
 *    却下リスト: buyback にタイトATRトレールを当てて勝率56%→21%・PF 0.79 に崩壊）。
 *    position-monitor の汎用出口ループと防御決済の両方から除外している。
 *
 * ⚠️ **判定はすべて前営業日の確定終値**で行う。本番 15:24 時点で当日の breadth は存在せず
 *    （全3,000銘柄のライブ時価が要り立花の負荷ルールに反する）、BT 側もこの1営業日ラグを
 *    織り込んだ定義（`_gen-panic-events.ts --entry-lag 1`）で検証済み。
 */

export const PANIC = {
  /** TradingPosition.strategy / TradingOrder.strategy に入る識別子 */
  STRATEGY: "panic",

  /**
   * 日経225ETF。指数ETFは DB 上 `.T` 無しで保存される（通常銘柄は `1301.T`）。
   * `.T` を付けるとユニバース0件になり原因が分かりにくい（_gen-panic-events.ts:10 が踏んだ罠）。
   */
  TICKER: "1321",

  /** VIX(前日終値) がこれを超える（排他: > 25）。D期の浅い押し目を弾くレジーム選別器 */
  VIX_MIN: 25,

  /**
   * breadth がこれ未満（排他: < 40%）。
   * MARKET_BREADTH.THRESHOLD(54%) は「GU/PSC の稼働境界」で別物なので流用しない。
   */
  BREADTH_MAX: 0.4,

  /** N225 の連続下落営業日数がこれ以上（>= 3） */
  MIN_DOWN_STREAK: 3,

  /** -12% 固定カタストロフ損切り（トレーリングなし） */
  SL_PCT: 0.12,

  /** 20営業日タイムストップ。出口スイープで TS20 が最良と確定済（TS7 は単独BT最良でも共有プールで最下位） */
  TIME_STOP_DAYS: 20,

  /** 1トレードのリスク%（cash に対する）。-12%SL なので cash の約16.7%のポジションになる */
  RISK_PCT: 0.02,

  /** 同時保有上限。発火が疎（年2回未満）なこと自体が選別性なので枠を増やさない */
  MAX_POSITIONS: 1,

  /**
   * 新規エントリー許可。`PANIC_ENTRY_ENABLED=false` で即停止できる（Exit は常に動く）。
   * `||` で空文字も fallback 対象にする（未設定 secret は "" になるため。BUYBACK.OBSERVE_ONLY と同じ書式）。
   */
  ENTRY_ENABLED: (process.env.PANIC_ENTRY_ENABLED || "true") !== "false",

  /** 発注に使う資金。未設定なら ¥500K（BT の検証予算と同じ） */
  BUDGET: parseInt(process.env.PANIC_TRADING_BUDGET || "500000", 10),
} as const;
