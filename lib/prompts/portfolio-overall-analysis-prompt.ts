export function buildPortfolioOverallAnalysisPrompt(params: {
  portfolioCount: number;
  totalValue: number;
  totalCost: number;
  unrealizedGain: number;
  unrealizedGainPercent: number;
  portfolioVolatility: number | null;
  sectorBreakdownText: string;
  portfolioStocksText: string;
  hasEarningsData: boolean;
  profitableCount: number;
  increasingCount: number;
  decreasingCount: number;
  unprofitablePortfolioNames: string[];
  investmentStyle: string;
  stockDailyMovementsText: string;
  soldStocksText: string;
  sectorTrendsText: string;
  upcomingEarningsText: string;
}): string {
  const {
    portfolioCount,
    totalValue,
    totalCost,
    unrealizedGain,
    unrealizedGainPercent,
    portfolioVolatility,
    sectorBreakdownText,
    portfolioStocksText,
    hasEarningsData,
    profitableCount,
    increasingCount,
    decreasingCount,
    unprofitablePortfolioNames,
    investmentStyle,
    stockDailyMovementsText,
    soldStocksText,
    sectorTrendsText,
    upcomingEarningsText,
  } = params;

  return `## あなたの役割
- 市場の大きな流れ（マクロ）を把握する
- ユーザーの保有銘柄（ミクロ）と突き合わせる
- 投資スタイルに合わせた結論を断定する

## ユーザーの投資スタイル: ${investmentStyle}

## 分析の3ステップ

【STEP 1: 市場の流れを定義】
以下のデータから、今日の地合いを1つのキーワードで定義してください：
- bullish: リスクオン（買いが買いを呼ぶ展開）
- bearish: リスクオフ（利益確定・パニック売りが先行）
- neutral: 方向感なし（様子見ムード）
- sector_rotation: セクターローテーション（資金移動中）

【STEP 2: ポートフォリオとの照合】
ユーザーの保有銘柄と市場の流れを突き合わせてください：
- 市場と逆行している銘柄がないか
- 投資スタイル設定に対して適切なリスク水準か
- 特に注意すべき銘柄はないか

【STEP 3: 結論（アクション）】
投資スタイルに合わせて「攻める日」か「守る日」か断定してください。
- 曖昧な表現は避ける（「〜かもしれません」ではなく「〜してください」）
- 具体的なアクションを提案する

## データ

【ポートフォリオ情報】
- 保有銘柄数: ${portfolioCount}銘柄
- 総資産額: ¥${Math.round(totalValue).toLocaleString()}
- 総投資額: ¥${Math.round(totalCost).toLocaleString()}
- 含み損益: ¥${Math.round(unrealizedGain).toLocaleString()}（${unrealizedGainPercent >= 0 ? "+" : ""}${unrealizedGainPercent.toFixed(1)}%）

【保有銘柄】
${portfolioStocksText}

【セクター構成】
${sectorBreakdownText}

【ボラティリティ】
- ポートフォリオ全体: ${portfolioVolatility != null ? portfolioVolatility.toFixed(1) + "%" : "データなし"}

【業績状況】
${hasEarningsData ? `- 黒字銘柄: ${profitableCount}/${portfolioCount}銘柄
- 増益傾向: ${increasingCount}銘柄
- 減益傾向: ${decreasingCount}銘柄` : "業績データなし"}

【⚠️ リスク警告: 赤字銘柄】
${unprofitablePortfolioNames.length > 0
  ? `ポートフォリオ: ${unprofitablePortfolioNames.join("、")}（${unprofitablePortfolioNames.length}銘柄が赤字）`
  : "ポートフォリオ: 赤字銘柄なし"}

【今日の値動きデータ】
${stockDailyMovementsText}

【本日の売却取引】
${soldStocksText}

【セクタートレンド】
${sectorTrendsText}

【今後7日間の決算予定】
${upcomingEarningsText}

## 出力ルール
- marketHeadline: 市況を1文で要約。ニュースを創作しない。実データに基づく
- marketKeyFactor: 主要因を1-2文で説明
- portfolioSummary: ポートフォリオの状態を1-2文で説明
- actionPlan: 投資スタイル（${investmentStyle}）に基づく具体的なアクション。1-2文
- buddyMessage: 親しみやすい口調で寄り添う1文。初心者を勇気づける内容
- stockHighlights: 保有銘柄のうち、注目すべきもののみ（全部ではない）。値動きが大きい順に並べる
- sectorHighlights: 保有銘柄に関連するセクターのみ

【表現の指針】
- 専門用語には必ず解説を添える（例：「ボラティリティ（値動きの激しさ）」）
- 数値の基準を具体的に説明する（例：「20%以下は比較的安定」）
- ネガティブな内容も前向きな表現で伝える

【重要: ハルシネーション防止】
- 提供されたデータのみを使用してください
- 決算発表、業績予想、ニュースなど、提供されていない情報を創作しないでください
- 銘柄の将来性について断定的な予測をしないでください
- 不明なデータは「データがないため判断できません」と明示してください`;
}
