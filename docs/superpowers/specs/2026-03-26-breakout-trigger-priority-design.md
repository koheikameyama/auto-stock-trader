# ブレイクアウトトリガー優先順位設計

## 背景

breakout-monitorは1分間隔でウォッチリスト全銘柄をスキャンし、ブレイクアウト条件を満たした銘柄にエントリーする。現状、同一スキャンサイクルで複数トリガーが発火した場合:

- `Promise.all()` で全トリガーを並列実行 → 実行順が非決定的
- 全トリガーが同じ残高スナップショットを見る → レースコンディション（残高の二重消費リスク）

## 目的

1. 同時トリガー時に出来高サージ比率（`volumeSurgeRatio`）が高い銘柄を優先してエントリーする
2. レースコンディションを構造的に解消する

## 設計

### 変更1: `src/core/breakout/breakout-scanner.ts`

`scan()` メソッドの戻り値を `volumeSurgeRatio` 降順でソートして返す。

```typescript
// scan() の return 直前
triggers.sort((a, b) => b.volumeSurgeRatio - a.volumeSurgeRatio);
return triggers;
```

スキャナーの責務として「最も有望なトリガーを先頭に」を保証する。

### 変更2: `src/jobs/breakout-monitor.ts`

`Promise.all(triggers.map(...))` を `for...of` ループに変更し、直列実行にする。

```typescript
// 7. 各トリガーに対してエントリー実行（優先順位順に直列）
for (const trigger of triggers) {
  // 既存のtry/catch処理をそのまま維持
  const result = await executeEntry(trigger, brokerMode);
  // ...エラーハンドリング・Slack通知
}
```

直列化の効果:
- 1件目の `executeEntry` が残高を消費（DB書き込み + ブローカー発注）
- 2件目は `getCashBalance()` で最新の残高を取得 → 残高不足なら自然に弾かれる
- レースコンディションが構造的に解消される

### 変更しないもの

- `src/core/breakout/entry-executor.ts` — 変更なし。既存のリスクチェックがそのまま機能
- `BreakoutTrigger` 型 — 変更なし。既存フィールドで完結
- `BREAKOUT.GUARD.MAX_DAILY_ENTRIES: 3` — 変更なし

## 優先順位の基準

| 順位 | 基準 |
|------|------|
| 1 | `volumeSurgeRatio` 降順（出来高サージ比率が高い銘柄を優先） |

出来高サージ比率が高いほど需給の偏りが強く、ブレイクアウトの信頼度が高い。

## パフォーマンスへの影響

- スイングトレードで1日最大3エントリー → 直列化による遅延は数秒程度で実運用上問題なし
- ソート処理は最大でもウォッチリストサイズ（数十銘柄）程度 → 無視できるコスト

## 対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/core/breakout/breakout-scanner.ts` | `scan()` の戻り値をソート |
| `src/jobs/breakout-monitor.ts` | `Promise.all()` → `for...of` 直列実行 |
