# ブレイクアウトバックテスト仕様

## 概要

breakout戦略（出来高サージ + 高値ブレイク）のパラメータ妥当性を検証するバックテストシステム。本番の出口ロジック（`checkPositionExit`）を直接再利用し、シミュレーション精度を担保する。

## エントリーシグナル（日足データ）

以下の2条件が同時に成立した場合、終値でエントリー:

1. **出来高サージ**: `当日出来高 / 25日平均出来高 >= triggerThreshold`（default: 2.0）
2. **高値ブレイク**: `当日終値 > 過去N日高値`（default: 20日）

### ユニバースフィルター（エントリー前ゲート）

| フィルター | 条件 | 目的 |
|-----------|------|------|
| 価格上限 | 株価 ≤ maxPrice（5,000円） | スプレッドリスク回避 |
| 流動性 | 25日平均出来高 ≥ minAvgVolume25（50,000株） | 流動性確保 |
| ボラティリティ | ATR% ≥ minAtrPct（1.5%） | 十分な値幅確保 |
| 高値追い制限 | 終値 - highN ≤ ATR × maxChaseAtr（1.0） | 高値追いエントリー防止 |
| クールダウン | 同一銘柄の直近エントリーからcooldownDays（3日）以上 | 往復売買防止 |

## 出口ロジック

本番と同じ `checkPositionExit()` を直接呼び出し:

| 出口 | 条件 |
|------|------|
| ストップロス | SL = max(entry - ATR × atrMultiplier, entry × (1 - maxLossPct)) |
| トレーリングストップ | BE発動: ATR × beActivationMultiplier、TS発動: ATR × tsActivationMultiplier、トレール幅: ATR × trailMultiplier |
| タイムストップ | maxHoldingDays（5日）、含み益時 maxExtendedHoldingDays（10日）まで延長 |
| ディフェンシブ | VIX crisis/high時 |

## ポジションサイジング

```
riskAmount = initialBudget × 0.02  // 資金の2%
riskPerShare = entryPrice - stopLossPrice
quantity = floor(riskAmount / riskPerShare / 100) × 100  // 100株単位
```

## デフォルトパラメータ

| パラメータ | デフォルト値 | 説明 |
|-----------|------------|------|
| initialBudget | 500,000 | 初期資金（円） |
| maxPositions | 3 | 最大同時保有数 |
| triggerThreshold | 2.0 | 出来高サージ倍率 |
| highLookbackDays | 20 | 高値ルックバック日数 |
| atrMultiplier | 1.0 | SL ATR倍率 |
| maxLossPct | 0.03 | SLハードキャップ（3%） |
| beActivationMultiplier | 1.5 | BE発動 ATR倍率 |
| tsActivationMultiplier | 2.5 | TS発動 ATR倍率 |
| trailMultiplier | 1.5 | トレール幅 ATR倍率 |
| maxHoldingDays | 5 | ベース保有日数 |
| maxExtendedHoldingDays | 10 | 延長上限 |
| costModelEnabled | true | 取引コストモデル |
| priceLimitEnabled | true | 値幅制限モデル |
| cooldownDays | 3 | 同一銘柄クールダウン |
| maxChaseAtr | 1.0 | 高値追い制限（ATR倍率）。high20からATR×N以上乖離でスキップ |

## パフォーマンス指標

| 指標 | 説明 |
|------|------|
| Profit Factor | 総利益 / 総損失 |
| Win Rate | 勝率 |
| Expectancy | 1トレードあたり期待値 |
| Risk/Reward Ratio | 平均利益% / 平均損失% |
| Sharpe Ratio | リスク調整後リターン |
| Max Drawdown | 最大ドローダウン |
| Net Return | コスト控除後リターン |
| Cost Impact | コストがリターンに与える影響（%） |

## Walk-Forward 分析

### ウィンドウ構成

- IS（In-Sample）: 6ヶ月 — パラメータ最適化
- OOS（Out-of-Sample）: 3ヶ月 — 汎化性能検証
- スライド: 3ヶ月 × 6ウィンドウ = 24ヶ月

### 最適化基準

IS期間で Profit Factor を最大化するパラメータを選択（最低5トレード以上）。

### 過学習判定

| 判定 | OOS集計PF | IS/OOS PF比 |
|------|----------|-------------|
| 堅牢 ✓ | ≥ 1.3 | ≤ 2.0 |
| 要注意 △ | ≥ 1.0 | ≤ 3.0 |
| 過学習 ✗ | < 1.0 | > 3.0 |

### パラメータ安定性分析

6ウィンドウで選択されたパラメータのユニーク値数で安定性を判定:
- 1種類: 安定
- 2種類: やや安定
- 3種類以上: 不安定

## コアモジュール再利用

| モジュール | 用途 |
|-----------|------|
| `src/core/exit-checker.ts` | checkPositionExit() |
| `src/core/trailing-stop.ts` | calculateTrailingStop() |
| `src/core/trading-costs.ts` | calculateCommission(), calculateTax() |
| `src/core/technical-analysis.ts` | analyzeTechnicals() |
| `src/lib/constants/price-limits.ts` | getLimitDownPrice() |

## 定期実行

`POST /api/cron/run-backtest` で直近12ヶ月のバックテストを実行し、結果を `BacktestRun` テーブルに保存（`strategy = "breakout"`）。Slack通知も送信される。

週次実行（月曜 4:00 JST）を推奨。

## ダッシュボード

`GET /backtest?strategy=breakout` で戦略別の実行履歴・サマリー・エクイティカーブ・トレード一覧を確認可能。

## npm scripts

```bash
npm run backtest:breakout          # 単体バックテスト
npm run walk-forward:breakout      # walk-forward検証
```
