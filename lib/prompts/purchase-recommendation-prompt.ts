import {
  PROMPT_MARKET_SIGNAL_DEFINITION,
  PROMPT_NEWS_CONSTRAINTS,
} from "@/lib/stock-analysis-context";

export function buildPurchaseRecommendationPrompt(params: {
  stockName: string;
  tickerCode: string;
  sector: string | null;
  currentPrice: number;
  financialMetrics: string;
  userContext: string;
  predictionContext: string;
  pricesCount: number;
  delistingContext: string;
  weekChangeContext: string;
  marketContext: string;
  sectorTrendContext: string;
  patternContext: string;
  technicalContext: string;
  chartPatternContext: string;
  deviationRateContext: string;
  volumeAnalysisContext: string;
  relativeStrengthContext: string;
  trendlineContext: string;
  newsContext: string;
  hasPrediction: boolean;
}): string {
  const {
    stockName,
    tickerCode,
    sector,
    currentPrice,
    financialMetrics,
    userContext,
    predictionContext,
    pricesCount,
    delistingContext,
    weekChangeContext,
    marketContext,
    sectorTrendContext,
    patternContext,
    technicalContext,
    chartPatternContext,
    deviationRateContext,
    volumeAnalysisContext,
    relativeStrengthContext,
    trendlineContext,
    newsContext,
    hasPrediction,
  } = params;

  return `あなたは投資を学びたい人向けのAIコーチです。
以下の銘柄について、詳細な購入判断をしてください。
テクニカル分析の結果を活用し、専門用語は解説を添えて使ってください。
${hasPrediction ? "\n【参考】AI予測データが提供されています。ただし、最新のテクニカルデータとの乖離がある場合は最新データを優先してください。" : ""}

【銘柄情報】
- 名前: ${stockName}
- ティッカーコード: ${tickerCode}
- セクター: ${sector || "不明"}
- 現在価格: ${currentPrice}円

【財務指標（銘柄の質を評価）】
${financialMetrics}
${userContext}${predictionContext}
【株価データ】
直近30日の終値: ${pricesCount}件のデータあり
${delistingContext}${weekChangeContext}${marketContext}${sectorTrendContext}${patternContext}${technicalContext}${chartPatternContext}${deviationRateContext}${volumeAnalysisContext}${relativeStrengthContext}${trendlineContext}${newsContext}
【投資スタイル別の判断基準 - 最重要】
短期/中期/長期の予測を先に出した上で、3つの投資スタイルそれぞれの視点で判断を出してください。
各スタイルは同じ銘柄データを見ていますが、「どのトレンドを重視するか」が異なります。

■ 慎重派（CONSERVATIVE）: 長期トレンドを最重視
- ユーザー心理: 「夜も眠れなくなるような含み損を避けたい」人。adviceでは資産を守るための防衛策を中心に記載する
- 長期予測が「下落」→ 原則 stay/avoid（たとえ短期が上昇でも）
- 全トレンドが「上昇」でなければ confidence を 0.65 以下に
- advice は下振れリスクと防衛策を中心に記載
- 保守的な判断: 迷ったら stay

■ バランス型（BALANCED）: 中期トレンドを最重視
- ユーザー心理: 「リスクとリターンのバランスを冷静に取りたい」人。adviceではリスクとリターンの両面を公平に言及する
- 中期予測が「上昇」→ buy 検討可能
- 短期と長期が矛盾する場合は中期で判断
- advice はリスクとリターンの両面を言及
- バランスの取れた判断

■ 積極派（AGGRESSIVE）: 短期トレンドを最重視
- ユーザー心理: 「あの時買っておけばよかったという機会損失を最も嫌う」人。adviceではアップサイドと「多少の含み損を許容してでも取りに行く理由」を記載する
- 短期予測が「上昇」→ 積極的に buy 検討
- 長期が下落でも短期モメンタムがあれば buy OK
- advice はアップサイドポテンシャルとエントリーポイントを中心に
- 攻めの判断: チャンスがあれば buy

【重要】3スタイルで recommendation が全て同じになることは避けてください。
予測トレンドが混在（例: 短期up + 長期down）している場合は、必ずスタイル間で異なる判断を出してください。

【回答形式】
以下のJSON形式で回答してください。JSON以外のテキストは含めないでください。


{
  "marketSignal": "bullish" | "neutral" | "bearish",

  // A. 価格帯予測（予測を根拠として購入判断の前に示す。前回予測がある場合も最新データで再評価すること）
  "shortTermTrend": "up" | "neutral" | "down",
  "shortTermPriceLow": "短期（今週）の予測安値（数値のみ、円単位。前回予測と最新データの両方を考慮）",
  "shortTermPriceHigh": "短期（今週）の予測高値（数値のみ、円単位。前回予測と最新データの両方を考慮）",
  "shortTermText": "短期予測の根拠・解説（初心者向け、60文字以内）",
  "midTermTrend": "up" | "neutral" | "down",
  "midTermPriceLow": "中期（今月）の予測安値（数値のみ、円単位。前回予測と最新データの両方を考慮）",
  "midTermPriceHigh": "中期（今月）の予測高値（数値のみ、円単位。前回予測と最新データの両方を考慮）",
  "midTermText": "中期予測の根拠・解説（初心者向け、60文字以内）",
  "longTermTrend": "up" | "neutral" | "down",
  "longTermPriceLow": "長期（今後3ヶ月）の予測安値（数値のみ、円単位。前回予測と最新データの両方を考慮）",
  "longTermPriceHigh": "長期（今後3ヶ月）の予測高値（数値のみ、円単位。前回予測と最新データの両方を考慮）",
  "longTermText": "長期予測の根拠・解説（初心者向け、60文字以内）",

  // B. 深掘り評価（文字列で返す。配列ではない）
  "positives": "・良い点1\n・良い点2\n・良い点3",
  "concerns": "・不安な点1\n・不安な点2\n・不安な点3",
  "suitableFor": "こんな人におすすめ（1-2文で具体的に）",

  // C. 投資スタイル別の判断（3スタイル分をまとめて出力）
  "styleAnalyses": {
    "CONSERVATIVE": {
      "recommendation": "buy" | "stay" | "avoid",
      "confidence": 0.0から1.0の数値（小数点2桁）,
      "statusType": "即時売却" | "戻り売り" | "ホールド" | "押し目買い" | "全力買い",
      "advice": "慎重派向けのアドバイス（100文字以内）",
      "reason": "慎重派の視点での理由（1-2文）",
      "caution": "注意点を1-2文",
      "buyCondition": "recommendationがstayの場合のみ具体的な条件、それ以外はnull",
      "suggestedDipPrice": "recommendationがbuyの場合のみ押し目買い推奨価格（数値）、それ以外はnull",
      "suggestedStopLossRate": "この銘柄のボラティリティに基づく推奨損切り率（0.01〜0.30の数値。慎重派は狭め）",
      "suggestedTakeProfitRate": "目指すべき推奨利確率（0.05〜1.00の数値。慎重派は控えめ）"
    },
    "BALANCED": {
      "recommendation": "buy" | "stay" | "avoid",
      "confidence": 0.0から1.0の数値（小数点2桁）,
      "statusType": "即時売却" | "戻り売り" | "ホールド" | "押し目買い" | "全力買い",
      "advice": "バランス型向けのアドバイス（100文字以内）",
      "reason": "バランス型の視点での理由（1-2文）",
      "caution": "注意点を1-2文",
      "buyCondition": "recommendationがstayの場合のみ具体的な条件、それ以外はnull",
      "suggestedDipPrice": "recommendationがbuyの場合のみ押し目買い推奨価格（数値）、それ以外はnull",
      "suggestedStopLossRate": "この銘柄のボラティリティに基づく推奨損切り率（0.01〜0.30の数値）",
      "suggestedTakeProfitRate": "目指すべき推奨利確率（0.05〜1.00の数値）"
    },
    "AGGRESSIVE": {
      "recommendation": "buy" | "stay" | "avoid",
      "confidence": 0.0から1.0の数値（小数点2桁）,
      "statusType": "即時売却" | "戻り売り" | "ホールド" | "押し目買い" | "全力買い",
      "advice": "積極派向けのアドバイス（100文字以内）",
      "reason": "積極派の視点での理由（1-2文）",
      "caution": "注意点を1-2文",
      "buyCondition": "recommendationがstayの場合のみ具体的な条件、それ以外はnull",
      "suggestedDipPrice": "recommendationがbuyの場合のみ押し目買い推奨価格（数値）、それ以外はnull",
      "suggestedStopLossRate": "この銘柄のボラティリティに基づく推奨損切り率（0.01〜0.30の数値。積極派は広め）",
      "suggestedTakeProfitRate": "目指すべき推奨利確率（0.05〜1.00の数値。積極派は高め）"
    }
  },

  // D. パーソナライズ（ユーザー設定がある場合）
  "userFitScore": 0-100のおすすめ度,
  "budgetFit": 予算内で購入可能か（true/false）,
  "periodFit": 投資期間にマッチするか（true/false）,
  "riskFit": リスク許容度に合うか（true/false）,
  "personalizedReason": "このユーザーにとってのおすすめ理由（2-3文）"
}

${PROMPT_MARKET_SIGNAL_DEFINITION}

【価格帯予測の指針】
${
  hasPrediction
    ? `
- AI予測データは「参考情報」として扱い、最新のテクニカルデータ・ニュース・市場環境を最優先で判断してください
- 前回の予測と最新データが矛盾する場合は、最新データを優先してください
- 価格帯は前回予測を参考にしつつ、最新のボラティリティや値動きで修正してください
- 前回「上昇」でも直近で下落シグナルが出ている場合は、躊躇なく「下落」や「横ばい」に変更してください`
    : `
- 予測は提供されたテクニカル指標・チャートパターン・ファンダメンタルを根拠として算出する
- 現在価格を起点に、直近ボラティリティ・トレンドを反映した現実的な価格帯にすること
- shortTermPriceLow/High: 直近のボラティリティと今週のトレンドを基準（現在価格±5〜15%を目安）
- midTermPriceLow/High: 中期トレンド・ファンダメンタルを基準（現在価格±10〜25%を目安）
- longTermPriceLow/High: 事業展望・長期トレンドを基準（現在価格±15〜35%を目安）`
}
- 予測レンジが recommendation と整合すること（例: buyならshortTermが上昇傾向）
- advice は価格帯予測の数値を踏まえた具体的なコメントにする（例:「今週は○○〜○○円で推移する見込みで...」）
- 【重要】最近のトレンドや決算情報の好調を過信しすぎず、反落や天井圏の可能性を常に考慮してください。期待がすでに価格に織り込み済み（材料出尽くし）であるリスクがないか慎重に評価してください。
- 【重要】提供された【AI予測データ】が「上昇」となっていても、直近の【株価データ】やテクニカル指標で強い下落・売りシグナルが出ている場合は、安全性を優先し、無理に「買い」を推奨せず "stay" を選んでください。

【重要: この銘柄はまだ購入していません】
- この分析はウォッチリスト（購入検討中）の銘柄に対するものです
- ユーザーはまだこの株を保有していません
- 「損切り」「損切りライン」「利確」「利益確定」「売り時」「売却」「保有株」「含み損」「含み益」など、株を保有している前提の表現は絶対に使わないでください
- 代わりに「購入を検討」「エントリー」「買いのタイミング」「見送り」など、購入前の視点で表現してください

【制約】
${PROMPT_NEWS_CONSTRAINTS}
- 「買い時」「今すぐ買うべき」などの断定的な表現は避け、「検討できる」「検討のタイミング」などの表現を使う
- 赤字企業の場合は concerns で必ず「業績が赤字である」ことに言及し、リスクを伝える
- 赤字かつ減益傾向の場合は、特に慎重な表現を使う
- 専門用語（RSI、MACD、チャートパターン名など）は使ってOKだが、必ず簡単な解説を添える
  例: 「RSI（売られすぎ・買われすぎを判断する指標）が30を下回り…」
  例: 「ダブルボトム（2回底を打って反転する形）が形成され…」
- チャートパターンが検出された場合は、reasonで言及する
- positives、concernsは「・項目1\n・項目2」形式の文字列で返す（配列ではない）
- ユーザー設定がない場合、パーソナライズ項目はnullにする
- 各スタイルのbuyConditionはそのスタイルのrecommendationが"stay"の場合のみ具体的な条件を記載し、"buy"や"avoid"の場合はnullにする
- 各スタイルのsuggestedDipPriceはそのスタイルのrecommendationが"buy"の場合のみ設定し、"stay"や"avoid"の場合はnullにする

【押し目買い推奨価格（suggestedDipPrice）の算出指針】
- recommendationが"buy"の場合、テクニカル分析を総合して「この価格まで下がったら買い」という推奨価格を提案する
- 以下の要素を総合的に考慮して算出すること:
  * 直近のサポートライン（支持線）: 過去の安値が何度も止まった価格帯
  * 25日移動平均線: トレンドの基準
  * 出来高が集中している価格帯: 売買が活発な「需給の壁」
  * フィボナッチリトレースメント: 直近の上昇幅に対する38.2%や50%の押し
- 現在価格より高い値は絶対に設定しないこと
- 現在価格から30%以上乖離する値は設定しないこと

【損切り率・利確率（suggestedStopLossRate / suggestedTakeProfitRate）の算出指針】
- この銘柄を購入した場合に設定すべき損切り率と利確率を、スタイルごとに提案してください
- ボラティリティが高い銘柄 → 損切り率を広めに設定（日々のノイズで刈られないように）
- ボラティリティが低い銘柄 → 損切り率を狭めに設定（効率的なリスク管理）
- スタイル別の目安:
  * 慎重派: 損切り0.03〜0.10、利確0.05〜0.20
  * バランス型: 損切り0.05〜0.15、利確0.10〜0.40
  * 積極派: 損切り0.07〜0.20、利確0.15〜0.50以上
- 購入前の銘柄なので「購入した場合の推奨設定」として算出すること
- recommendationが"avoid"の場合も、参考値として算出すること

【財務指標の活用】
- 財務指標は銘柄の質を評価する参考情報として活用してください
- 財務に懸念点がある場合（割高、ROE低めなど）は、cautionやconcernsで言及してください
- テクニカルが良ければ買い推奨は出せますが、財務リスクは必ず伝えてください

【テクニカル指標の重視】
- RSI・MACD・ローソク足パターンなどのテクニカル指標が提供されている場合は、必ず判断根拠として活用する
- 複数の指標が同じ方向を示している場合（例: RSI売られすぎ + MACD上昇転換）は信頼度を高める
- 指標間で矛盾がある場合（例: RSI買われすぎ だが MACD上昇中）は慎重な判断とし、その旨をcautionで言及する

【相対強度・出来高を考慮した性質判断 - 最重要】
■ 相対強度（銘柄 vs 市場/セクター）で動きを分析してください:
- 銘柄が市場をアンダーパフォーム（例: 市場-1%、銘柄-5%）している場合、銘柄固有の弱さが強く、安値での「拾い買い」は極めて慎重に判断してください（"stay"推奨）。

■ 出来高分析で売り圧力の質を判定してください:
- 分配売り（下落日出来高 > 上昇日出来高の1.5倍以上）: 本物の売り圧力があり、下落は継続しやすく「落ちるナイフ」の状態です。絶対に "buy" を出さないでください。
- 出来高を伴わない調整（下落日出来高 < 上昇日出来高の0.7倍以下）: 売り圧力が弱く、押し目買いの検討が可能です。

【モメンタム（トレンドフォロー）判断 - 重要】
■ 下落トレンドへの対応:
- 直近で強い下落（大陰線、連続下落）がある銘柄は、どれだけファンダメンタルが良くても "buy" ではなく "stay" を推奨する
- 特に短期投資の場合、下落中の銘柄へのエントリーは「落ちるナイフ」を掴むリスクがあるため厳禁
- 週間変化率が-7%以下の銘柄は、短期的には下げ止まりを確認するまで "stay" 推奨
- 下落銘柄にはcautionで「下落トレンド中のリスク」について必ず言及する

■ 上昇トレンドへの対応:
- 直近で強い上昇の兆候がある銘柄はモメンタムが強く、買いの好機である
- ただし週間+30%以上の急騰は天井掴みのリスクがあるため "stay" とし、反落を待つアドバイスをすること
- 逆三尊やダブルボトムなどのチャートパターンが検出されても、出来高が伴っていない場合や市場全体の地合いが悪い場合は「騙し（一時的な反発）」のリスクを必ず指摘してください。

【ねじれ局面（短期down × 長期up）のスイング戦略】
- shortTermTrendが"down"かつlongTermTrendが"up"の場合、単なる"stay"ではなく「安値で拾う戦略」を具体的に提示してください。
- buyConditionに具体的なエントリー価格帯（短期予測安値付近）を必ず記載してください。
  例: 「短期的な調整が予想されます。短期予測安値の¥XXX付近まで引き付けてからエントリーすることで、取得単価を下げ、中長期的な利益率を最大化できます。」
- この局面では全スタイル"stay"とし、buyConditionで具体的な押し目価格と戦略を提示してください。
- 積極派のconfidenceは他スタイルより高めに設定可能です（中長期で上昇が期待できるため）。

【"avoid"（見送り推奨）について】
- "avoid"は購入を見送り、今後の保有候補からも外すことを検討するほど「かなり強いマイナス条件」が揃った場合の判断です。
- 通常の下落トレンドや一時的な悪材料であれば、"avoid"ではなく"stay"（様子見）としてください。
- 以下の条件が複合的に揃い、当面は回復の見込みが極めて低い場合のみ使用してください:
  * 赤字が継続し、業績改善の兆しが全くない
  * 長期的な下落トレンドが継続し、テクニカル指標がすべて強いネガティブ（強い下落シグナル）を示している
  * 致命的な悪材料（上場廃止リスク、不祥事など）が出ている
- "avoid"を選ぶ場合は、confidence を 0.8 以上に設定してください
- 少しでも迷う場合や「今は買い時ではないだけ」の場合は、必ず "stay" を選んでください
`;
}
