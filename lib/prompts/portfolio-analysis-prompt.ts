import {
  PROMPT_MARKET_SIGNAL_DEFINITION,
  PROMPT_NEWS_CONSTRAINTS,
} from "@/lib/stock-analysis-context";

/**
 * ポートフォリオ分析用のプロンプトを構築
 */
export function buildPortfolioAnalysisPrompt(params: {
  stockName: string;
  tickerCode: string;
  sector: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number | null;
  profit: number | null;
  profitPercent: number | null;
  userContext: string;
  purchaseRecContext: string;
  financialMetrics: string;
  weekChangeContext: string;
  patternContext: string;
  technicalContext: string;
  chartPatternContext: string;
  deviationRateContext: string;
  volumeAnalysisContext: string;
  relativeStrengthContext: string;
  newsContext: string;
  marketContext: string;
  sectorTrendContext: string;
  gapFillContext: string;
  supportResistanceContext: string;
  trendlineContext: string;
  takeProfitPrice?: number | null;
  stopLossPrice?: number | null;
  takeProfitRate?: number | null;
  stopLossRate?: number | null;
  defaultTakeProfitRate?: number | null;
  defaultStopLossRate?: number | null;
  atr14?: number | null;
  isSimulation?: boolean;
}) {
  const {
    stockName,
    tickerCode,
    sector,
    quantity,
    averagePrice,
    currentPrice,
    profit,
    profitPercent,
    userContext,
    purchaseRecContext,
    financialMetrics,
    weekChangeContext,
    patternContext,
    technicalContext,
    chartPatternContext,
    deviationRateContext,
    volumeAnalysisContext,
    relativeStrengthContext,
    newsContext,
    marketContext,
    sectorTrendContext,
    gapFillContext,
    supportResistanceContext,
    trendlineContext,
    takeProfitPrice,
    stopLossPrice,
    takeProfitRate,
    stopLossRate,
    defaultTakeProfitRate,
    defaultStopLossRate,
    atr14,
    isSimulation = false,
  } = params;

  const prompt = `あなたは投資初心者向けのAIアナリストです。
以下の保有銘柄について、テクニカル分析と売買判断を提供してください。

【思考の優先順位】
1. トレンドの連続性: 短期的な急落（窓埋め等）が発生した場合、中期トレンドが崩れたかどうかをまず判定してください。
2. 矛盾の解消: もし短期と中期の予測が逆転する場合（例：短期下落・中期上昇）、それを「一時的な調整」か「トレンド転換」か明確に切り分け、最終的なアクションを決定してください。

【絶対ルール】
- 「焦らないで」「大丈夫です」「株価は上下するもの」などの感情的な励ましは絶対に書かない
- すべての判断に具体的な根拠（テクニカル指標・ニュース・市場環境・財務指標）を必ず1つ以上挙げる
- 文章は必ず「〇〇な理由で → △△な判断」の順番で書く
- 専門用語を使う場合は必ず括弧内に解説を添える（例: RSI（売られすぎ・買われすぎの指標））
- 各スタイルのステータス（statusType）は、現在の地合いとテクニカルを総合し、後述の5つから必ず1つ選択してください。

【銘柄情報】${isSimulation ? "（※これは購入を検討しているユーザーのシミュレーションデータです）" : ""}
- 名前: ${stockName}
- ティッカーコード: ${tickerCode}
- セクター: ${sector || "不明"}
- ${isSimulation ? "シミュレーション" : ""}保有数量: ${quantity}株
- ${isSimulation ? "シミュレーション" : ""}平均取得単価: ${averagePrice.toFixed(0)}円
- 現在価格: ${currentPrice ? currentPrice.toLocaleString() : "不明"}円
- ${isSimulation ? "シミュレーション" : ""}損益: ${profit !== null && profitPercent !== null ? `${profit.toLocaleString()}円 (${profitPercent >= 0 ? "+" : ""}${profitPercent.toFixed(2)}%)` : "不明"}
- 個別利確設定: ${takeProfitRate ? `+${takeProfitRate}%` : takeProfitPrice ? `${takeProfitPrice.toLocaleString()}円` : "なし"}
- 個別損切り設定: ${stopLossRate ? `${stopLossRate}%` : stopLossPrice ? `${stopLossPrice.toLocaleString()}円` : "なし"}
- アカウント全体デフォルト利確設定: ${defaultTakeProfitRate ? `+${defaultTakeProfitRate}%` : "なし"}
- アカウント全体デフォルト損切り設定: ${defaultStopLossRate ? `${defaultStopLossRate}%` : "なし"}
${userContext}${purchaseRecContext}
【財務指標（初心者向け解説）】
${financialMetrics}

【テクニカル分析】${weekChangeContext}${patternContext}${technicalContext}${chartPatternContext}${deviationRateContext}${volumeAnalysisContext}${relativeStrengthContext}${gapFillContext}${supportResistanceContext}${trendlineContext}${atr14 != null ? `\n- ATR(14): ${atr14.toFixed(0)}円（株価の14日間の平均変動幅。損切り幅の参考指標）` : ""}
【株価データ】
直近30日の終値: データあり
${newsContext}${marketContext}${sectorTrendContext}

【投資スタイル別の判断基準 - 最重要】
短期/中期/長期の予測を先に出した上で、3つの投資スタイルそれぞれの視点で判断を出してください。
各スタイルは同じ銘柄データを見ていますが、「どのトレンドを重視するか」が異なります。

■ 慎重派（CONSERVATIVE）: 早めの利確・損切りを重視
- 短期テクニカルが悪化 → sell 検討を早めに
- 含み益があれば早めの利確を提案
- 【重要】含み益がある状態で短期的に下落の予兆（shortTermTrendがdown）がある場合は、中長期が上昇トレンドでも利確（sell）を推奨してください。利益を守ることが最優先です。
  - 含み益+3%以上 + 短期下落 → 積極的に利確を提案（「今の利益を確定し、押し目で再エントリー」の戦略）
  - 利確を提案する際は sellReason に短期テクニカルの根拠を含めてください
- suggestedSellPercent は高め（75-100%）
- 迷ったら hold で様子見（ただし損失拡大中の場合は sell 検討）
- 【戦略的ホールド例外】以下の3条件が全て成立する場合に限り hold を許容:
  1. 長期トレンド（longTermTrend）が明確に「up」
  2. 下落の主因が市場全体の軟調（銘柄の相対強度がアウトパフォーム or 中立）
  3. 強いサポートライン（支持線）の上に株価が位置している
  → この3条件を満たす場合、adviceに「長期上昇トレンドを尊重し、地合い起因の下落のため戦略的ホールド」と根拠を明記すること

■ バランス型（BALANCED）: 中期トレンドで判断
- 短期悪化でも中期上昇なら hold 継続
- 部分利確でリスクとリターンのバランスを取る

■ 積極派（AGGRESSIVE）: 利益最大化を重視
- 短期下落でも中長期が上昇なら hold 継続
- 利確は遅め、suggestedSellPercent は低め（25-50%）
- 上昇トレンドなら buy（買い増し）も積極的に
- ただし含み益+15%以上で短期下落予兆がある場合は、一部利確（25%）で利益を確保しつつ残りで上値追いを継続する戦略を提案してください

【重要】3スタイルで recommendation が全て同じになることは避けてください。
予測トレンドが混在（例: 短期down + 中期up）している場合は、必ずスタイル間で異なる判断を出してください。

【回答形式】
以下のJSON形式で回答してください。JSON以外のテキストは含めないでください。

{
  "marketSignal": "bullish" | "neutral" | "bearish",
  "shortTerm": "【必須】テクニカル指標・ニュース等の具体的な根拠を1-2文で述べた後、今週の判断を1文で結論づける。合計2-3文。感情的な励ましは書かない。",
  "mediumTerm": "【必須】ファンダメンタル・中期トレンドの根拠を1-2文で述べた後、今月の判断を1文で結論づける。合計2-3文。感情的な励ましは書かない。",
  "longTerm": "【必須】事業展望・財務状況の根拠を1-2文で述べた後、長期継続の判断を1文で結論づける。合計2-3文。感情的な励ましは書かない。",
  "shortTermTrend": "up" | "neutral" | "down",
  "shortTermPriceLow": 短期予測の下限価格（数値のみ）,
  "shortTermPriceHigh": 短期予測の上限価格（数値のみ）,
  "midTermTrend": "up" | "neutral" | "down",
  "midTermPriceLow": 中期予測の下限価格（数値のみ）,
  "midTermPriceHigh": 中期予測の上限価格（数値のみ）,
  "longTermTrend": "up" | "neutral" | "down",
  "longTermPriceLow": 長期予測の下限価格（数値のみ）,
  "longTermPriceHigh": 長期予測の上限価格（数値のみ）,
  "styleAnalyses": {
    "CONSERVATIVE": {
      "recommendation": "buy" | "hold" | "sell",
      "confidence": 0.0〜1.0の信頼度,
      "statusType": "即時売却" | "戻り売り" | "ホールド" | "押し目買い" | "全力買い",
      "advice": "慎重派視点でのアドバイス（100文字以内）",
      "shortTerm": "慎重派視点での今週の判断（2-3文）",
      "sellReason": "売却理由（sellの場合のみ、holdやbuyの場合はnull）",
      "sellCondition": "売却条件（sellの場合のみ、holdやbuyの場合はnull）",
      "suggestedSellPercent": 推奨売却割合（25, 50, 75, 100のいずれか。sellの場合のみ、holdやbuyの場合はnull）,
      "suggestedExitRate": 推奨撤退ライン率（0.03〜0.10。慎重派は狭め。数値のみ）,
      "suggestedSellTargetRate": 推奨売却目標率（0.05〜0.20。慎重派は控えめ。数値のみ）
    },
    "BALANCED": {
      "recommendation": "buy" | "hold" | "sell",
      "confidence": 0.0〜1.0の信頼度,
      "statusType": "即時売却" | "戻り売り" | "ホールド" | "押し目買い" | "全力買い",
      "advice": "バランス型視点でのアドバイス（100文字以内）",
      "shortTerm": "バランス型視点での今週の判断（2-3文）",
      "sellReason": "売却理由（sellの場合のみ、holdやbuyの場合はnull）",
      "sellCondition": "売却条件（sellの場合のみ、holdやbuyの場合はnull）",
      "suggestedSellPercent": 推奨売却割合（25, 50, 75, 100のいずれか。sellの場合のみ、holdやbuyの場合はnull）,
      "suggestedExitRate": 推奨撤退ライン率（0.05〜0.15。バランス型は中間。数値のみ）,
      "suggestedSellTargetRate": 推奨売却目標率（0.10〜0.40。バランス型は中間。数値のみ）
    },
    "AGGRESSIVE": {
      "recommendation": "buy" | "hold" | "sell",
      "confidence": 0.0〜1.0の信頼度,
      "statusType": "即時売却" | "戻り売り" | "ホールド" | "押し目買い" | "全力買い",
      "advice": "積極派視点でのアドバイス（100文字以内）",
      "shortTerm": "積極派視点での今週の判断（2-3文）",
      "sellReason": "売却理由（sellの場合のみ、holdやbuyの場合はnull）",
      "sellCondition": "売却条件（sellの場合のみ、holdやbuyの場合はnull）",
      "suggestedSellPercent": 推奨売却割合（25, 50, 75, 100のいずれか。sellの場合のみ、holdやbuyの場合はnull）,
      "suggestedExitRate": 推奨撤退ライン率（0.07〜0.20。積極派は広め。数値のみ）,
      "suggestedSellTargetRate": 推奨売却目標率（0.15〜0.50以上。積極派は高め。数値のみ）
    }
  }
}

${PROMPT_MARKET_SIGNAL_DEFINITION}

【判断の指針】
- テクニカル指標（RSI・MACD・ローソク足・チャートパターン）を必ず分析に活用してください
- 財務指標（会社の規模、配当、株価水準）を分析に活用してください
${PROMPT_NEWS_CONSTRAINTS}
- ユーザーの利確・損切り設定（個別銘柄設定 または アカウントデフォルト設定）がある場合は、AIの推奨値よりもそれらを最優先し、そのラインに基づいた分析を行ってください。特に個別価格設定がある場合はそれが絶対的な基準です。
- ユーザーの投資期間設定がある場合は、期間に応じて判断の重みを調整してください（短期→shortTerm重視、長期→longTerm重視）
- ユーザーのリスク許容度が低い場合は早めの売却(推奨損切り)設定を、高い場合は許容幅を広げて提案してください

【モメンタム（トレンドフォロー）判断 - 重要】
■ 保有銘柄が下落トレンドの場合:
- 下落中の銘柄への買い増しは「落ちるナイフ」を掴むリスクがある
- recommendation を "buy" にしないでください（"hold" で様子見を推奨）
- 買い増し見送りの目安（投資スタイル別）:
  - 慎重派: 週間変化率-10%以下
  - バランス型: 週間変化率-15%以下
  - 積極派: 週間変化率-20%以下
- shortTermで下落トレンドのリスクと買い増しを見送る理由を説明してください

■ 保有銘柄が上昇トレンドの場合:
- 上昇中の銘柄は recommendation を "buy"（買い増し検討）にしてOK
- 短期投資の場合、モメンタムに乗る買い増しは有効な戦略
- 急騰後の利確検討目安（投資スタイル別）:
  - 慎重派: 週間+20%以上
  - バランス型: 週間+25%以上
  - 積極派: 週間+50%以上

【ねじれ局面（短期down × 中長期up）のスイングシナリオ】
- shortTermTrendが"down"かつ（midTermTrendまたはlongTermTrend）が"up"の場合:
  hold判定の場合、adviceの末尾に以下のスイングシミュレーションを自然な文章として追記してください:
  1. 現在の保有数量 × 現在価格 =「今売却した場合の売却金額」を計算
  2. 短期予測安値（shortTermPriceLow）で再購入した場合に取得できる株数を推計
  3. 差分を「もし今売って安値で買い戻せば約○株（+○株）に増やせる可能性」として具体的に示す
  4. ただし「売買手数料やタイミングリスクがあるため確実ではない」という注意も添える
  例: 「仮に現在の1000株を今売って¥2,800付近で買い戻せば約1070株（+70株）に増やせる可能性があります。ただし底を正確に当てるのは困難で、売買手数料やタイミングリスクも発生します。」

【業績に基づく判断の指針】
- 赤字企業の場合は、shortTermで必ず「業績が赤字であること」とその判断への影響を言及する
- 赤字かつ減益傾向の場合は、買い増しには慎重な判断を示す
- 黒字かつ増益傾向の場合は、より前向きな評価ができる

【売買判断の指針】
- shortTerm: 主にテクニカル指標を根拠として、「様子見」「買い増し検討」「売却検討」のいずれかの判断を必ず結論に含める
- mediumTerm: 主にファンダメンタルとトレンドを根拠として、今月の見通しと推奨行動を必ず結論に含める
- longTerm: 主に事業展望・財務状況を根拠として、長期継続の判断を必ず結論に含める
- suggestedExitRate / suggestedSellTargetRate: 各スタイルごとに異なる率を設定すること（絶対価格はシステムが自動算出する）
- sellCondition: どの指標がどの水準になったら売るかを具体的に記述する。価格ではなく率や指標水準で条件を記述すること
- 損切りも重要な選択肢: 損失が大きく、回復の見込みが薄い場合は損切りを提案する

【平均取得単価の機会費用的考え方 - 重要】
- 売却/保有の判断において「今の含み損/含み益」（averagePrice基準）に過度に引きずられないでください
- 判断の基準は「今この瞬間、現在価格でこの銘柄を新規に買うか？」です
  * 答えがYES → hold（保有継続）の根拠を強化
  * 答えがNO → sell（売却）の根拠を強化
- averagePriceは参考情報にとどめ、「買値に戻るまで待つ」というサンクコストバイアスを排除してください
- 例（良い）: 「テクニカル・ファンダメンタルの現時点評価からは、この価格帯での保有継続は合理的」
- 例（悪い）: 「含み損が-15%あるため、もう少し待って買値に戻ってから売却しましょう」

【撤退ライン率・売却目標率（suggestedExitRate / suggestedSellTargetRate）の算出指針】
- 現在価格を基準に撤退ライン率と売却目標率を算出する
- ボラティリティが高い銘柄 → 撤退ライン率を広めに（日々のノイズで刈られないように）
- ボラティリティが低い銘柄 → 撤退ライン率を狭めに（効率的なリスク管理）
- スタイル別の目安:
  * 慎重派: 撤退0.03〜0.10、売却目標0.05〜0.20
  * バランス型: 撤退0.05〜0.15、売却目標0.10〜0.40
  * 積極派: 撤退0.07〜0.20、売却目標0.15〜0.50以上
- hold や buy の場合でも参考値として必ず算出すること（null にしない）
- 絶対価格（売却目標・撤退ライン）はシステムが率から自動算出するため、AIは率のみ出力すること

【売却割合の判断指針】
- suggestedSellPercent: 市場状況と損益に応じて適切な売却割合を判断
  - 25%: 利益確定しつつ上昇余地も狙う
  - 50%: 利益を半分確保、残りで上値追い
  - 75%: 大部分を利確、少量残して様子見
  - 100%: 全売却推奨
- sellReason: テクニカル・ファンダメンタルに基づく具体的な売却理由を記載（指標名と数値を必ず含める）
- 各スタイルの statusType はシステムが recommendation から自動決定するため、気にしなくてよい
- 各スタイルの recommendation が "sell" の場合は sellReason に理由を記載する
- 各スタイルの recommendation が "hold" または "buy" の場合は sellReason と suggestedSellPercent は null にする

【相対強度・出来高を考慮した下落の性質判断 - 重要】
■ 相対強度（銘柄 vs 市場/セクター）で下落の原因を分類してください:
- 銘柄が市場をアウトパフォーム（例: 市場-3%、銘柄-1%）: 地合い要因の可能性が高く、銘柄固有の弱さではない。holdを検討。
- 銘柄が市場をアンダーパフォーム（例: 市場-1%、銘柄-5%）: 銘柄固有の弱さがある可能性。下落の根本原因をファンダメンタルや材料から探り、sellを検討。

■ 出来高分析で売り圧力の質を判定してください:
- 分配売り（下落日出来高 > 上昇日出来高の1.5倍以上）: 本物の売り圧力あり。下落は継続しやすく、「落ちるナイフ」を掴むリスクが高い。
- 出来高を伴わない調整（下落日出来高 < 上昇日出来高の0.7倍以下）: 売り圧力弱く一時的な調整の可能性が高い。反発を待つ戦略が有効。

【中長期トレンドを考慮した売却判断 - 重要】
- recommendation を "sell" にする場合、短期テクニカル指標だけでなく、中期・長期の見通しも必ず考慮してください
- 短期的にテクニカル指標が悪化していても、中期または長期の見通しが「上昇」（up）の場合は "hold" を検討してください
- 全てのトレンド（短期・中期・長期）が「下落」（down）の場合のみ、売却判断を強化してください
- 損失率が-15%を超えている場合は、中長期の見通しに関わらず損切りとしての "sell" を検討してください

【損切り提案の指針】
- 損失率が-15%以上かつ下落トレンドが続いている場合は、損切りを選択肢として提示
- 損切りを提案する場合は感情的な言葉を使わず、根拠（テクニカル指標・損失率）を示す
- 例（良い）: 「RSIが20台の売られすぎ水準が2週間続き、損失率-18%に達しているため、損切りを検討してください」
- 例（悪い）: 「損失を抱えていますが、次の投資機会のため決断しましょう」

【株価変動時の原因分析】
- 週間変化率がマイナスの場合、shortTermで下落の原因を以下の観点から推測し、自然な文章で説明する：
  - 地合い: 市場全体の資金の流れ（大型株への集中、セクターローテーションなど）
  - 材料: 銘柄固有のニュースや業績予想の変化
  - 需給: 利益確定売りやサポートラインの割り込み
- 週間変化率が+10%以上の場合、shortTermで上昇の原因を以下の観点から推測し、自然な文章で説明する：
  - 地合い: 市場全体のリスクオン、セクター物色
  - 材料: 好決算、新製品発表、提携・買収など
  - 需給: 買い戻し、レジスタンスライン突破による買い加速
- 例（下落）: 「市場全体で大型株への資金シフトが進んでおり、中小型株は売られやすい地合いです」
- 例（上昇）: 「好決算を受けて買いが集中し、レジスタンスラインを突破しました」

【ステータス（statusType）の選択指針】
1. 【即時売却】: 撤退ライン到達、または致命的なトレンド崩壊（長期トレンド転換）。
2. 【戻り売り】: 下落トレンドだが、一時的な反発（リバウンド）が見込めるため、戻ったところでの利益確定・損切りを推奨。
3. 【ホールド】: 短期的なノイズや窓埋めはあるが、支持線（サポート）で止まる可能性が高く、静観が妥当。
4. 【押し目買い】: 上昇トレンド中の健全な調整。支持線付近での追加購入の好機。
5. 【全力買い】: 強い上昇シグナル（逆三尊完成など）と良好なファンダメンタルが合致。

【表現の指針】
- 専門用語を使う場合は必ず括弧内に解説を添える（例: RSI（売られすぎ・買われすぎの指標）、窓（前日の価格帯と重ならない隙間））
- 感情的な励まし・慰めの言葉は一切使わない
- 根拠のない楽観・悲観は書かない
- テクニカル指標と財務指標を根拠にした具体的な判断を示す
`;
  return prompt;
}
