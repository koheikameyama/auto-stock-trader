/**
 * 銘柄の安全性ルール（強制補正の条件判定）
 *
 * おすすめ分析・購入判断の両方で共通して使う。
 * 条件判定のみを提供し、アクション（除外 or stay変更）は呼び出し側に委ねる。
 */
import { MA_DEVIATION, MOMENTUM, TIMING_INDICATORS, TECHNICAL_BRAKE, GAP_UP_MOMENTUM, MARKET_DEFENSIVE_MODE, EARNINGS_SAFETY, AVOID_ESCALATION, GEOPOLITICAL_RISK, GEOPOLITICAL_DEFENSIVE_MODE } from "@/lib/constants";

/** 高ボラティリティの閾値（%） */
const HIGH_VOLATILITY_THRESHOLD = 50;

/** 急騰銘柄か（投資スタイル別の閾値で判定） */
export function isSurgeStock(
  weekChangeRate: number | null,
  investmentStyle?: string | null,
): boolean {
  if (weekChangeRate === null) return false;
  const threshold = getSurgeThreshold(investmentStyle);
  if (threshold === null) return false; // アクティブ型は制限なし
  return weekChangeRate >= threshold;
}

/** 投資スタイルに応じた急騰閾値を取得 */
function getSurgeThreshold(investmentStyle?: string | null): number | null {
  switch (investmentStyle) {
    case "CONSERVATIVE":
      return MOMENTUM.CONSERVATIVE_SURGE_THRESHOLD;
    case "BALANCED":
      return MOMENTUM.BALANCED_SURGE_THRESHOLD;
    case "AGGRESSIVE":
      return MOMENTUM.AGGRESSIVE_SURGE_THRESHOLD;
    default:
      return MOMENTUM.DEFAULT_SURGE_THRESHOLD;
  }
}

/** 危険銘柄か（赤字 かつ 高ボラティリティ） */
export function isDangerousStock(
  isProfitable: boolean | null,
  volatility: number | null,
): boolean {
  return (
    isProfitable === false &&
    volatility !== null &&
    volatility > HIGH_VOLATILITY_THRESHOLD
  );
}

/** 赤字×急騰銘柄か（赤字企業が急騰している場合、仕手株やバブルの可能性が高い） */
export function isUnprofitableSurge(
  isProfitable: boolean | null,
  weekChangeRate: number | null,
): boolean {
  return (
    isProfitable === false &&
    weekChangeRate !== null &&
    weekChangeRate >= MOMENTUM.UNPROFITABLE_SURGE_THRESHOLD
  );
}

/** 過熱圏か（移動平均乖離率+20%以上、アクティブ型はスキップ） */
export function isOverheated(
  deviationRate: number | null,
  investmentStyle?: string | null,
): boolean {
  if (investmentStyle === "AGGRESSIVE" && MOMENTUM.AGGRESSIVE_SKIP_OVERHEAT)
    return false;
  return (
    deviationRate !== null && deviationRate >= MA_DEVIATION.UPPER_THRESHOLD
  );
}

/** 下落トレンドか（投資スタイル別の閾値で判定） */
export function isInDecline(
  weekChangeRate: number | null,
  investmentStyle?: string | null,
): boolean {
  if (weekChangeRate === null) return false;
  const threshold = getDeclineThreshold(investmentStyle);
  return weekChangeRate <= threshold;
}

/** 投資スタイルに応じた下落閾値を取得 */
function getDeclineThreshold(investmentStyle?: string | null): number {
  switch (investmentStyle) {
    case "CONSERVATIVE":
      return MOMENTUM.CONSERVATIVE_DECLINE_THRESHOLD;
    case "BALANCED":
      return MOMENTUM.BALANCED_DECLINE_THRESHOLD;
    case "AGGRESSIVE":
      return MOMENTUM.AGGRESSIVE_DECLINE_THRESHOLD;
    default:
      return MOMENTUM.DEFAULT_DECLINE_THRESHOLD;
  }
}

/** 投資スタイルに応じたギャップアップ急騰閾値を取得 */
export function getGapUpSurgeThreshold(investmentStyle?: string | null): number {
  switch (investmentStyle) {
    case "CONSERVATIVE":
      return TIMING_INDICATORS.GAP_UP_SURGE_CONSERVATIVE;
    case "BALANCED":
      return TIMING_INDICATORS.GAP_UP_SURGE_BALANCED;
    case "AGGRESSIVE":
      return TIMING_INDICATORS.GAP_UP_SURGE_AGGRESSIVE;
    default:
      return TIMING_INDICATORS.GAP_UP_SURGE_THRESHOLD;
  }
}

/**
 * ギャップアップモメンタム判定（アクティブ型向け）
 * 小幅ギャップアップ(2-5%) + 引け強い + 出来高 → 正のモメンタムシグナル
 * 3条件のうち2つ以上を満たす場合に正シグナルと判定
 */
export function hasGapUpMomentum(params: {
  gapUpRate: number | null;
  closingStrength: number | null;
  volumeSpikeRate: number | null;
}): { isMomentum: boolean; reasons: string[] } {
  const { gapUpRate, closingStrength, volumeSpikeRate } = params;
  const reasons: string[] = [];
  let conditionsMet = 0;

  // 条件1: 小幅ギャップアップ(2-5%)
  if (
    gapUpRate !== null &&
    gapUpRate >= GAP_UP_MOMENTUM.MIN_GAP_UP &&
    gapUpRate <= GAP_UP_MOMENTUM.MAX_GAP_UP
  ) {
    conditionsMet++;
    reasons.push(`ギャップアップ+${gapUpRate.toFixed(1)}%（好材料の兆候）`);
  }

  // 条件2: 引け強い(70%以上)
  if (
    closingStrength !== null &&
    closingStrength >= GAP_UP_MOMENTUM.CLOSING_STRENGTH_THRESHOLD
  ) {
    conditionsMet++;
    reasons.push(`引け強い（強度${closingStrength.toFixed(0)}%）`);
  }

  // 条件3: 出来高確認(1.3倍以上)
  if (
    volumeSpikeRate !== null &&
    volumeSpikeRate >= GAP_UP_MOMENTUM.VOLUME_CONFIRMATION_THRESHOLD
  ) {
    conditionsMet++;
    reasons.push(`出来高${volumeSpikeRate.toFixed(1)}倍（実需の裏付け）`);
  }

  return {
    isMomentum: conditionsMet >= 2,
    reasons,
  };
}

/** 投資スタイルに応じたテクニカルブレーキ閾値を取得 */
export function getTechnicalBrakeThreshold(investmentStyle?: string | null): number {
  switch (investmentStyle) {
    case "CONSERVATIVE":
      return TECHNICAL_BRAKE.CONSERVATIVE;
    case "BALANCED":
      return TECHNICAL_BRAKE.BALANCED;
    case "AGGRESSIVE":
      return TECHNICAL_BRAKE.AGGRESSIVE;
    default:
      return TECHNICAL_BRAKE.BALANCED;
  }
}

/**
 * 決算直前ブロック判定
 * 次回決算発表日の3日前以内ならブロック（buy→stay強制）
 */
export function isPreEarningsBlock(nextEarningsDate: Date | null): boolean {
  if (!nextEarningsDate) return false;
  const now = new Date();
  const diffMs = nextEarningsDate.getTime() - now.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays <= EARNINGS_SAFETY.PRE_EARNINGS_BLOCK_DAYS;
}

/**
 * 決算間近判定（警告用）
 * 次回決算発表日の7日前以内なら警告
 */
export function isEarningsNear(nextEarningsDate: Date | null): boolean {
  if (!nextEarningsDate) return false;
  const now = new Date();
  const diffMs = nextEarningsDate.getTime() - now.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays <= EARNINGS_SAFETY.EARNINGS_NEAR_WARNING_DAYS;
}

/**
 * 決算までの残り日数を取得
 */
export function getDaysUntilEarnings(nextEarningsDate: Date | null): number | null {
  if (!nextEarningsDate) return null;
  const now = new Date();
  const diffMs = nextEarningsDate.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  return diffDays >= 0 ? diffDays : null;
}

// --- おすすめ銘柄用セーフティチェック ---

export interface RecommendationSafetyResult {
  exclude: boolean;
  rule: string | null;
  reason: string | null;
}

/**
 * おすすめ銘柄のセーフティチェック
 * 購入分析の強制補正ルール（buy→stay）と共通のルールを適用し、
 * 見送り推奨になる銘柄をおすすめから事前に除外する
 */
export function checkRecommendationSafety(params: {
  isProfitable: boolean | null;
  volatility: number | null;
  weekChangeRate: number | null;
  deviationRate: number | null;
  nextEarningsDate: Date | null;
  investmentStyle?: string | null;
}): RecommendationSafetyResult {
  const { isProfitable, volatility, weekChangeRate, deviationRate, nextEarningsDate, investmentStyle } = params;

  // 危険銘柄（赤字×高ボラ）
  if (isDangerousStock(isProfitable, volatility)) {
    return { exclude: true, rule: "dangerous_stock", reason: `赤字×高ボラティリティ(${volatility?.toFixed(0)}%)` };
  }

  // 赤字×急騰（仕手株・バブルリスク）— skipSafetyRulesでもブロックされる
  if (isUnprofitableSurge(isProfitable, weekChangeRate)) {
    return { exclude: true, rule: "unprofitable_surge", reason: `赤字×急騰(+${weekChangeRate?.toFixed(0)}%)` };
  }

  // 決算直前（3日以内）— skipSafetyRulesでもブロックされる
  if (isPreEarningsBlock(nextEarningsDate)) {
    const days = getDaysUntilEarnings(nextEarningsDate);
    return { exclude: true, rule: "pre_earnings", reason: `決算${days}日前` };
  }

  // 極端な急騰 — skipSafetyRulesでもブロックされる水準
  if (weekChangeRate !== null && weekChangeRate >= MOMENTUM.EXTREME_SURGE_THRESHOLD) {
    return { exclude: true, rule: "extreme_surge", reason: `週間+${weekChangeRate.toFixed(0)}%の極端な急騰` };
  }

  // 極端な過熱 — skipSafetyRulesでもブロックされる水準
  if (deviationRate !== null && deviationRate >= MA_DEVIATION.EXTREME_UPPER_THRESHOLD) {
    return { exclude: true, rule: "extreme_overheat", reason: `乖離率+${deviationRate.toFixed(1)}%の極端な過熱` };
  }

  // 下落トレンド（投資スタイル別の閾値で判定）
  if (isInDecline(weekChangeRate, investmentStyle)) {
    return { exclude: true, rule: "in_decline", reason: `下落トレンド(${weekChangeRate?.toFixed(0)}%)` };
  }

  return { exclude: false, rule: null, reason: null };
}

/**
 * 配当権利落ち直後判定
 * 権利落ち日から3日以内なら保護対象
 */
export function isPostExDividend(exDividendDate: Date | null): boolean {
  if (!exDividendDate) return false;
  const now = new Date();
  const diffMs = now.getTime() - exDividendDate.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays <= EARNINGS_SAFETY.POST_EX_DIVIDEND_DAYS;
}

/**
 * 防御モード時の引き締め済み閾値を取得
 * isDefensive=true の場合、各閾値に引き締め係数を適用する
 */
export function getDefensiveThresholds(investmentStyle: string | null, isDefensive: boolean) {
  const style = investmentStyle || "BALANCED";

  // ベース閾値
  const baseSurge = getSurgeThreshold(style);
  const baseDecline = getDeclineThreshold(style);
  const baseOverheat = MA_DEVIATION.UPPER_THRESHOLD;
  const baseGapUp = getGapUpSurgeThreshold(style);

  if (!isDefensive) {
    return {
      surgeThreshold: baseSurge,
      declineThreshold: baseDecline,
      overheatThreshold: baseOverheat,
      gapUpThreshold: baseGapUp,
    };
  }

  // 防御モード: 引き締め係数を適用
  return {
    surgeThreshold: baseSurge !== null
      ? Math.round(baseSurge * MARKET_DEFENSIVE_MODE.SURGE_TIGHTENING_FACTOR)
      : null,
    declineThreshold: Math.round(baseDecline * MARKET_DEFENSIVE_MODE.DECLINE_LOOSENING_FACTOR),
    overheatThreshold: Math.round(baseOverheat * MARKET_DEFENSIVE_MODE.OVERHEAT_TIGHTENING_FACTOR),
    gapUpThreshold: Math.round(baseGapUp * MARKET_DEFENSIVE_MODE.GAP_UP_TIGHTENING_FACTOR),
  };
}

// --- stay → avoid 強制補正の判定関数 ---

/**
 * 業績悪化 + 下落トレンドで avoid 推奨すべきか判定
 * 赤字 + 減益トレンド + 週間変化率が閾値以下
 */
export function shouldAvoidUnprofitableDecline(
  isProfitable: boolean | null,
  profitTrend: string | null,
  weekChangeRate: number | null,
  investmentStyle: string,
): boolean {
  if (isProfitable !== false) return false;
  if (profitTrend !== "decreasing") return false;
  if (weekChangeRate === null) return false;
  const threshold = AVOID_ESCALATION.UNPROFITABLE_DECLINE[investmentStyle] ?? AVOID_ESCALATION.UNPROFITABLE_DECLINE.BALANCED;
  return weekChangeRate <= threshold;
}

/**
 * テクニカル全面ネガティブで avoid 推奨すべきか判定
 * テクニカル総合売りシグナル + 強度が閾値以上 + 中期予測が下落
 */
export function shouldAvoidTechnicalNegative(
  technicalSignal: string,
  technicalStrength: number,
  midTermTrend: string | null,
  investmentStyle: string,
): boolean {
  if (technicalSignal !== "sell") return false;
  if (midTermTrend !== "down") return false;
  const threshold = AVOID_ESCALATION.TECHNICAL_FULL_NEGATIVE[investmentStyle] ?? AVOID_ESCALATION.TECHNICAL_FULL_NEGATIVE.BALANCED;
  return technicalStrength >= threshold;
}

// --- 地政学リスク評価 ---

export type GeopoliticalRiskLevel = "stable" | "caution" | "alert";

export interface GeopoliticalRiskAssessment {
  level: GeopoliticalRiskLevel;
  score: number;
  factors: string[];
}

/**
 * VIX・WTI・地政学ニュース数から地政学リスクレベルを算出する
 * 既存の PreMarketData + MarketNews から計算（新規DBフィールド不要）
 */
export function assessGeopoliticalRisk(params: {
  vixClose: number | null;
  vixChangeRate: number | null;
  wtiChangeRate: number | null;
  negativeGeoNewsCount: number;
}): GeopoliticalRiskAssessment {
  const { vixClose, vixChangeRate, wtiChangeRate, negativeGeoNewsCount } = params;
  let score = 0;
  const factors: string[] = [];

  // VIXレベル（排他的 — 最も高い条件のみ加点）
  if (vixClose != null) {
    if (vixClose >= GEOPOLITICAL_RISK.VIX_HIGH) {
      score += GEOPOLITICAL_DEFENSIVE_MODE.VIX_HIGH_POINTS;
      factors.push(`VIX ${vixClose.toFixed(1)} (高リスク)`);
    } else if (vixClose >= GEOPOLITICAL_RISK.VIX_ELEVATED) {
      score += GEOPOLITICAL_DEFENSIVE_MODE.VIX_ELEVATED_POINTS;
      factors.push(`VIX ${vixClose.toFixed(1)} (やや高リスク)`);
    } else if (vixClose >= GEOPOLITICAL_RISK.VIX_NORMAL) {
      score += GEOPOLITICAL_DEFENSIVE_MODE.VIX_NORMAL_POINTS;
    }
  }

  // VIX急変動
  if (vixChangeRate != null && vixChangeRate >= GEOPOLITICAL_RISK.VIX_SPIKE_THRESHOLD) {
    score += GEOPOLITICAL_DEFENSIVE_MODE.VIX_SPIKE_POINTS;
    factors.push(`VIX急変動 +${vixChangeRate.toFixed(1)}%`);
  }

  // WTI急変動
  if (wtiChangeRate != null && Math.abs(wtiChangeRate) >= GEOPOLITICAL_RISK.WTI_SPIKE_THRESHOLD) {
    score += GEOPOLITICAL_DEFENSIVE_MODE.WTI_SPIKE_POINTS;
    factors.push(`原油急変動 ${wtiChangeRate >= 0 ? "+" : ""}${wtiChangeRate.toFixed(1)}%`);
  }

  // 地政学ネガティブニュース
  const newsCount = Math.min(negativeGeoNewsCount, GEOPOLITICAL_DEFENSIVE_MODE.NEWS_MAX_COUNT);
  if (newsCount > 0) {
    score += newsCount * GEOPOLITICAL_DEFENSIVE_MODE.NEWS_NEGATIVE_POINTS;
    factors.push(`地政学ネガティブニュース ${negativeGeoNewsCount}件`);
  }

  // レベル判定
  let level: GeopoliticalRiskLevel = "stable";
  if (score >= GEOPOLITICAL_DEFENSIVE_MODE.ALERT_SCORE) {
    level = "alert";
  } else if (score >= GEOPOLITICAL_DEFENSIVE_MODE.CAUTION_SCORE) {
    level = "caution";
  }

  return { level, score, factors };
}

/**
 * 長期下落トレンドで avoid 推奨すべきか判定
 * MA乖離率が閾値以下 + 週間変化率もマイナス（反発の兆候なし）
 */
export function shouldAvoidProlongedDecline(
  deviationRate: number | null,
  weekChangeRate: number | null,
  investmentStyle: string,
): boolean {
  if (deviationRate === null || weekChangeRate === null) return false;
  if (weekChangeRate >= 0) return false;
  const threshold = AVOID_ESCALATION.PROLONGED_DECLINE_DEVIATION[investmentStyle] ?? AVOID_ESCALATION.PROLONGED_DECLINE_DEVIATION.BALANCED;
  return deviationRate <= threshold;
}
