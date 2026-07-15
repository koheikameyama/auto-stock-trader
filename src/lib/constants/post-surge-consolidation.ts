/**
 * 高騰後押し目戦略（Post-Surge Consolidation）の定数
 */
export const POST_SURGE_CONSOLIDATION = {
  ENTRY: {
    /** 急騰フィルター: 直近20日リターン閾値 */
    MOMENTUM_LOOKBACK_DAYS: 20,
    MOMENTUM_MIN_RETURN: 0.15,       // +15%
    /** 高値圏維持: 高値からの最大乖離 */
    MAX_HIGH_DISTANCE_PCT: 0.05,     // 高値から-5%以内
    /** 再加速: 出来高サージ倍率 */
    VOL_SURGE_RATIO: 1.5,
    MIN_AVG_VOLUME_25: 100_000,
    MIN_ATR_PCT: 1.5,
  },
  /** ウォッチリスト「監視中」表示の緩和閾値（過去データ起因の構造のみで判定） */
  WATCHING: {
    MOMENTUM_MIN_RETURN: 0.10,       // +10%（厳密 +15% から -5pt）
    MAX_HIGH_DISTANCE_PCT: 0.10,     // 高値から-10%以内（厳密 -5% から +5pt）
  },
  STOP_LOSS: {
    ATR_MULTIPLIER: 0.8,
  },
  /** ブレイクイーブンストップ（WF最適値） */
  BREAK_EVEN: {
    ACTIVATION_ATR_MULTIPLIER: 0.3,
  },
  /** トレーリングストップ（WF最適値）
   *
   * 2026-07-15 (KOH-552) に 0.5 → 0.3。KOH-548 で exit-checker のイントラバー先読みを
   * 直した（トレール決済を「その日の始値」で約定させていた）結果、順位が入れ替わった。
   * 先読みはタイトなトレールほど不利に働くため、旧エンジンは 0.3 を不当に低く評価していた。
   *   WF固定比較(7窓 OOS集計PF): 0.5 → 2.26 / 0.3 → 2.58 (+14%)、勝率 39.4% → 44.2%
   *   WF窓別: 0.3 が 5/7 窓で IS最適、判定 堅牢✓ (IS/OOS 1.23)
   *   combined 単発BT(2024-03〜, ¥500K): Calmar 22.98 → 32.04
   *
   * 副次: trail == BE.ACTIVATION_ATR_MULTIPLIER (0.3) になったため、建値フロアが
   * 数学的に無意味になった（発動時点のトレール = maxHigh - 0.3ATR = 建値ちょうどで、
   * 以降は建値より上を走るためクランプが一度も効かない）。この2値を別々に動かす際は
   * フロアの意味が復活する点に注意。
   */
  TRAILING: {
    TRAIL_ATR_MULTIPLIER: 0.3,
  },
  TIME_STOP: {
    MAX_HOLDING_DAYS: 5,
    MAX_EXTENDED_HOLDING_DAYS: 7,
  },
  ENTRY_ENABLED: true,
} as const;
