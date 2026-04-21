# ギャップアップバックテスト仕様

## 概要

ギャップアップ戦略（前日終値→当日始値の窓開け上昇 + 出来高サージ）のバックテストシステム。breakout戦略と並行運用し、ポジション枠を共有する。エグジットは既存の `checkPositionExit()` を再利用。

## エントリーシグナル

以下の条件が同時に成立した場合、**当日終値**でエントリー:

1. **ギャップ閾値**: `(open - prevClose) / prevClose >= effectiveGapMin`
   - 通常: `effectiveGapMin = 3%`
   - vol >= 4x の場合: `effectiveGapMin = 1%`（高出来高緩和ルール）
2. **陽線引け**: `close >= open`（ギャップが日中に維持されている）
3. **ギャップ維持**: `close > prevClose × (1 + effectiveGapMin)`
4. **出来高サージ**: `volume / avgVolume25 >= volSurgeRatio`（default: 1.5x）

**高出来高緩和ルール（2026-04-15追加）**: vol >= 4x（`GAP_RELAX_VOL_THRESHOLD`）のとき、
ギャップ閾値を1%（`GAP_MIN_PCT_RELAXED`）に緩和。WF検証（2026-04-15）で直近2ウィンドウ
（W5/W6）連続選択を確認。「強い出来高が需給の質を担保する」という仮説に基づく。

### ユニバースフィルター（breakoutと共通）

| フィルター | 条件 | 目的 |
|-----------|------|------|
| 価格上限 | 株価 ≤ 5,000円 | スプレッドリスク回避 |
| 流動性 | 25日平均出来高 ≥ 100,000株 | 流動性確保 |
| ボラティリティ | ATR% ≥ 1.5% | 十分な値幅確保 |
| クールダウン | 同一銘柄の直近exitから3日以上 | 往復売買防止 |

### マーケットフィルター

| フィルター | 条件 | デフォルト |
|-----------|------|-----------|
| breadthフィルター（下限） | SMA25上%銘柄比率 ≥ 閾値 | 55% |
| breadthフィルター（上限） | SMA25上%銘柄比率 ≤ 閾値（過熱veto） | 80%（band 55-80%） |
| 指数トレンド | N225 > SMA50 | ON |

## 出口ロジック

breakoutと同じ `checkPositionExit()` を使用。パラメータのみ異なる。

| 出口 | 条件 |
|------|------|
| ストップロス | SL = max(entry - ATR × atrMultiplier, entry × 0.97) |
| ブレイクイーブン | ATR × 0.3 到達でSLをエントリー価格に引き上げ |
| トレーリングストップ | ATR × 0.5 到達でトレール開始、幅 ATR × 0.3 |
| タイムストップ | 3営業日（含み益+TS時は最大5日まで延長） |
| ディフェンシブ | VIX crisis時の強制クローズ |

## ポジション管理

- maxPositions: 2（breakoutとは独立カウント）
- リスクベースサイジング: 1トレードあたり資金の2%リスク
- VIX elevated時: サイズ半減

## Walk-Forward検証

### 構成

- IS 6ヶ月 / OOS 3ヶ月 / スライド 3ヶ月 × 6ウィンドウ = 24ヶ月
- パラメータグリッド: エグジット系27通り
- IS最低PFゲート: IS最適PF < 0.5 → OOS休止

### WF結果（2026-03-29実施）

| Window | IS PF | OOS PF | OOS勝率 | OOSトレード | 最適パラメータ |
|--------|-------|--------|---------|-------------|----------------|
| 1 | 1.62 | 1.91 | 45.5% | 11 | atr=1.2 be=0.3 trail=0.3 ts=0.5 |
| 2 | 1.84 | 1.53 | 33.3% | 18 | atr=0.8 be=0.8 trail=0.3 ts=0.5 |
| 3 | 1.91 | 1.98 | 45.3% | 53 | atr=1.2 be=0.3 trail=0.3 ts=0.5 |
| 4 | 1.96 | 2.14 | 40.5% | 89 | atr=1.2 be=0.8 trail=0.3 ts=0.5 |
| 5 | 2.48 | 2.97 | 61.9% | 21 | atr=0.8 be=0.3 trail=0.3 ts=0.5 |
| 6 | 2.58 | 3.28 | 55.7% | 61 | atr=0.8 be=0.3 trail=0.3 ts=0.5 |

**OOS集計PF: 2.44 / IS/OOS比: 0.90 → 堅牢 ✓**

### パラメータ安定性

- `trailMultiplier: 0.3` → 全ウィンドウで安定
- `atrMultiplier`: 0.8 or 1.2 → やや安定
- `beActivationMultiplier`: 0.3 or 0.8 → やや安定

## 定期実行

`POST /api/cron/run-backtest-gapup` で直近12ヶ月のバックテストを実行し、結果を `BacktestRun` テーブルに保存（`strategy = "gapup"`）。Slack通知も送信される。

週次実行（月曜 5:00 JST）を推奨。

## ダッシュボード

`GET /backtest?strategy=gapup` で戦略別の実行履歴・サマリー・エクイティカーブ・トレード一覧を確認可能。

## 実行方法

```bash
# 単体バックテスト
npm run backtest:gapup
npm run backtest:gapup -- --start 2025-04-01 --end 2026-03-25 --verbose

# エントリーパラメータ比較
npm run backtest:gapup -- --compare-entry

# Walk-Forward検証
npm run walk-forward:gapup
npm run walk-forward:gapup -- --max-pf  # 最大PF選択モード
```

## 本番統合

### エントリーフロー

1. 8:00: watchlist-builder → breakoutと共通のウォッチリスト
2. 14:50: breakout-monitorの毎分ループ内でGapUpScanner.scan()を1回実行
3. isGapUpSignal()でシグナル判定（14:50時点のcurrentPriceをcloseとして代替）
4. 引け条件付き成行注文（sCondition="4"）で発注
5. 15:00: 引け注文約定 → position-monitorがポジションをopen

### エグジット

breakoutと同じcheckPositionExit()を使用。gapup用overrideで以下を適用:
- BE発動: ATR×0.3
- TS発動: ATR×0.5
- トレール幅: ATR×0.3
- タイムストップ: 3日（延長5日）

### ポジション管理

- breakoutとは独立: gapup max 2ポジション
- セクター・マクロ・日次損失制限はbreakoutと合算
