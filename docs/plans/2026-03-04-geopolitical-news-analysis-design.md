# 地政学・マクロニュース分析機能 設計書

## 概要

地政学リスク（関税、制裁、紛争など）やマクロ経済ニュース（金融政策、為替など）を分析し、どのセクターにどのような影響を与えるかを可視化する機能。

## 方針

- 既存のMarketNews + SectorTrendパイプラインに統合（専用テーブルは作らない）
- RSSキーワード拡張 + AI分析スキーマ拡張で対応
- DB容量500MB制約を考慮し、最小限のカラム追加に留める

## 1. データモデル

### MarketNews テーブルへのカラム追加

```prisma
model MarketNews {
  // ... 既存カラム ...

  category        String   @default("stock")  // "stock" | "geopolitical" | "macro"
  impactSectors   String?                      // JSON配列 e.g. '["半導体・電子部品","自動車"]'
  impactDirection String?                      // "positive" | "negative" | "mixed"
  impactSummary   String?  @db.Text            // AI生成の影響説明（1-2文）

  @@index([category])
}
```

- `category`: ニュースの分類。既存は全て `"stock"`
- `impactSectors`: 1ニュースが影響する複数セクター（JSON配列文字列）
- `impactDirection`: 市場全体への影響方向
- `impactSummary`: 初心者向けの影響サマリー

## 2. ニュース取得パイプライン

### 2.1 RSS検索キーワード拡張

`fetch-news.ts` / `fetch-us-news.ts` に地政学・マクロ系キーワードを追加:

**日本語**: 関税, 制裁, 地政学, 戦争, 紛争, 米中, OPEC, 金融政策, 利上げ, 利下げ, 為替, 円安, 円高, 地震, 台風
**英語**: tariff, sanctions, geopolitical, war, conflict, OPEC, Fed, rate hike, rate cut, earthquake

### 2.2 AI分析スキーマ拡張

`analyzeWithOpenAI` の出力スキーマを拡張:

```json
{
  "is_stock_related": true,
  "is_market_impact": true,
  "category": "stock|geopolitical|macro",
  "sector": "セクター名",
  "sentiment": "positive|negative|neutral",
  "impact_sectors": ["セクター1", "セクター2"],
  "impact_direction": "positive|negative|mixed",
  "impact_summary": "影響の簡潔な説明",
  "ticker_codes": ["7203"]
}
```

### 2.3 保存フロー変更

```
Before: is_stock_related=false → 破棄
After:
  is_stock_related=false && is_market_impact=false → 破棄
  is_stock_related=false && is_market_impact=true  → category="geopolitical"/"macro" で保存
  is_stock_related=true                            → category="stock" で保存（従来通り）
```

## 3. ニュース一覧UI

### 3.1 フィルター拡張

```
現在: ALL | JP | US
変更: ALL | JP | US | 市場影響
```

APIパラメータ: `category=impact` で `category IN ("geopolitical", "macro")` を取得。

### 3.2 ニュースカード拡張

市場影響ニュースの場合、カードに追加表示:

- `[⚠️ 市場影響]` バッジ
- 影響セクターバッジ（impactSectors）
- impactSummary（1行）

```
┌─────────────────────────────────────────┐
│ 🌍 米、中国半導体への追加関税を検討      │
│ 米政府は中国向け半導体輸出規制を強化...   │
│                                         │
│ [⚠️ 市場影響] [ネガティブ]                │
│ 影響: 半導体・電子部品, 自動車            │
│ → 中国向け輸出依存のセクターに逆風        │
│                                    2時間前│
└─────────────────────────────────────────┘
```

## 4. ダッシュボード「地政学・マクロリスク」カード

### 4.1 配置

セクタートレンドヒートマップの直上。

### 4.2 表示内容

```
┌─────────────────────────────────────────┐
│ 🌍 地政学・マクロリスク    ⚠️ 注意       │
│                                         │
│ 米中半導体規制 → 半導体, 自動車 に逆風   │
│ 日銀利上げ観測 → 銀行業 に追い風          │
│                                         │
│                         ▼ 詳細を見る     │
└─────────────────────────────────────────┘
```

- 直近3日以内の `category IN ("geopolitical", "macro")` ニュース最大3件
- 該当なし → 「現在、大きな地政学リスクはありません」
- リスクレベルバッジ:
  - 0件 → `安定`（緑）
  - 1-2件 neutral → `注意`（黄）
  - 3件以上 or negative多数 → `警戒`（赤）
- 「詳細を見る」→ ニュースページ（市場影響フィルター）へ遷移

### 4.3 API

`GET /api/news/geopolitical` — 直近3日の地政学・マクロニュースを取得（最大5件）。

## 5. セクタートレンド連動

### 5.1 calculate-sector-trends.ts の変更

MarketNewsからニュースを集計する際、`impactSectors` も展開して集計対象に含める:

```
通常ニュース: sector="半導体・電子部品" → 半導体セクターに+1
地政学ニュース: impactSectors=["半導体・電子部品","自動車"]
  → 半導体セクターに+1, 自動車セクターに+1
```

重み付けは通常ニュースと同じ（特別扱いしない）。

## 6. i18n

新規文言は全て `messages/ja.json` に定義:

- フィルターラベル: 「市場影響」
- リスクレベル: 「安定」「注意」「警戒」
- ダッシュボードカードのタイトル・説明
- impactDirection: 「追い風」「逆風」「影響あり」

## 7. 影響範囲

| ファイル | 変更内容 |
|---------|---------|
| `prisma/schema.prisma` | MarketNewsにカラム追加 |
| `scripts/news/fetch-news.ts` | キーワード追加 + AI分析拡張 + 保存ロジック変更 |
| `scripts/news/fetch-us-news.ts` | 同上 |
| `scripts/news/calculate-sector-trends.ts` | impactSectors展開集計 |
| `app/api/news/route.ts` | categoryフィルター対応 |
| `app/api/news/geopolitical/route.ts` | 新規API |
| `app/news/NewsPageClient.tsx` | フィルター追加 + カード拡張 |
| `app/dashboard/page.tsx` | GeopoliticalRiskCardセクション追加 |
| `app/dashboard/GeopoliticalRiskCard.tsx` | 新規コンポーネント |
| `lib/news.ts` | クエリ関数追加 |
| `messages/ja.json` | i18n文言追加 |
| `docs/specs/news.md` | 仕様書更新 |
| `docs/specs/dashboard.md` | 仕様書更新 |
