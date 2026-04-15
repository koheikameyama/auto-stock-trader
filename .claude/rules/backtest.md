# バックテスト運用ルール

## バックテストの基本方針

**combinedバックテストが主。個別バックテストは診断用。**

実際のトレードは breakout と gapup が同時に資金を奪い合い、ポジション枠を競合する状態で動く。
個別バックテストは「資金が無限にある理想値」に過ぎないため、**正式な結果判断は combined で行う。**

| バックテスト | 位置づけ | 使うタイミング |
|---|---|---|
| **combined** | **メイン** | 本番パラメータ判断・定期的な汎化性能確認 |
| 個別（breakout/gapup） | 診断用 | どちらが問題かを切り分けるときのみ |

## バックテスト実行

**breakout戦略とgapup戦略のバックテスト・walk-forward検証が利用可能です。**

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

#### パラメータグリッド（27通り、エグジット系のみ）

エントリー系パラメータはデフォルト固定（グリッド探索しない）。

| パラメータ | 値 |
|-----------|-----|
| atrMultiplier | 0.8, 1.0, 1.2 |
| beActivationMultiplier | 0.3, 0.5, 0.8 |
| trailMultiplier | 0.8, 1.0, 1.5 |

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

### ギャップアップ戦略バックテスト

```bash
npm run backtest:gapup
# オプション: --start 2025-01-01 --end 2025-12-31 --budget 500000 --verbose --compare-entry
```

当日始値が前日終値から3%以上ギャップアップ＋出来高サージ1.5倍以上の銘柄を、当日終値でエントリーする短期戦略。

### ギャップアップ walk-forward 分析

```bash
npm run walk-forward:gapup
```

ブレイクアウトと同じウィンドウ構成（IS 6ヶ月 / OOS 3ヶ月 × 6ウィンドウ）。

#### パラメータグリッド（27通り、エグジット系のみ）

| パラメータ | 値 |
|-----------|-----|
| atrMultiplier | 0.8, 1.0, 1.2 |
| beActivationMultiplier | 0.3, 0.5, 0.8 |
| trailMultiplier | 0.3, 0.5, 0.8 |

#### 最新WF結果（2026-04-03実施）

- **OOS集計PF=2.16、判定「堅牢 ✓」（IS/OOS比=0.91）**
- 全6ウィンドウでアクティブ（休止なし）
- be=0.3・trail=0.3 が全ウィンドウで安定
- 平均保有日数: 1.2日
- ※ 以前の結果（2026-03-29: PF=2.44、ts=0.5）は `getDynamicMaxPositionPct` に `stockPrice` 引数漏れによるバグ（qty=NaN）で無効だった

### 週足レンジブレイク戦略バックテスト

```bash
npm run backtest:weekly-break
# オプション: --start 2025-01-01 --end 2025-12-31 --budget 500000 --verbose
```

13週高値ブレイク + 週足出来高サージ1.3倍でブレイク週の最終営業日終値エントリー。

### 週足レンジブレイク walk-forward 分析

```bash
npm run walk-forward:weekly-break
```

#### パラメータグリッド（27通り、エグジット系のみ）

| パラメータ | 値 |
|-----------|-----|
| atrMultiplier | 1.0, 1.5, 2.0 |
| beActivationMultiplier | 0.5, 0.8, 1.2 |
| trailMultiplier | 0.8, 1.0, 1.5 |

#### 最新WF結果（2026-04-11実施）

- **OOS集計PF=3.12、判定「堅牢 ✓」（IS/OOS比=1.04）**
- 全6ウィンドウアクティブ（休止なし）
- atr=1.0 が全ウィンドウで安定、be=0.5 が4/6窓、trail=0.8 が直近2窓
- 84トレード、勝率40.5%
- パラメータを本番に反映: atr=1.0, be=0.5, trail=0.8

### 高騰後押し目戦略バックテスト（Post-Surge Consolidation）

```bash
npm run backtest:psc
# オプション: --start 2025-01-01 --end 2026-03-25 --budget 500000 --verbose
```

直近20日+15%急騰後、高値から-5%以内で出来高干上がり → 当日に出来高サージ1.5倍+陽線で再加速した銘柄を終値でエントリー。タイムストップ5/7日。マーケットフィルターはgapupと同じ（breadth≥60%+日経SMA50）。

### 高騰後押し目 walk-forward 分析

```bash
npm run walk-forward:psc
```

IS 6ヶ月 / OOS 3ヶ月 × 7ウィンドウ。

#### パラメータグリッド（27通り、エグジット系のみ）

| パラメータ | 値 |
|-----------|-----|
| atrMultiplier | 0.8, 1.0, 1.2 |
| beActivationMultiplier | 0.3, 0.5, 0.8 |
| trailMultiplier | 0.5, 0.8, 1.0 |

#### WF結果（2026-04-15実施）

- **OOS集計PF=2.71、判定「堅牢 ✓」（OOS平均PFがIS平均PFを上回る）**
- 全7ウィンドウアクティブ（休止なし）
- atr=0.8・be=0.3 が全ウィンドウで安定、trail=0.5 が直近4窓で安定（trail=0.8 が初期2窓）
- OOS総トレード193件、勝率47.7%
- **結論: 実戦投入推奨。本番パラメータ: atr=0.8, be=0.3, trail=0.5**

### ギャップダウンリバーサル戦略バックテスト

```bash
npm run backtest:gapdown-reversal
# オプション: --start 2025-01-01 --end 2026-03-25 --budget 500000 --verbose
```

ギャップダウン（-3%以上）後に陽線+出来高サージ1.5倍で反転を確認し、当日終値でエントリーする短期平均回帰戦略。マーケットフィルターはインデックスSMA50のみ（breadthフィルターなし）。タイムストップはgapupより短縮（2日/3日）。

### ギャップダウンリバーサル walk-forward 分析

```bash
npm run walk-forward:gapdown-reversal
```

ブレイクアウトと同じウィンドウ構成（IS 6ヶ月 / OOS 3ヶ月 × 7ウィンドウ）。

#### パラメータグリッド（27通り、エグジット系のみ）

| パラメータ | 値 |
|-----------|-----|
| atrMultiplier | 0.8, 1.0, 1.2 |
| beActivationMultiplier | 0.3, 0.5, 0.8 |
| trailMultiplier | 0.3, 0.5, 0.8 |

#### WF結果（2026-04-15実施）

- **OOS集計PF=0.68、判定「過学習 ✗」（IS/OOS比=1.35）**
- 7窓中2窓が休止（IS PF < 0.5）、Window 3でOOS PF=0.00
- パラメータ不安定（trailが0.8/0.3でバラバラ）
- **結論: 実戦投入なし。中小型株ユニバースではギャップダウン後の続落パターンが多くエッジなし**

### スクイーズブレイクアウト戦略バックテスト

```bash
npm run backtest:squeeze-breakout
# オプション: --start 2025-01-01 --end 2025-12-31 --budget 500000 --verbose --compare-entry --no-position-cap
```

BB幅スクイーズ（60日パーセンタイル<20%）+ 上部BBまたは20日高値ブレイク + 出来高サージ1.5倍 + 陽線で当日終値エントリー。

### スクイーズブレイクアウト walk-forward 分析

```bash
npm run walk-forward:squeeze-breakout
```

#### パラメータグリッド（27通り、エグジット系のみ）

| パラメータ | 値 |
|-----------|-----|
| atrMultiplier | 0.8, 1.0, 1.2 |
| beActivationMultiplier | 0.3, 0.5, 0.8 |
| trailMultiplier | 0.5, 0.8, 1.0 |

#### WF結果（2026-04-10実施）

- **OOS集計PF=1.39、判定「堅牢 ✓」だが実質微妙**
- 6窓中3窓が休止（IS PF < 0.5）
- Window 5: IS PF=2.99 → OOS PF=0.10（過学習パターン）
- パラメータ不安定（atr, beが窓ごとにバラバラ、trailのみ安定=0.5）
- **結論: 実戦投入には至らず。`ENTRY_ENABLED = false` のまま**

### 戦略追加検証の総括（2026-04-10）

breakout無効化後の3本目の戦略候補を4つWF検証した結果:

| 戦略 | OOS集計PF | 判定 | 問題点 |
|------|-----------|------|--------|
| squeeze-breakout | 1.39 | 堅牢（微妙） | 6窓中3休止、W5過学習 |
| earnings-gap | - | 検証不能 | 決算日データ不足、全窓トレード3件未満 |
| momentum | 0.00 | 過学習 | OOS合計2トレード全敗 |
| 出来高+大陽線 | 未検証 | - | 旧breakout亜種、見送り |

**結論: 50万以下の中小型株ユニバースでは日足テクニカル系に新たなエッジなし。gapup + weekly-break の2本柱で運用継続。**

## ファイル構成

### breakout

| ファイル | 役割 |
|---------|------|
| `src/backtest/types.ts` | 型定義（BreakoutBacktestConfig, GapUpBacktestConfig, PerformanceMetrics等） |
| `src/backtest/metrics.ts` | パフォーマンス指標計算 |
| `src/backtest/data-fetcher.ts` | StockDailyBarからのDB一括取得 |
| `src/backtest/breakout-config.ts` | デフォルト設定 + パラメータグリッド |
| `src/backtest/breakout-simulation.ts` | シミュレーションエンジン |
| `src/backtest/breakout-run.ts` | CLI実行エントリーポイント（`--score-compare` オプションあり） |
| `src/backtest/scoring-filter.ts` | スコアフィルター（100点満点、OHLCV計算のみ） |
| `scripts/walk-forward-breakout.ts` | walk-forward検証スクリプト |

### gapup

| ファイル | 役割 |
|---------|------|
| `src/lib/constants/gapup.ts` | ギャップアップ戦略の定数 |
| `src/core/gapup/entry-conditions.ts` | `isGapUpSignal()` エントリー判定 |
| `src/backtest/gapup-config.ts` | デフォルト設定 + WFパラメータグリッド |
| `src/backtest/gapup-simulation.ts` | シミュレーションエンジン（precompute対応） |
| `src/backtest/gapup-run.ts` | CLI実行エントリーポイント（`--compare-entry` オプションあり） |
| `scripts/walk-forward-gapup.ts` | walk-forward検証スクリプト |

### squeeze-breakout

| ファイル | 役割 |
|---------|------|
| `src/lib/constants/squeeze-breakout.ts` | スクイーズブレイクアウト戦略の定数 |
| `src/core/squeeze-breakout/entry-conditions.ts` | `isSqueezeBreakoutSignal()` エントリー判定 |
| `src/backtest/squeeze-breakout-config.ts` | デフォルト設定 + WFパラメータグリッド |
| `src/backtest/squeeze-breakout-simulation.ts` | シミュレーションエンジン（precompute対応） |
| `src/backtest/squeeze-breakout-run.ts` | CLI実行エントリーポイント（`--compare-entry` オプションあり） |
| `scripts/walk-forward-squeeze-breakout.ts` | walk-forward検証スクリプト |
