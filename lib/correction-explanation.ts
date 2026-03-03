/**
 * セーフティルール補正時の解説テキスト生成
 *
 * AIの推奨がセーフティルールによって補正された際に、
 * ユーザーに分かりやすい解説テキストを生成する。
 */

/** 補正ルールID */
export type CorrectionRuleId =
  | "surge_block"
  | "decline_block"
  | "overheat_block"
  | "dangerous_stock"
  | "unprofitable_surge"
  | "gap_up_block"
  | "volume_manipulation"
  | "technical_brake"
  | "market_crash"
  | "market_panic"
  | "pre_earnings_block"
  | "post_ex_dividend"
  | "panic_sell_prevention"
  | "trend_protection"
  | "relative_strength_protection"
  | "profit_taking_promotion"
  | "delisted_stock"
  | "dangerous_stock_buy_suppression"
  | "extreme_surge_block"
  | "extreme_overheat_block"
  | "low_consensus"
  | "rebound_warning";

/** 補正コンテキスト */
export interface CorrectionContext {
  ruleId: CorrectionRuleId;
  /** 投資スタイル名（日本語） */
  styleName: string;
  /** AI元推奨 */
  originalRecommendation: string;
  /** 補正後推奨 */
  correctedRecommendation: string;
  /** ルールの閾値（表示用） */
  thresholdValue?: string;
  /** 実際の値（表示用） */
  actualValue?: string;
  /** 追加情報 */
  additionalInfo?: string;
}

/** ルール名の日本語マッピング */
const RULE_NAMES: Record<CorrectionRuleId, string> = {
  surge_block: "急騰ブロックルール",
  decline_block: "下落トレンドブロック",
  overheat_block: "過熱圏ブロック",
  dangerous_stock: "危険銘柄ルール",
  unprofitable_surge: "赤字×急騰ルール",
  gap_up_block: "ギャップアップブロック",
  volume_manipulation: "仕手株リスクルール",
  technical_brake: "テクニカルブレーキ",
  market_crash: "市場急落ルール",
  market_panic: "市場パニックモード",
  pre_earnings_block: "決算前ブロック",
  post_ex_dividend: "配当落ち保護",
  panic_sell_prevention: "パニック売り防止",
  trend_protection: "中長期トレンド保護",
  relative_strength_protection: "相対強度保護",
  profit_taking_promotion: "利確促進ルール",
  delisted_stock: "データ取得不可銘柄ルール",
  dangerous_stock_buy_suppression: "危険銘柄買い増し抑制",
  extreme_surge_block: "極端な急騰ブロック",
  extreme_overheat_block: "極端な過熱圏ブロック",
  low_consensus: "スタイル間合意度不足",
  rebound_warning: "リバウンド警戒ルール",
};

/** 投資スタイルキー→日本語名 */
export function getStyleNameJa(styleKey: string): string {
  switch (styleKey) {
    case "CONSERVATIVE":
      return "安定配当型";
    case "BALANCED":
      return "成長投資型";
    case "AGGRESSIVE":
      return "アクティブ型";
    default:
      return styleKey;
  }
}

/**
 * セーフティルール補正の解説テキストを生成
 */
export function generateCorrectionExplanation(ctx: CorrectionContext): string {
  const ruleName = RULE_NAMES[ctx.ruleId];

  switch (ctx.ruleId) {
    case "surge_block":
      return `週間変化率が${ctx.actualValue}と${ctx.styleName}の閾値（${ctx.thresholdValue}）を超えており、「${ruleName}」に該当したため、高値掴みを避ける判断（様子見）になりました。`;

    case "decline_block":
      return `週間変化率が${ctx.actualValue}と${ctx.styleName}の閾値（${ctx.thresholdValue}）を下回っており、「${ruleName}」に該当したため、下落リスクを避ける判断になりました。`;

    case "overheat_block":
      return `25日移動平均線からの乖離率が${ctx.actualValue}と閾値（${ctx.thresholdValue}）を超えており、「${ruleName}」に該当したため、過熱感のある買いを控える判断になりました。`;

    case "dangerous_stock":
      return `業績が赤字かつボラティリティが${ctx.actualValue}と高く、「${ruleName}」に該当したため、様子見の判断になりました。`;

    case "unprofitable_surge":
      return `赤字企業が週間${ctx.actualValue}急騰しており、「${ruleName}」に該当しました。仕手株やバブルの可能性があるため、様子見の判断になりました。`;

    case "gap_up_block":
      return `当日のギャップアップ率が${ctx.actualValue}と${ctx.styleName}の閾値（${ctx.thresholdValue}）を超えており、「${ruleName}」に該当したため、飛びつき買いを避ける判断になりました。`;

    case "volume_manipulation":
      return `出来高が${ctx.actualValue}に急増し、ギャップアップ率も${ctx.additionalInfo}と高いため、「${ruleName}」に該当しました。投機的な値動きの可能性があるため、様子見の判断になりました。`;

    case "technical_brake":
      return `テクニカル指標が強い下落シグナル（強度${ctx.actualValue}）を示しており、「${ruleName}」（閾値${ctx.thresholdValue}）に該当したため、下げ止まりを確認する判断になりました。`;

    case "market_crash":
      return `市場全体（日経平均）が急落中のため、「${ruleName}」が発動しました。市場の安定を確認するまで様子見の判断になりました。`;

    case "market_panic":
      return `日経平均が週間${ctx.actualValue}と大幅に下落しており、「${ruleName}」が発動しました。全スタイルの閾値が引き締められ、より慎重な判断基準が適用されています。`;

    case "pre_earnings_block":
      return `決算発表まであと${ctx.actualValue}のため、「${ruleName}」が発動しました。決算ギャンブルを避けるため、新規購入は控える判断になりました。`;

    case "post_ex_dividend":
      return `直近で配当権利落ちが発生しており、「${ruleName}」が適用されました。株価の下落は配当落ち分を含む可能性があり、トレンド転換ではないと判断しました。`;

    case "panic_sell_prevention":
      return `25日移動平均線から${ctx.actualValue}の下方乖離で「売られすぎ」の状態のため、「${ruleName}」が発動しました。大底での売却を避けるため、自律反発を待つ判断になりました。`;

    case "trend_protection":
      return `${ctx.additionalInfo}のトレンドが上昇見通しのため、「${ruleName}」が適用されました。短期的な売りシグナルでの即売却は見送り、中長期の回復を優先する判断になりました。`;

    case "relative_strength_protection":
      return `市場全体の下落に対して${ctx.actualValue}のアウトパフォームを示しており、「${ruleName}」が適用されました。下落は地合い要因とみられるため、様子見の判断になりました。`;

    case "profit_taking_promotion":
      return `含み益${ctx.actualValue}の状態で短期的に下落の予兆があるため、「${ruleName}」が発動しました。${ctx.additionalInfo}`;

    case "delisted_stock":
      return `この銘柄はデータを正常に取得できないため、「${ruleName}」が適用されました。`;

    case "dangerous_stock_buy_suppression":
      return `業績が赤字かつボラティリティが${ctx.actualValue}と高いため、「${ruleName}」が適用され、買い増しは控える判断になりました。`;

    case "low_consensus":
      return `3つの投資スタイルのうち${ctx.actualValue}のみが買い推奨のため、「${ruleName}」が適用されました。買いの根拠が弱い状態のため、より明確なシグナルを待つ判断になりました。`;

    default:
      return `「${ruleName}」により、AIの判断が${ctx.originalRecommendation}から${ctx.correctedRecommendation}に補正されました。`;
  }
}
