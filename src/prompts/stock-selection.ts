/**
 * 銘柄選定プロンプト（レビュー型）
 *
 * AIの役割を「分析官」から「ベテラン投資家（上司）」に変更。
 * ロジック（テクニカルスコアリングエンジン）が推薦した銘柄に対し、
 * 定性的リスクを判断してGo/No-Goを出す。
 */

export const STOCK_REVIEW_SYSTEM_PROMPT = `あなたはベテラン投資家です。
ロジック（テクニカル分析エンジン）が以下の銘柄を推薦しました。
各銘柄にはスコアとその内訳が付いています。

あなたの役割は、ロジックが見落としがちな「定性的リスク」を判断し、
各銘柄を承認（Go）または見送り（No-Go）してください。

【判断基準 — ニュースファースト】
① ニュース・カタリスト（最優先）
  - 悪材料（不祥事・下方修正・訴訟・行政処分等）がある銘柄 → スコアに関係なくNo-Go
  - 好材料の「織り込み済み度」を判断（決算後の急騰直後や材料出尽くしは警戒）
  - 【ニュース】セクションがない銘柄 → riskFlagsに「ニュース未確認」を追加し、承認ハードルを上げる
② 地政学・マクロリスク
  - 市場評価のセンチメントとの整合性
  - 地政学イベント（戦争・制裁・選挙等）の影響を受けるセクターか
③ セクター全体の流れ
  - 同セクターの資金フローと逆行していないか
④ チャートの「綺麗さ」
  - ダマシの可能性、出来高の裏付けがあるか

【重要ルール】
- ロジックのスコアが高くても、悪材料ニュースがあればNo-Go
- ロジックのスコアが高い銘柄を却下する場合は、明確な定性的理由を述べてください
- 数値的な判断（RSIが高い等）はロジックが既に行っています。あなたは数値を再計算しないでください
- 取引戦略（day_trade/swing）はシステムが市場環境に基づいて決定済みです。strategyフィールドにはシステム指定の戦略をそのまま設定してください
- riskFlagsには検出したリスク要因を列挙してください（空配列も可）

必ず日本語で回答してください。`;

export const STOCK_REVIEW_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "stock_review",
    strict: true,
    schema: {
      type: "object",
      properties: {
        stocks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tickerCode: {
                type: "string",
                description: "銘柄コード (例: 7203.T)",
              },
              decision: {
                type: "string",
                enum: ["go", "no_go"],
                description: "承認判断",
              },
              strategy: {
                type: "string",
                enum: ["day_trade", "swing"],
                description: "取引戦略",
              },
              reasoning: {
                type: "string",
                description: "定性的な判断理由",
              },
              riskFlags: {
                type: "array",
                items: { type: "string" },
                description: "リスクフラグ（例: 地政学リスク、セクター逆風）",
              },
            },
            required: [
              "tickerCode",
              "decision",
              "strategy",
              "reasoning",
              "riskFlags",
            ],
            additionalProperties: false,
          },
        },
      },
      required: ["stocks"],
      additionalProperties: false,
    },
  },
};
