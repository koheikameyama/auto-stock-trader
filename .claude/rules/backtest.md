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

実行時間の目安: 数分（81パラメータ × 6ウィンドウ × IS+OOS）

#### ウィンドウ構成

- IS（In-Sample）: 6ヶ月 / OOS（Out-of-Sample）: 3ヶ月
- スライド: 3ヶ月 × 6ウィンドウ = 24ヶ月

#### パラメータグリッド（81通り、エグジット系のみ）

エントリー系パラメータはデフォルト固定（グリッド探索しない）。

| パラメータ | 値 |
|-----------|-----|
| atrMultiplier | 0.8, 1.0, 1.2 |
| beActivationMultiplier | 0.3, 0.5, 0.8 |
| trailMultiplier | 0.3, 0.5, 0.8 |
| tsActivationMultiplier | 1.0, 1.5, 2.0 |

#### IS最低PFゲート

IS最適PF < 0.5 のウィンドウはOOS期間を「休止」（トレードしない）として扱う。
全パラメータがIS期間で負ける環境では、パラメータ選択に意味がないため。

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
| `src/backtest/breakout-run.ts` | CLI実行エントリーポイント（`--score-compare` オプションあり） |
| `src/backtest/scoring-filter.ts` | スコアフィルター（100点満点、OHLCV計算のみ） |
| `scripts/walk-forward-breakout.ts` | walk-forward検証スクリプト |
