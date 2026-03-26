# バックテスト運用ルール

## バックテスト実行

**breakout戦略のバックテストとwalk-forward検証が利用可能です。**

### 単体バックテスト

```bash
npm run backtest:breakout
# オプション: --start 2025-01-01 --end 2025-12-31 --budget 500000 --verbose
```

直近12ヶ月のブレイクアウト戦略バックテストを実行。DBの StockDailyBar データを使用。

### walk-forward 分析

```bash
npm run walk-forward:breakout
```

実行時間の目安: 60〜120分（2,880パラメータ × 6ウィンドウ × IS+OOS）

#### ウィンドウ構成

- IS（In-Sample）: 6ヶ月 / OOS（Out-of-Sample）: 3ヶ月
- スライド: 3ヶ月 × 6ウィンドウ = 24ヶ月

#### パラメータグリッド（2,880通り）

| パラメータ | 値 |
|-----------|-----|
| triggerThreshold | 1.5, 1.8, 2.0, 2.5, 3.0 |
| highLookbackDays | 10, 15, 20, 30 |
| atrMultiplier | 0.8, 1.0, 1.2, 1.5 |
| trailMultiplier | 0.8, 1.0, 1.5 |
| tsActivationMultiplier | 1.5, 2.0, 2.5 |
| maxChaseAtr | 0.5, 1.0, 1.5, 2.0 |

### 実行タイミング

**実行すべきタイミング:**
- パラメータを変更する前後（変更の効果・汎化性能の検証）
- 戦略の大幅な見直し時
- 定期的な汎化性能の確認（月1〜四半期に1回程度）

**実行不要なタイミング:**
- 毎日（パラメータが変わらない限り結果は変わらない）
- コードのバグ修正のみの場合

### 過学習判定基準

| 判定 | 条件 |
|------|------|
| **堅牢** | OOS集計PF >= 1.3 かつ IS/OOS PF比 <= 2.0 |
| **要注意** | OOS集計PF >= 1.0 かつ IS/OOS PF比 <= 3.0 |
| **過学習** | OOS集計PF < 1.0 または IS/OOS PF比 > 3.0 |

「堅牢」以外のパラメータは本番適用を慎重に判断すること。

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `src/backtest/types.ts` | 型定義（BreakoutBacktestConfig, PerformanceMetrics等） |
| `src/backtest/metrics.ts` | パフォーマンス指標計算 |
| `src/backtest/data-fetcher.ts` | StockDailyBarからのDB一括取得 |
| `src/backtest/breakout-config.ts` | デフォルト設定 + パラメータグリッド |
| `src/backtest/breakout-simulation.ts` | シミュレーションエンジン |
| `src/backtest/breakout-run.ts` | CLI実行エントリーポイント |
| `scripts/walk-forward-breakout.ts` | walk-forward検証スクリプト |
