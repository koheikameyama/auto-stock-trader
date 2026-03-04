import type { NavigatorSession } from "@/lib/portfolio-overall-analysis";

export function buildPortfolioOverallAnalysisPrompt(params: {
  session: NavigatorSession;
  hasPortfolio: boolean;
  portfolioCount: number;
  watchlistCount: number;
  totalValue: number;
  totalCost: number;
  unrealizedGain: number;
  unrealizedGainPercent: number;
  portfolioVolatility: number | null;
  sectorBreakdownText: string;
  portfolioStocksText: string;
  watchlistStocksText: string;
  hasEarningsData: boolean;
  profitableCount: number;
  increasingCount: number;
  decreasingCount: number;
  unprofitablePortfolioNames: string[];
  investmentStyle: string;
  portfolioAnalysisText: string;
  purchaseRecommendationText: string;
  soldStocksText: string;
  sectorTrendsText: string;
  upcomingEarningsText: string;
  benchmarkText: string;
  marketOverviewText: string;
}): string {
  const {
    session,
    hasPortfolio,
    portfolioCount,
    watchlistCount,
    totalValue,
    totalCost,
    unrealizedGain,
    unrealizedGainPercent,
    portfolioVolatility,
    sectorBreakdownText,
    portfolioStocksText,
    watchlistStocksText,
    hasEarningsData,
    profitableCount,
    increasingCount,
    decreasingCount,
    unprofitablePortfolioNames,
    investmentStyle,
    portfolioAnalysisText,
    purchaseRecommendationText,
    soldStocksText,
    sectorTrendsText,
    upcomingEarningsText,
    benchmarkText,
    marketOverviewText,
  } = params;

  const roleAndSteps =
    session === "evening"
      ? buildEveningRoleAndSteps(investmentStyle, hasPortfolio)
      : session === "pre-afternoon"
        ? buildPreAfternoonRoleAndSteps(investmentStyle, hasPortfolio)
        : buildMorningRoleAndSteps(investmentStyle, hasPortfolio);

  const outputRules =
    session === "evening"
      ? buildEveningOutputRules(investmentStyle, hasPortfolio)
      : session === "pre-afternoon"
        ? buildPreAfternoonOutputRules(investmentStyle, hasPortfolio)
        : buildMorningOutputRules(investmentStyle, hasPortfolio);

  const dataSection = hasPortfolio
    ? buildPortfolioDataSection({
        session,
        portfolioCount, totalValue, totalCost, unrealizedGain, unrealizedGainPercent,
        portfolioVolatility, sectorBreakdownText, portfolioStocksText, watchlistStocksText, watchlistCount,
        hasEarningsData, profitableCount, increasingCount, decreasingCount, unprofitablePortfolioNames,
        portfolioAnalysisText, purchaseRecommendationText, soldStocksText,
        benchmarkText,
      })
    : buildMarketOnlyDataSection({ watchlistStocksText, watchlistCount, purchaseRecommendationText });

  return `${roleAndSteps}

## データ

${dataSection}

【市場概況（日経・NY市場）】
${marketOverviewText}

【セクタートレンド】
${sectorTrendsText}

【今後7日間の決算予定】
${upcomingEarningsText}

${outputRules}`;
}

// ── データセクション ──

function buildPortfolioDataSection(params: {
  session: NavigatorSession;
  portfolioCount: number;
  totalValue: number;
  totalCost: number;
  unrealizedGain: number;
  unrealizedGainPercent: number;
  portfolioVolatility: number | null;
  sectorBreakdownText: string;
  portfolioStocksText: string;
  watchlistStocksText: string;
  watchlistCount: number;
  hasEarningsData: boolean;
  profitableCount: number;
  increasingCount: number;
  decreasingCount: number;
  unprofitablePortfolioNames: string[];
  portfolioAnalysisText: string;
  purchaseRecommendationText: string;
  soldStocksText: string;
  benchmarkText: string;
}): string {
  const {
    session, portfolioCount, totalValue, totalCost, unrealizedGain, unrealizedGainPercent,
    portfolioVolatility, sectorBreakdownText, portfolioStocksText, watchlistStocksText, watchlistCount,
    hasEarningsData, profitableCount, increasingCount, decreasingCount, unprofitablePortfolioNames,
    portfolioAnalysisText, purchaseRecommendationText, soldStocksText, benchmarkText,
  } = params;

  const soldStocksSection = session === "evening"
    ? `\n【本日の売却取引】\n${soldStocksText}\n`
    : "";

  return `【ポートフォリオ情報】
- 保有銘柄数: ${portfolioCount}銘柄
- 総資産額: ¥${Math.round(totalValue).toLocaleString()}
- 総投資額: ¥${Math.round(totalCost).toLocaleString()}
- 含み損益: ¥${Math.round(unrealizedGain).toLocaleString()}（${unrealizedGainPercent >= 0 ? "+" : ""}${unrealizedGainPercent.toFixed(1)}%）

【保有銘柄】
${portfolioStocksText}

【気になるリスト】（${watchlistCount}銘柄）
${watchlistStocksText}

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

【保有銘柄の分析結果（直近AI分析）】
${portfolioAnalysisText}

【購入判断の結果（直近AI分析）】
${purchaseRecommendationText}
${soldStocksSection}
【ベンチマーク比較】
${benchmarkText}`;
}

function buildMarketOnlyDataSection(params: {
  watchlistStocksText: string;
  watchlistCount: number;
  purchaseRecommendationText: string;
}): string {
  const { watchlistStocksText, watchlistCount, purchaseRecommendationText } = params;

  return `【ポートフォリオ情報】
ポートフォリオ未登録（保有銘柄なし）

【気になるリスト】（${watchlistCount}銘柄）
${watchlistStocksText}

【購入判断の結果（直近AI分析）】
${purchaseRecommendationText}`;
}

// ── セクター戦略の共通出力ルール ──

function buildSectorStrategyRule(hasPortfolio: boolean): string {
  if (hasPortfolio) {
    return `- sectorStrategy: セクタートレンドに基づく投資戦略。セクター分散の改善提案や注目セクターへの追加投資を提案。気になるリストに対象セクターの銘柄があれば具体的に言及すること。1-3文。セクタートレンドデータがない場合はnull`;
  }
  return `- sectorStrategy: セクタートレンドに基づく投資戦略。注目セクターの紹介と、投資を始めるならどのセクターが良いかを提案。気になるリストに対象セクターの銘柄があれば具体的に言及すること。1-3文。セクタートレンドデータがない場合はnull`;
}

// ── Morning セッション（開場前 8:00）──

function buildMorningRoleAndSteps(investmentStyle: string, hasPortfolio: boolean): string {
  const step2 = hasPortfolio
    ? `【STEP 2: 寄り付きで動くべき銘柄を特定する】
保有銘柄・ウォッチリストの中から以下を判断してください：
- 今日「寄り付きで売った方がいい」銘柄（週間上昇が過熱 / 悪材料あり）
- 今日「指値を入れておきたい」銘柄（週間下落から回復の兆し / 押し目候補）
- 今日は動かず「30分様子見」を推奨する銘柄`
    : `【STEP 2: 注目セクターから投資チャンスを探す】
セクタートレンドデータから、投資スタイルに合った注目セクターを選定してください：
- compositeScoreが高いセクター（上昇トレンド）は順張りのチャンス
- compositeScoreが低いが反転の兆しがあるセクターは逆張り候補
- 気になるリストに銘柄があれば、そのセクターとの相性も評価する`;

  const step3 = hasPortfolio
    ? `【STEP 3: 今日の行動方針を断定する】
投資スタイルに合わせた開場前の行動指針を断定してください。
- 「売り優先の日」「様子見の日」「指値準備の日」など明確に断定する
- ※ 開場後30分は原則として様子見を推奨（寄り付き直後の乱高下を避ける）
- 例外として即行動すべきケース（急騰銘柄の利確など）があれば具体的に示す`
    : `【STEP 3: 今日の行動方針を提案する】
投資スタイルに合わせた行動指針を提案してください。
- 注目セクターの中から投資を始めるなら何が良いかを提案
- 気になるリストに銘柄がある場合はその銘柄の買い時を評価
- まだ銘柄を持っていないユーザーに寄り添い、焦らず始められるよう導く`;

  return `## あなたの役割
市場はまだ開いていません（開場前の分析です）。
前日終値・セクタートレンド・NY市場の動向をもとに、今日の戦略を開場前に立ててください。

⚠️ 重要: 提供されているデータは「前日終値ベース」です。今日の株価はまだ動いていません。
⚠️ NY市場（S&P 500・NASDAQ）の前夜の動きは、日本市場の寄り付きに影響することが多いです。

## ユーザーの投資スタイル: ${investmentStyle}

## 分析の3ステップ

【STEP 1: 今日の地合いを「予測」する】
前日の値動き・セクタートレンド・NY市場（S&P 500・NASDAQ）・地政学リスク指標（VIX・WTI原油）の動向から、今日の地合いを予測してください：
- bullish: リスクオンが予想される（前日堅調・ポジティブなニュース）
- bearish: リスクオフが予想される（前日軟調・ネガティブなニュース）
- neutral: 方向感が読めない（材料乏しく様子見ムード）
- sector_rotation: 特定セクターへの資金移動が予想される

※ VIXが30以上の場合は「リスク回避の日」として慎重姿勢を推奨
※ WTI原油が急変動（前日比±5%以上）の場合はエネルギーセクターへの影響を分析

${step2}

${step3}`;
}

function buildMorningOutputRules(investmentStyle: string, hasPortfolio: boolean): string {
  const portfolioSummaryRule = hasPortfolio
    ? `- portfolioSummary: ポートフォリオの現在地を2-3文で説明。超過リターンの具体的数値（日経平均を何%上回っている/下回っているか）を含める。ベータ値が1.3以上なら「市場より大きく動くハイリスク型」、0.7以下なら「市場より安定した守備型」と特性を伝える`
    : `- portfolioSummary: 市場動向のまとめと投資チャンスの概要を1-2文で`;

  const actionPlanRule = hasPortfolio
    ? `- actionPlan: 投資スタイル（${investmentStyle}）に基づく、開場前の具体的な行動方針。3-4文で以下を網羅する:
  1. 最優先のアクション（具体的な銘柄名と根拠を含む）。「今日は〜してください」と断定する
  2. セクタートレンドに基づく戦略
  3. 今後7日間に決算を控える銘柄がある場合、その銘柄名と注意点
  4. VIXが25以上またはWTI原油が前日比±3%以上の場合、リスク要因と対処法`
    : `- actionPlan: 投資スタイル（${investmentStyle}）に基づく、注目セクターや銘柄探しの提案。3-4文で以下を網羅する:
  1. 注目セクターとその根拠（セクタートレンドのcompositeScoreを参照）
  2. 気になるリスト銘柄があればその買い時評価
  3. 今後7日間に決算を控える注目銘柄がある場合、その注意点
  4. VIXが25以上またはWTI原油が前日比±3%以上の場合、リスク要因と対処法`;

  const portfolioStatusRule = hasPortfolio
    ? ``
    : `- portfolioStatus: ポートフォリオ未登録のため "healthy" を設定\n`;

  const stockHighlightsRule = hasPortfolio
    ? `- stockHighlights: 保有銘柄と気になるリスト銘柄の中から、今日特に注目すべきもののみ（全部ではない）。値動きが大きい順に並べる。sourceフィールドで保有銘柄は"portfolio"、気になるリスト銘柄は"watchlist"を設定する
  - analysisには「今日どう動くべきか」（売り検討 / 指値候補 / 様子見）をデータの数値（MA乖離率・出来高比・前日比・週間変化率など）を根拠として記載すること
  - 【重要】前日の値動きと今日の予測が矛盾する場合（例: 上昇中だが売り推奨）、「なぜそう判断するのか」の根拠を必ず明示すること
  - 例: 「週間+5.2%と堅調ですが、MA乖離率+8.3%で過熱感あり。今日は寄り付きで一部利確を検討してください」
  - 例: 「前日比-2.1%と軟調ですが、週間では+3.5%を維持。出来高比1.5倍の押し目買いの動き。¥XXX付近に指値を入れておく候補」`
    : `- stockHighlights: 気になるリスト銘柄の中から注目すべきもの。銘柄がなければ空配列。sourceは"watchlist"を設定する
  - analysisには買い時の判断材料をデータの数値を根拠として記載すること`;

  return `## 出力ルール
- marketHeadline: 「今日の地合いの予測」を1文で。前日比・NY市場の動向を含める。ニュースを創作しない
- marketKeyFactor: 今日の地合いを左右する主要因を1-2文で説明。NY市場の影響があれば言及する。VIXが25以上の場合はリスク水準を明示、WTI原油が前日比±3%以上の場合はエネルギーセクターへの影響を言及する
${portfolioStatusRule}${portfolioSummaryRule}
${actionPlanRule}
- buddyMessage: 開場前の緊張をほぐし、冷静に臨めるよう背中を押す1文。「今日も焦らず、まず30分は様子見を」のような落ち着いたトーンで
${stockHighlightsRule}
- sectorHighlights: 保有銘柄に関連するセクター、および注目度の高いセクター（compositeScore上位）。セクター内に気になるリスト銘柄がある場合はwatchlistStocksに含めること
${buildSectorStrategyRule(hasPortfolio)}

【表現の指針】
- 専門用語には必ず解説を添える（例：「ボラティリティ（値動きの激しさ）」）
- 数値の基準を具体的に説明する（例：「MA乖離率+8%以上は過熱ゾーン」）
- 開場前の分析であることを意識し、「様子見」を基本とした上で具体的な行動を提案する

【重要: ハルシネーション防止】
- 提供されたデータのみを使用してください
- 決算発表、業績予想、ニュースなど、提供されていない情報を創作しないでください
- 不明なデータは「データがないため判断できません」と明示してください`;
}

// ── Pre-Afternoon セッション（後場前 11:40）──

function buildPreAfternoonRoleAndSteps(investmentStyle: string, hasPortfolio: boolean): string {
  const step2 = hasPortfolio
    ? `【STEP 2: 前場の動きが「本物か、だましか」を判定する】
各銘柄の前場の動きを検証してください：
- 出来高比 1.5倍以上 → 本物のシグナルの可能性が高い
- 出来高比 0.7倍以下 → 材料なしの動き、信頼性が低い（だましに注意）
- MA乖離率が大きい状態での急騰 → 過熱感あり、後場に反落リスク
- MA乖離率がマイナスでの反発 → 押し目買いが機能している可能性`
    : `【STEP 2: 注目セクターの前場パフォーマンスを確認する】
セクタートレンドデータから、前場で動きのあったセクターを確認してください：
- 上昇セクター: 投資チャンスとしての評価
- 下落セクター: 押し目候補としての評価
- 気になるリストに銘柄があれば、前場の動きを踏まえた買い時評価`;

  const step3 = hasPortfolio
    ? `【STEP 3: 後場の行動を銘柄ごとに断定する】
投資スタイルに合わせて、後場の行動を明確に指示してください：
- 保有継続: トレンドが本物で、引き続き上昇期待できる場合
- 利確検討: 前場で大きく上昇し、過熱感がある場合
- 損切り検討: 想定と逆方向に動き、損切りラインに近づいている場合
- 追加購入検討: 押し目買いのシグナルが出ており、投資スタイルと合致する場合
- 指値設定: ウォッチリスト銘柄で後場に狙いたい価格帯がある場合`
    : `【STEP 3: 後場の投資チャンスを提案する】
投資スタイルに合わせて、後場の行動を提案してください：
- 注目セクターの中から後場に狙えそうな銘柄やセクターを提案
- 気になるリストに銘柄がある場合は買い時の評価を添える
- まだ銘柄を持っていないユーザーに、焦らず銘柄を選べるよう導く`;

  return `## あなたの役割
前場（9:00〜11:30）が終わりました。
後場（12:30〜15:30）に向けて、前場の値動きとNY市場の動向をもとにポジションを調整してください。

⚠️ 重要: 今日の前場の動きが反映されています。この結果が「本物か、だましか」を見極めることが最重要です。
⚠️ 前夜のNY市場の流れが前場に反映されたか、乖離しているかも判断材料にしてください。

## ユーザーの投資スタイル: ${investmentStyle}

## 分析の3ステップ

【STEP 1: 前場の地合いを「確認」する】
前日比・週間変化・出来高比から、今日の前場で何が起きたかを確認してください：
- bullish: 前場で上昇トレンドが確認できた
- bearish: 前場で下落トレンドが確認できた
- neutral: 前場で方向感が出なかった（小動き）
- sector_rotation: 特定セクターへの資金移動が起きている

${step2}

${step3}`;
}

function buildPreAfternoonOutputRules(investmentStyle: string, hasPortfolio: boolean): string {
  const portfolioSummaryRule = hasPortfolio
    ? `- portfolioSummary: 前場終了時点のポートフォリオの状態を2-3文で説明。含み損益の変化と超過リターンの具体的数値を含める。ベータ値が1.3以上なら「市場より大きく動くハイリスク型」、0.7以下なら「市場より安定した守備型」と特性を伝える`
    : `- portfolioSummary: 前場の市場動向と注目セクターの動きを1-2文でまとめる`;

  const actionPlanRule = hasPortfolio
    ? `- actionPlan: 投資スタイル（${investmentStyle}）に基づく、後場の具体的な行動方針。3-4文で以下を網羅する:
  1. 最優先のアクション（具体的な銘柄名と根拠を含む）。「後場は〜してください」と断定する
  2. セクタートレンドに基づく戦略
  3. 今後7日間に決算を控える銘柄がある場合、その銘柄名と注意点
  4. リスク要因がある場合はその対処法`
    : `- actionPlan: 投資スタイル（${investmentStyle}）に基づく、後場の投資チャンスの提案。3-4文で以下を網羅する:
  1. 前場の動きを踏まえた注目セクターと根拠
  2. 気になるリスト銘柄があれば前場の動きを踏まえた買い時評価
  3. 今後7日間に決算を控える注目銘柄がある場合、その注意点
  4. リスク要因がある場合はその対処法`;

  const portfolioStatusRule = hasPortfolio
    ? ``
    : `- portfolioStatus: ポートフォリオ未登録のため "healthy" を設定\n`;

  const stockHighlightsRule = hasPortfolio
    ? `- stockHighlights: 保有銘柄と気になるリスト銘柄の中から、後場に注目すべきもののみ（全部ではない）。後場の行動が必要な順に並べる。sourceフィールドで保有銘柄は"portfolio"、気になるリスト銘柄は"watchlist"を設定する
  - analysisには「後場にどう動くべきか」（利確 / 損切り / 保有継続 / 指値設定）をデータの数値（MA乖離率・出来高比・前日比）を根拠として記載すること
  - 【重要】前場の動きと後場の推奨が矛盾する場合（例: 前場上昇中だが利確推奨）、「なぜそう判断するのか」の根拠を必ず明示すること
  - 例: 「前場+3.2%と好調ですが、出来高比0.6倍と買いの勢いが弱く、MA乖離率+9.1%で過熱感あり。後場は利確を検討してください」
  - 例: 「前場-1.8%と軟調ですが、週間では+4.2%を維持し出来高比1.3倍。押し目買いの可能性あり。¥XXX付近に指値設定を検討」`
    : `- stockHighlights: 気になるリスト銘柄の中から注目すべきもの。銘柄がなければ空配列。sourceは"watchlist"を設定する
  - analysisには前場の動きを踏まえた買い時の判断材料を記載すること`;

  return `## 出力ルール
- marketHeadline: 前場の地合いを1文で総括。「前場は〜でした」という形式で実データに基づく
- marketKeyFactor: 前場の動きを左右した主要因を1-2文で説明。VIXが25以上の場合はリスク水準を明示、WTI原油が前日比±3%以上の場合はエネルギーセクターへの影響を言及する
${portfolioStatusRule}${portfolioSummaryRule}
${actionPlanRule}
- buddyMessage: 前場の結果を受け止め、後場に冷静に臨めるよう背中を押す1文。前場が良くても悪くても落ち着いたトーンで
${stockHighlightsRule}
- sectorHighlights: 保有銘柄に関連するセクター、および注目度の高いセクター（compositeScore上位）。セクター内に気になるリスト銘柄がある場合はwatchlistStocksに含めること
${buildSectorStrategyRule(hasPortfolio)}

【表現の指針】
- 専門用語には必ず解説を添える（例：「出来高比（通常の何倍取引されているか）」）
- 前場の結果は事実として伝え、後場の行動を明確に提案する
- 損切り・利確は投資スタイルに応じた許容範囲内で判断する

【重要: ハルシネーション防止】
- 提供されたデータのみを使用してください
- 決算発表、業績予想、ニュースなど、提供されていない情報を創作しないでください
- 不明なデータは「データがないため判断できません」と明示してください`;
}

// ── Evening セッション ──

function buildEveningRoleAndSteps(investmentStyle: string, hasPortfolio: boolean): string {
  const step2 = hasPortfolio
    ? `【STEP 2: 持ち株の健康診断】
ユーザーの保有銘柄を点検してください：
- 損切りライン（投資スタイルに応じた許容損失）に接近している銘柄はないか
- 今日の値動きで堅調だった銘柄、軟調だった銘柄を判定
- 含み損益の変化に注目`
    : `【STEP 2: 注目セクターの今日のパフォーマンスを振り返る】
セクタートレンドデータから、今日の動きを振り返ってください：
- 上昇セクター: 今後も注目すべき理由の分析
- 下落セクター: 一時的な下落か、トレンド転換かの評価
- 気になるリストに銘柄があれば、今日の動きを踏まえた評価`;

  const step3 = hasPortfolio
    ? `【STEP 3: 明日の予習】
明日に向けた準備を提案してください：
- 今後7日間の決算発表予定を確認し、対策を提案
- 注目すべき経済指標やイベントがあればデータから読み取る
- ポジション調整（増減・損切り・利確）の必要性を評価`
    : `【STEP 3: 明日の予習】
明日に向けた準備を提案してください：
- 注目セクターの動向から、明日注目すべきポイントを提案
- 気になるリストに銘柄がある場合は、明日の買い時候補を評価
- まだ銘柄を持っていないユーザーに、銘柄選びのヒントを提供する`;

  return `## あなたの役割
あなたはStock Buddyの「アナリスト兼コーチ」です。
今日の市場が閉まった後に、ユーザーのポートフォリオを振り返り、明日の準備を手伝います。
日経市場とNY市場（S&P 500・NASDAQ）の相関も考慮して分析してください。

## ユーザーの投資スタイル: ${investmentStyle}

## 分析の3ステップ

【STEP 1: 市場の総評】
今日何が起きたかを振り返ってください：
- bullish: リスクオン（買いが優勢だった）
- bearish: リスクオフ（売りが優勢だった）
- neutral: 方向感なし（様子見ムードだった）
- sector_rotation: セクターローテーション（資金移動が見られた）

${step2}

${step3}`;
}

function buildEveningOutputRules(investmentStyle: string, hasPortfolio: boolean): string {
  const portfolioSummaryRule = hasPortfolio
    ? `- portfolioSummary: 今日のポートフォリオの動きを2-3文で説明。超過リターンの具体的数値（日経平均を何%上回った/下回ったか）を含める。ベータ値が1.3以上なら「市場より大きく動くハイリスク型」、0.7以下なら「市場より安定した守備型」と特性を伝える`
    : `- portfolioSummary: 今日の市場動向と注目セクターのまとめを1-2文で`;

  const actionPlanRule = hasPortfolio
    ? `- actionPlan: 投資スタイル（${investmentStyle}）に基づく明日に向けた具体的な準備。3-4文で以下を網羅する:
  1. 今日の結果を踏まえた最優先のアクション（具体的な銘柄名と根拠を含む）
  2. セクタートレンドに基づく明日の戦略
  3. 今後7日間に決算を控える銘柄がある場合、決算前の対応方針
  4. リスク要因がある場合はその対処法`
    : `- actionPlan: 投資スタイル（${investmentStyle}）に基づく、明日の投資チャンスの提案。3-4文で以下を網羅する:
  1. 今日の動きを踏まえた注目セクターと明日の注目ポイント
  2. 気になるリスト銘柄があれば今日の動きを踏まえた評価
  3. 今後7日間に決算を控える注目銘柄がある場合、その注意点
  4. リスク要因がある場合はその対処法`;

  const portfolioStatusRule = hasPortfolio
    ? ``
    : `- portfolioStatus: ポートフォリオ未登録のため "healthy" を設定\n`;

  const stockHighlightsRule = hasPortfolio
    ? `- stockHighlights: 保有銘柄と気になるリスト銘柄の中から、今日の動きが注目すべきもののみ（全部ではない）。値動きが大きい順に並べる。sourceフィールドで保有銘柄は"portfolio"、気になるリスト銘柄は"watchlist"を設定する。気になるリスト銘柄は購入検討中のため、買い時の判断材料となる分析を添える
  - analysisには、注目理由をデータの数値（MA乖離率・出来高比・前日比・週間変化率など）を根拠として具体的に記載すること
  - 【重要】直近の値動きと分析内容が矛盾する場合（例: 株価上昇中だが注意喚起、株価下落中だがポジティブ評価）、「なぜそう判断するのか」の根拠を必ず明示すること
  - 例: 「週間+5.2%と堅調ですが、MA乖離率+8.3%で過熱感があり、出来高比0.7倍と買い勢力が弱まっているため、利益確定売りによる調整に注意」
  - 例: 「前日比-2.1%と軟調ですが、週間では+3.5%を維持し、出来高比1.5倍の増加は押し目買いの動き。一時的な調整と判断」`
    : `- stockHighlights: 気になるリスト銘柄の中から注目すべきもの。銘柄がなければ空配列。sourceは"watchlist"を設定する
  - analysisには今日の動きを踏まえた買い時の判断材料を記載すること`;

  return `## 出力ルール
- marketHeadline: 今日の市場を1文で総括。日経とNY市場の動きを踏まえる。ニュースを創作しない。実データに基づく
- marketKeyFactor: 今日の主要因を1-2文で振り返り。NY市場との相関があれば言及する。VIXが25以上の場合はリスク水準を明示、WTI原油が前日比±3%以上の場合はエネルギーセクターへの影響を言及する
${portfolioStatusRule}${portfolioSummaryRule}
${actionPlanRule}
- buddyMessage: 親しみやすい口調で今日の労いと明日への期待を込めた1文
${stockHighlightsRule}
- sectorHighlights: 保有銘柄に関連するセクター、および注目度の高いセクター（compositeScore上位）。セクター内に気になるリスト銘柄がある場合はwatchlistStocksに含めること
${buildSectorStrategyRule(hasPortfolio)}

【表現の指針】
- 専門用語には必ず解説を添える（例：「ボラティリティ（値動きの激しさ）」）
- 数値の基準を具体的に説明する（例：「20%以下は比較的安定」）
- ネガティブな内容も前向きな表現で伝える
- 1日の終わりなので落ち着いたトーンで

【重要: ハルシネーション防止】
- 提供されたデータのみを使用してください
- 決算発表、業績予想、ニュースなど、提供されていない情報を創作しないでください
- 銘柄の将来性について断定的な予測をしないでください
- 不明なデータは「データがないため判断できません」と明示してください`;
}
