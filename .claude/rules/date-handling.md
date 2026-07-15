# 日付・時刻の扱い

**日付の保存・取得はJST（日本時間）00:00を基準に統一してください。**

## 方針

- **DBにはUTC形式で保存**される
- **日付の境界はJST 00:00:00**（日本時間の深夜0時で日付が変わる）
- 共通ユーティリティ `lib/market-date.ts` を使用する（日付変換＋営業日判定を統合）

## なぜJST基準か

- 日本株を扱うアプリなので、JSTで日付を区切るのが自然
- ユーザーが「今日のおすすめ」と言ったらJSTの今日を期待する
- 市場の営業日もJST基準

## 日付・時刻操作ライブラリ

**日付・時刻の処理は必ず dayjs を使用してください（TypeScript）。**

- TypeScript: `dayjs` + `dayjs/plugin/utc` + `dayjs/plugin/timezone`
- Python: `datetime` + `zoneinfo`
- 生の `Date` コンストラクタやタイムゾーン手動計算は使わない
- `new Date()` は現在時刻の取得（createdAt等）のみ許可。それ以外の日時操作は dayjs を使う
- `Date.now()` / `new Date(timestamp)` を直接使った比較・加減算は禁止

## 共通ユーティリティ

```typescript
// lib/market-date.ts
import { getTodayForDB, getDaysAgoForDB } from "@/lib/market-date";

// 今日の日付（JST基準、UTC 00:00として保存）
const today = getTodayForDB();
// 例: JST 2024-06-10 → 2024-06-10T00:00:00.000Z → DB: 2024-06-10

// N日前の日付
const sevenDaysAgo = getDaysAgoForDB(7);
```

```python
# Python版: scripts/lib/date_utils.py
from scripts.lib.date_utils import get_today_for_db, get_days_ago_for_db

today = get_today_for_db()
seven_days_ago = get_days_ago_for_db(7)
```

## 仕組み

`@db.Date` カラムにJSTの日付を正しく保存するため、JST日付をそのまま UTC 00:00 の Date オブジェクトとして作成する。

```text
JST 2/19 → new Date("2026-02-19T00:00:00Z") → PostgreSQL date型: 2026-02-19
```

## ⚠️ 前提: DBセッションのタイムゾーンは UTC

上記の設計は **DBセッションの TimeZone が UTC であること**に依存している。`@db.Date` を JS の Date（UTC 0時）と**等値比較**するクエリ（`calculateMarketBreadth(asOfDate)` / `MarketAssessment.findUnique({ date })` 等）は、セッションが `Asia/Tokyo` だと `date` が `2026-02-19 00:00+09` = `2026-02-18T15:00Z` に変換されて**一致せず 0件を返す**。

- **本番 (Railway)**: `Etc/UTC`（postgresql.conf）→ 正常
- **ローカル (Homebrew の既定)**: `Asia/Tokyo` → 壊れる。**2026-07-15 (KOH-554) に `auto_stock_trader` だけ UTC へ揃え済み**

新しい環境をセットアップする時は以下を実行する（サーバ全体ではなくDB個別に設定し、他プロジェクトのDBに影響させない）:

```sql
ALTER DATABASE auto_stock_trader SET timezone = 'Etc/UTC';  -- 新規接続から有効
```

**「DBにデータがあるのに 0件が返る」時はまず `SHOW timezone;` を疑うこと。** 壊れるのは等値比較だけで、範囲比較（`gte`/`lte`）は9時間ずれても境界日以外は当たるため、BT のように範囲取得しかしないコードは無事に見えてしまい原因が分かりにくい。

## ✅ 良い例

```typescript
import { getTodayForDB, getDaysAgoForDB } from "@/lib/market-date";

// DB保存
await prisma.dailyFeaturedStock.create({
  data: {
    date: getTodayForDB(),
    stockId: stock.id,
  },
});

// DB検索
const recommendations = await prisma.userDailyRecommendation.findMany({
  where: {
    date: getTodayForDB(),
  },
});

// 範囲検索
const recentData = await prisma.purchaseRecommendation.findFirst({
  where: {
    date: { gte: getDaysAgoForDB(7) },
  },
});
```

## ❌ 悪い例

```typescript
// JST→UTC変換してからtoDate() - date型で1日ズレる
const today = dayjs().tz("Asia/Tokyo").startOf("day").utc().toDate();

// UTC 00:00を使用 - JSTと9時間ずれる
const today = dayjs.utc().startOf("day").toDate();

// 生のDateを使用 - タイムゾーンが曖昧
const today = new Date();
today.setHours(0, 0, 0, 0);
```

## 対象テーブル

以下のテーブルは `@db.Date` 型で日付を保存しており、JST基準で統一：

- `SectorTrend.date` - セクタートレンド
- `DailyFeaturedStock.date` - 今日の注目銘柄
- `PurchaseRecommendation.date` - 購入判断
- `UserDailyRecommendation.date` - あなたへのおすすめ
- `DailyMarketMover.date` - 上昇/下落ランキング
- `DailyAIReport.date` - AI精度レポート
- `WeeklyAIReport.weekStart / weekEnd` - 週次レポート

## 注意事項

- **タイムスタンプ（createdAt, updatedAt等）**: `new Date()` でOK（現在時刻なのでTZ関係なし）
- **日付フィールド（@db.Date型）**: 必ず `getTodayForDB()` を使用
- **日付フォーマット表示**: `dayjs().tz("Asia/Tokyo").format("YYYY-MM-DD")`
- **スタンドアロンスクリプト**: `getTodayForDB` をインポートできない場合は `new Date(Date.UTC(year, month, date))` パターンを使用
