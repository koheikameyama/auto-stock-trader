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

直近20日+15%急騰後、高値から-5%以内で当日に出来高サージ1.5倍+陽線で再加速した銘柄を終値でエントリー。タイムストップ5/7日。マーケットフィルターはgapupと同じ（breadth≥60%+日経SMA50）。

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

#### 前日Vol干上がりフィルター削除（2026-04-17）

エントリー条件から「前日Vol干上がり（prevVolume < avgVolume25）」を削除。5条件 → 4条件に簡素化。

- 単体24ヶ月BT: PF 1.81 → **2.75**、純リターン +14.4% → **+74.1%**
- WF（7窓）: OOS集計PF 2.74 → 2.69（ほぼ同等）、OOSトレード 193 → **311**、判定どちらも堅牢 ✓
- combined（GU3+PSC2）: PF 4.05 → **4.38**、最大DD **10.9% → 6.7%**（-39%）、PSC単体PF **2.20 → 4.59**

「押し目で閑散 → 再加速」のストーリーは中小型株（≤2,500円）ユニバースでは機能せず、急騰後も出来高が高止まりしたまま再ブレイクするパターンの方が多いと判明。

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

### NR7ブレイク戦略バックテスト

```bash
npm run backtest:nr7
# オプション: --start 2025-01-01 --end 2026-03-25 --budget 500000 --verbose --no-position-cap
```

7日間で最も狭いレンジ（NR7: ボラ収縮）→ブレイクアウト（close > 前6日高値）+ 出来高サージ1.5倍 + 陽線で当日終値エントリー。マーケットフィルターはgapup/PSCと同じ（breadth≥60%+日経SMA50）。タイムストップ5/7日。

### NR7ブレイク walk-forward 分析

```bash
npm run walk-forward:nr7
```

IS 6ヶ月 / OOS 3ヶ月 × 7ウィンドウ。

#### パラメータグリッド（27通り、エグジット系のみ）

| パラメータ | 値 |
|-----------|-----|
| atrMultiplier | 0.8, 1.0, 1.2 |
| beActivationMultiplier | 0.3, 0.5, 0.8 |
| trailMultiplier | 0.5, 0.8, 1.0 |

#### WF結果（2026-04-16実施）

- **OOS集計PF=0.44、判定「過学習 ✗」**
- 7窓中1窓休止、残り6窓中5窓でOOS PF < 1.0
- OOS総トレード22件、勝率36.4%
- ISでもエッジが弱い（7窓中4窓でIS PF < 1.0）
- パラメータ不安定（beが0.3/0.5/0.8でバラバラ）
- **結論: 実戦投入なし。ボラ収縮→拡張パターンは中小型株ユニバースでエッジなし**

### 戦略追加検証の総括（2026-04-10〜04-16）

breakout無効化後の3本目の戦略候補をWF検証した結果:

| 戦略 | OOS集計PF | 判定 | 問題点 |
|------|-----------|------|--------|
| squeeze-breakout | 1.39 | 堅牢（微妙） | 6窓中3休止、W5過学習 |
| earnings-gap | - | 検証不能 | 決算日データ不足、全窓トレード3件未満 |
| momentum | 0.00 | 過学習 | OOS合計2トレード全敗 |
| 出来高+大陽線 | 未検証 | - | 旧breakout亜種、見送り |
| NR7ブレイク | 0.44 | 過学習 | ISでもエッジ弱、22trで勝率36% |

**結論: 50万以下の中小型株ユニバースでは日足テクニカル系に新たなエッジなし。**

→ その後、高騰後押し目（PSC）戦略がWF検証で「堅牢 ✓」（OOS PF=2.71）を達成し、2026-04-15よりcombinedに第3戦略として追加。**現在は gapup + PSC の2本柱で運用。**

## 資金スケーリング検証（2026-04-16実施）

**maxPrice=2,500円固定が最適。資金が増えてもユニバースを拡大しない。**

### 検証結果: 動的maxPrice vs 固定maxPrice=2,500

```bash
npm run backtest:combined -- --budget-compare                   # 動的（資金連動）
npm run backtest:combined -- --budget-compare --max-price 2500  # 固定
```

| 資金 | 動的PF / NetRet | 固定PF / NetRet |
|------|----------------|----------------|
| 500K | 3.46 / +128.3% | 3.46 / +128.3% |
| 1M | 2.40 / +64.8% | **2.66 / +78.4%** |
| 2M | 2.22 / +57.0% | **3.27 / +116.4%** |
| 5M | 2.23 / +57.8% | **2.76 / +86.4%** |

### WF検証（1M budget, maxPrice=5000）

```bash
npm run walk-forward:gapup -- --budget=1000000
npm run walk-forward:psc -- --budget=1000000
```

| 戦略 | OOS PF | 判定 | パラメータ |
|------|--------|------|----------|
| GapUp | 2.45 | 堅牢 ✓ | atr=0.8/be=0.3/trail=0.3 |
| PSC | 2.03 | 堅牢 ✓ | atr=0.8/be=0.3/trail=0.5 |

### ポジション分割比較（1M budget）

```bash
npm run backtest:combined -- --budget 1000000 --compare-split-positions
```

GU3+PSC2→GU5+PSC5にしてもトレード数・PFともに改善せず。枠を増やす必要なし。

### 結論

- **エッジは低価格帯（≤2,500円）に集中**。高価格帯を足すとノイズが混入しPFが低下
- **maxPrice=2,500を維持し、ポジションサイズを太くする**のが最適な資金スケーリング
- ポジション上限: GU3+PSC2で変更不要
- 複利シミュレーション: 50万(+128%)→114万(+78%)→203万(+116%)→438万(+86%)→815万

### 資金上限テスト（500K〜20M、maxPrice=2,500固定）

```bash
npm run backtest:combined -- --budget-compare --max-price 2500
```

| 資金 | Trades | PF | Expect | MaxDD | NetRet | 稼働率 |
|------|--------|-----|--------|-------|--------|--------|
| 500K | 221 | 3.46 | +3.61% | 12.3% | +128.3% | 20.2% |
| 1M | 257 | 2.66 | +2.81% | 14.0% | +78.4% | 20.6% |
| 2M | 302 | 3.27 | +2.39% | 14.0% | +116.4% | 21.0% |
| 5M | 340 | 2.76 | +2.52% | 15.4% | +86.4% | 21.4% |
| 10M | 354 | 2.56 | +2.16% | 15.6% | +75.7% | 21.4% |
| 20M | 379 | 2.65 | +2.21% | 15.7% | +82.4% | 21.6% |

- **PFは緩やかに低下**（3.46→2.56）だが20Mでも2.65で十分プラス
- **期待値は3.61%→2.21%に低下**（-39%）だがまだ正
- **NetRetは75-130%の範囲で安定**。20Mでも年+82%
- **稼働率は20-21%で横ばい**（資金量に依存しない）
- バックテストは流動性・マーケットインパクト未考慮。**実運用では5-10Mが安全圏の上限**

### WB（週足レンジブレイク）復活検証（2026-04-17実施）

個別WFではPF=3.12で堅牢だったWBを、資金増加時に再投入できるか検証。

```bash
npm run backtest:combined -- --budget 500000 --compare-split-positions
npm run backtest:combined -- --budget 1000000 --compare-split-positions
npm run backtest:combined -- --budget 2000000 --compare-split-positions
```

| 資金 | GU3+PSC2（現状） | GU3+WB1+PSC2 | GU3+WB2+PSC2 | GU3+PSC3 |
|------|-----------------|--------------|--------------|---------|
| 500K | **PF 3.54 / +128%** | PF 3.14 / +113% | PF 3.00 / +97% | PF 3.54 / +128% |
| 1M | PF 2.42 / +66% | PF 2.39 / +65% | PF 2.38 / +64% | **PF 2.47 / +69%** |
| 2M | PF 2.22 / +57% | PF 2.36 / +65% | PF 2.30 / +62% | **PF 2.45 / +72%** |

**結論: WBは資金が増えても改善しない。**
- 500K: WB追加は全パターンで現状に劣る
- 1M/2M: WBよりPSC枠を1つ増やす（GU3+PSC3）方がPF・リターンとも上
- WBの構造的弱点: 保有3-5日で資金拘束が長く、gapup（1-2日）と比べて資金効率が悪い
- **資金増時の最適構成: 2M以上でPSC枠を2→3に増やすだけで十分**

## 資金効率検証（2026-04-16実施）

**現物T+2・リスク2%が最適。改善は信用取引（T+0）でのみ可能。**

```bash
npm run backtest:combined -- --compare-efficiency
```

### 検証結果: 受渡日数（T+2 vs T+0）× リスク%（2/3/4%）

| 条件 | Trades | WinRate | PF | Expect | MaxDD | NetRet | 稼働率 |
|------|--------|---------|-----|--------|-------|--------|--------|
| **現状(T+2,2%)** | **221** | **51.6%** | **3.54** | **+3.19%** | **17.5%** | **+128.0%** | **21.1%** |
| T+0,2% | 273 | 53.9% | 3.53 | +2.81% | 31.2% | +248.6% | 28.0% |
| T+2,3% | 141 | 46.1% | 2.84 | +3.89% | 18.1% | +95.8% | 21.5% |
| T+2,4% | 57 | 42.1% | 1.39 | +0.18% | 10.6% | +0.0% | 10.3% |
| T+0,3% | 153 | 47.7% | 2.34 | +2.07% | 26.6% | +65.2% | 28.0% |
| T+0,4% | 63 | 44.4% | 1.17 | +0.38% | 15.5% | -4.8% | 11.9% |

### 分析

**T+0（信用取引）の効果:**
- リターン倍増（128%→248%）、トレード数+24%、稼働率21%→28%
- PF同等（3.54→3.53）→追加トレードの質が劣化していない
- リスク調整リターン: 128/17.5=7.3→248.6/31.2=8.0（改善）
- **ただしMaxDD 17.5%→31.2%（+78%増）**

**リスク%増は逆効果:**
- ポジションサイズ膨張→資金枯渇が早い→エントリー機会を逃す
- イベントドリブン戦略は「数を打ってPFで勝つ」構造。1発のサイズを太くする戦略ではない
- 3%: トレード数が141に減少、PF 2.84に悪化
- 4%: トレード数57、PF 1.39で損益分岐点付近

### 結論

- **現物取引: T+2・リスク2%が最適。稼働率21%・年+128%が天井**
- **信用取引: T+0・リスク2%で年+248%が可能だがMaxDD 31%。金利コスト未考慮**
- リスク%増は全パターンで逆効果。2%がスイートスポット

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

### nr7

| ファイル | 役割 |
|---------|------|
| `src/lib/constants/nr7.ts` | NR7ブレイク戦略の定数 |
| `src/core/nr7/entry-conditions.ts` | `isNR7Signal()` エントリー判定 |
| `src/backtest/nr7-config.ts` | デフォルト設定 + WFパラメータグリッド |
| `src/backtest/nr7-simulation.ts` | シミュレーションエンジン（precompute対応） |
| `src/backtest/nr7-run.ts` | CLI実行エントリーポイント |
| `scripts/walk-forward-nr7.ts` | walk-forward検証スクリプト |
