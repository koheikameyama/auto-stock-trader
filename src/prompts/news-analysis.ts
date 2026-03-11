/**
 * ニュース分析プロンプト
 */

import { SECTOR_GROUP_NAMES } from "../lib/constants";

export const NEWS_ANALYSIS_SYSTEM_PROMPT = `あなたは日本株の自動売買システムのニュースアナリストです。
最新のニュースヘッドラインを分析し、市場への影響を構造化して評価します。

【分析の視点】
1. 地政学・マクロリスク: 国際情勢、中央銀行の政策、為替動向、貿易摩擦など
2. セクター影響: 各業種への影響（ポジティブ/ネガティブ/中立）
3. 個別銘柄カタリスト: 決算、経営変更、製品発表、規制変更など

【セクターグループ一覧】
sectorImpactsには以下のセクターグループ名のみを使用してください:
${SECTOR_GROUP_NAMES.join(", ")}

【評価基準】
- geopoliticalRiskLevel: 1=平穏, 2=やや懸念, 3=注視, 4=警戒, 5=危機的
- marketImpact: ニュース全体が市場にとってpositive/neutral/negative
- sectorImpacts: 影響のあるセクターごとに評価（影響がないセクターは含めない）
- stockCatalysts: 個別銘柄に直接影響するニュースがある場合のみ記載
  - type: "positive_catalyst" | "negative_catalyst" | "earnings" | "regulatory"

【重要】
- 客観的な事実に基づいて分析してください
- 具体的なニュースタイトルを引用して根拠を示してください
- 投資助言は行わず、データの整理・分析に徹してください
- ニュースがない場合や判断材料が不十分な場合は、リスクレベル1・neutral と評価してください`;

export const NEWS_ANALYSIS_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "news_analysis",
    strict: true,
    schema: {
      type: "object",
      properties: {
        geopoliticalRiskLevel: {
          type: "number",
          description: "地政学リスクレベル (1-5)",
        },
        geopoliticalSummary: {
          type: "string",
          description: "地政学・マクロ環境の要約",
        },
        marketImpact: {
          type: "string",
          enum: ["positive", "neutral", "negative"],
          description: "ニュース全体の市場インパクト",
        },
        marketImpactSummary: {
          type: "string",
          description: "市場インパクトの説明",
        },
        sectorImpacts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              sector: {
                type: "string",
                enum: SECTOR_GROUP_NAMES,
                description: "セクターグループ名",
              },
              impact: {
                type: "string",
                enum: ["positive", "neutral", "negative"],
                description: "セクターへの影響",
              },
              summary: { type: "string", description: "影響の説明" },
            },
            required: ["sector", "impact", "summary"],
            additionalProperties: false,
          },
        },
        stockCatalysts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tickerCode: {
                type: "string",
                description: "銘柄コード (例: 7203.T)",
              },
              type: {
                type: "string",
                enum: [
                  "positive_catalyst",
                  "negative_catalyst",
                  "earnings",
                  "regulatory",
                ],
                description: "カタリストのタイプ",
              },
              summary: { type: "string", description: "カタリストの説明" },
            },
            required: ["tickerCode", "type", "summary"],
            additionalProperties: false,
          },
        },
        keyEvents: {
          type: "string",
          description: "本日注目すべき主要イベント・ニュースの要約",
        },
      },
      required: [
        "geopoliticalRiskLevel",
        "geopoliticalSummary",
        "marketImpact",
        "marketImpactSummary",
        "sectorImpacts",
        "stockCatalysts",
        "keyEvents",
      ],
      additionalProperties: false,
    },
  },
};
