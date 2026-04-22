# バックテスト運用ルール

## バックテストの基本方針

**combinedバックテストが主。個別バックテストは診断用。**

実際のトレードは breakout と gapup が同時に資金を奪い合い、ポジション枠を競合する状態で動く。
個別バックテストは「資金が無限にある理想値」に過ぎないため、**正式な結果判断は combined で行う。**

| バックテスト | 位置づけ | 使うタイミング |
|---|---|---|
| **combined** | **メイン** | 本番パラメータ判断・定期的な汎化性能確認 |
| 個別（breakout/gapup） | 診断用 | どちらが問題かを切り分けるときのみ |

## 判断KPIの優先順位

**Calmar比を主KPIとする（期待値単独で判断しない）。**

| 優先度 | KPI | 計算式 | 目標値 |
|---|---|---|---|
| **1 (主KPI)** | **Calmar比** | NetRet / MaxDD | **≥ 3.0** |
| 2 | PF（Profit Factor） | Gross Profit / Gross Loss | ≥ 1.3 |
| 3 | 期待値（per-trade） | (勝率 × 平均勝%) - (敗率 × 平均負%) | > 0 |
| 4 | RR比 | 平均勝% / 平均負% | ≥ 1.5 |
| 5 | 資本稼働率 | 平均同時ポジション評価額 / 総資産 | 15% 以上 |

### 期待値単独で判断してはいけない理由

per-trade 期待値は**必要条件だが十分条件ではない**:

1. **機会コスト無視**: 期待値+3%×10回/年 < 期待値+1%×100回/年（自動化なら後者が可能）
2. **複利効果無視**: 継続運用では頻度も重要
3. **リスク調整無視**: 同じ期待値でもMaxDDが違えば運用可能性が違う

### パラメータ選択基準

複数パターンが接戦の場合:

1. **Calmar比で選ぶ**（最優先）
2. Calmar比が同等なら **シンプルな方**（条件数が少ない方）を選ぶ（Occam's razor / 過学習リスク低減）
3. それでも決まらなければ **パラメータ安定性**（WF各窓で同じパラメータが選ばれるか）で選ぶ

### 事例: PSC前日Vol干上がりフィルター削除（2026-04-17）

期待値単独だとONの方が優位に見えたが、Calmar比で判断したらOFFが70%優位だった:

| 指標 | ON（5条件） | OFF（4条件） |
|---|---:|---:|
| per-trade 期待値（24ヶ月combined） | +2.15% | +2.50% |
| PF | 4.05 | 4.38 |
| NetRet | +229% | +241% |
| MaxDD | 10.9% | 6.7% |
| **Calmar比** | **21.0** | **36.0** |

→ Calmar比優位 + シンプル（条件1つ少ない）で OFF採用。詳細は `memory/long-term/psc-prev-vol-analysis.md` 参照。

### 事例: breadth 上限（band 55-80%）追加（2026-04-21）

現状は breadth < 55% で下限vetoのみ。combined BT で代替モードを検証した結果、**上限80%超過時のvetoを追加（band 55-80%）**で圧倒的改善:

| 指標 | hard 55%（従来） | band 55-80%（採用） |
|---|---:|---:|
| PF | 3.22 | 3.66 |
| **MaxDD** | 16.2% | **9.0%**（-44%） |
| NetRet | 173.6% | 180.3% |
| **Calmar比** | **5.01** | **9.38**（+87%） |
| Regime A (平穏ボックス) NetPnL | +¥13K | +¥13K（維持） |
| Regime E (直近急落) NetPnL | -¥480 | +¥276（黒字化） |

**WF検証（band 55-80%）:**
- GapUp: OOS集計PF **2.18**（堅牢 ✓、IS/OOS比 0.78）
- PSC: OOS集計PF **2.67**（堅牢 ✓、IS/OOS比 0.75）
- 両方ともOOS平均PF > IS平均PF で極めて健全、全窓アクティブ、パラメータ安定

**論理的根拠:** breadth > 80% = ほぼ全銘柄がSMA25上回り = 過熱状態。中小型株ブレイクアウト系戦略は mean reversionリスクが急増する局面で参入するとSL刈られやすい。上限vetoで late-cycle を回避。

実装: `MARKET_BREADTH.UPPER_CAP = 0.80`（`lib/constants/trading.ts`）を `jobs/market-assessment.ts` と `backtest/gapup-config.ts` / `post-surge-consolidation-config.ts` に適用。

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

### WBハーフサイズ＆タイムストップ短縮 追加検証（2026-04-17実施）

上記で保有期間の長さをWBのボトルネックと仮定し、サイズ半減（リスク2%→1%）＋タイムストップ短縮で改善できるかを検証。

```bash
npm run backtest:combined -- --compare-wb-halfsize
```

| パターン | PF (1M) | NetRet (1M) | WB PF | WB Exp | WB AvgH |
|---|---|---|---|---|---|
| ベース GU3+PSC2 | **3.21** | **+107.5%** | - | - | - |
| WB1 フル(2%)・15/25 | 3.17 | +99.1% | 3.82 | +3.03% | 1.4d |
| WB1 ハーフ(1%)・15/25 | 2.97 | +87.6% | 1.42 | -0.81% | 1.3d |
| WB1 ハーフ(1%)・10/15 | 2.97 | +87.6% | 1.42 | -0.81% | 1.3d |
| WB1 ハーフ(1%)・7/10 | 2.97 | +87.6% | 1.42 | -0.81% | 1.3d |
| WB2 ハーフ(1%)・10/15 | 2.82 | +80.6% | 0.45 | -1.80% | 1.3d |

**結論: ハーフサイズ＆タイムストップ短縮はいずれも効果なし、むしろ逆効果。**
- **タイムストップ短縮は完全に無意味**: 15/25 → 10/15 → 7/10 で結果が完全同一。WBの平均保有日数は1.3日でSL/トレール/BE決済が主で、そもそもタイムストップに到達していない
- **ハーフサイズは逆効果**: WBのPF 3.82→1.42、期待値 +3.03%→-0.81%に悪化。固定コスト（手数料・税）の相対影響が増大
- **WB無投入（GU3+PSC2）が引き続き最適**という結論は変わらず

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

## レジーム別検証（2026-04-17実施）

> **⚠️ 注記（2026-04-22追記）**: 本セクションの結果は **breadth band 55-80% 追加（2026-04-21）前** のパラメータで取得したもの。現行パラメータでは **A期は +¥13K（黒字）に改善済み**。下記「レジーム適応: エクイティSMAフィルター拡張検証（2026-04-22実施）」も参照。

**現行パラメータは"平穏ボックス相場"で負ける。リターンの大半は大強気相場(D)への依存。**

```bash
npm run backtest:combined -- --compare-regimes
```

日経225の値動きで24ヶ月を5レジームに分割し、現行 combined 設定（GU3+PSC2、budget 500K）を個別計測。

### 検証結果

| レジーム | 期間 | Trades | WinR | PF | Expect | MaxDD | NetRet | Calmar |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| **A: 平穏ボックス** | 2024-03〜07 | 25 | 32.0% | **0.56** | +0.36% | 3.6% | **-3.6%** | **-2.34** |
| **B: ブラマン＋余震** | 2024-08〜12 | 14 | 42.9% | 4.48 | +1.56% | 2.9% | +11.2% | 10.09 |
| **C: 関税ショック** | 2025-02〜04 | 6 | 66.7% | 9.77 | +6.57% | 1.7% | +16.2% | 49.84 |
| **D: 大強気相場** | 2025-05〜26-02 | 243 | 50.6% | 3.98 | +2.47% | 7.9% | **+130.1%** | 21.99 |
| **E: 直近急落** | 2026-03〜04 | 4 | 25.0% | 1.35 | -0.19% | 0.0% | -0.1% | - |

### 発見

- **Aの平穏ボックス相場が唯一の負け**: GU(PF0.54)・PSC(PF0.60)が共倒れ。方向感のない持ち合い相場で両戦略のシグナル品質が同時に落ちる → 戦略間の相関が露呈
- **リターンはDの一度きり依存**: 全期間 NetRet +128% のうちD単独で +130%。DはAprilの関税ショック底→10月+17.6%の歴史的上昇局面で、もしこの相場が来なければ戦略はほぼ沈黙
- **ショック相場では健全**: B/Cともに PF 4.48/9.77。日経SMA50フィルターで稼働率を下げ損失を回避できている（自動化の強み）
- **PSCは強気相場依存**: Dで78件/PF3.79だが、B(3件全敗)・A(12件PF0.60)で不調。「押し目→再加速」は強気相場特有の現象

### 運用上の示唆

- **監視指標**: 月次WinRateが40%未満に張り付いたら"平穏ボックス相場入り"のシグナルの可能性。ポジションサイズ縮小等で備える
- **全期間MaxDD 17.5%は表示値**: Aのような相場+実運用スリッページで実効DDは20%前後を想定
- **データが少ない（2024-02〜）**: 2018年以前や2022年金利上昇期などの多相場検証には過去データのバックフィルが必要

## レジーム適応: エクイティSMAフィルター拡張検証（2026-04-22実施）

**結論: 現状維持。エクイティSMAフィルターをGU/PSCに拡張する案は明確に逆効果だったため採用しない。**

レジーム別検証（2026-04-17）でA期(平穏ボックス)のNetRet -3.6% という結果を受け、「レジーム適応で A期のDDを縮小できないか」を検討。既存の `equityCurveSmaPeriod` フィルター（当時はBreakout専用）を**GU/PSC/WBにも拡張**し、ローリング成績の劣化でエントリーを止める形で検証した。

```bash
npm run backtest:combined -- --compare-equity-filter --start 2024-03-01
```

### 検証結果（全期間: 2024-03 〜 2026-04）

| SMA | Trades | PF | MaxDD | NetRet | **Calmar** | Halt日 |
|---|---:|---:|---:|---:|---:|---:|
| **なし(現状)** | 289 | 3.66 | 9.0% | **180.3%** | **9.37** | 0 |
| SMA10 | 156 | 4.09 | 10.0% | 124.8% | 5.84 | 137 |
| SMA20 | 149 | 3.30 | 10.3% | 87.4% | 3.96 | 180 |
| SMA40 | 106 | 1.80 | 11.2% | 10.3% | 0.43 | 244 |
| SMA60 | 107 | 1.45 | 9.5% | 0.2% | 0.01 | 287 |

### A期（平穏ボックス）のレジーム別内訳

| SMA | Trades | PF | NetPnL |
|---|---:|---:|---:|
| なし | 33 | 2.09 | **+¥13K** |
| SMA10 | 9 | 0.14 | -¥15K |
| SMA20以降 | 6 | 0.19 | -¥10K |

### 今回の発見

- **A期の負けは既に解決済み**: 2026-04-21 の breadth band 55-80% 追加により、A期は既にフィルターなしで +¥13K の黒字に転じていた。レジーム別検証(2026-04-17)時点の-3.6%はband導入前の古い数値
- **SMAフィルターは逆効果**: どのSMA期間でもCalmarが大幅に悪化(9.37 → 最良でも5.84)。スキップされるトレードの方が勝ち分を含み、通過する少数トレードが選別的に悪い
- **D期の取り逃しが深刻**: 大強気相場のNetPnL が ¥724K → SMA10 で ¥580K (-20%)、SMA40以降はマイナス。短期決戦戦略(GU 1-2日・PSC 5-7日)では、前回決済時点のエクイティ変動と現在のシグナル品質が連動しない
- **ハルト日が大量**: SMA60 で 287日(全営業日の約60%)がハルト。フィルターはノイズに反応して稼働率を潰しているだけ

### ローリング成績スロットル案（Phase 1）を見送る論理

「直近N件の PF / WinRate / DD% が閾値割れでサイズ縮小」案も検討したが、**SMAフィルターと同じ遅行指標メカニズム**のため同じ失敗パターンになる可能性が高い。採用見送り。

### 実装として残したもの（本番への影響なし）

バックテスト側のみ、以下を残置（検証の再現性のため）:

- `combined-simulation.ts`: `equityCurveSmaPeriod` を Breakout 限定から全戦略(GU/WB/PSC)に拡張
- `combined-run.ts`: `--compare-equity-filter` モードにレジーム別内訳を追加
- `combined-run.ts`: ctx の `equityCurveSmaPeriod` デフォルトは **0（無効）**。Phase 0拡張で全戦略に適用されるようになったため、20のままだと常時SMA20フィルターがONになり基準BTの結果も悪化する事象を確認（2026-04-22追加修正）

### 今後のレジーム適応に関する方針

- **既存機構で十分**: breadth band 55-80% と日経SMA50 と VIXレジームフィルターで、A〜E 各レジームで許容可能なパフォーマンスは既に確保できている
- **ローリング系スロットルは採用しない**: 短期決戦戦略では遅行指標として機能しない
- **レジーム適応で改善したい場合の正攻法**: (1) mean-reversion 系戦略の追加による戦略多様化、または (2) 2018〜2022年のバックフィルデータで A期タイプを複数サンプル取得してから再検討
- **今回の +¥13K → +¥13K 維持が "成功"**: Calmar 9.37 は現状で十分、余計な手を入れないことが正解

## 大型株 universe 拡張 + モメンタム戦略検証（2026-04-22実施）

**結論: 既存GU/PSCは中小型株(≤¥2,500)専用。大型株ではシグナル未発火または赤字。**
**大型株モメンタム戦略はエッジ確認（単独PF 2.63, WF堅牢 ✓）、combined統合でも害なし（Calmar 7.47 → 7.46 維持、NetRet +2%）、ただし既存が強すぎて本番投入ROIは低い。**

運用capacity上限（¥5-10M）突破可能性を探るため、(1) 既存戦略で大型株ユニバース拡大が機能するか、(2) 大型株向けモメンタム戦略を追加した場合の効果、の2方向を検証。

### Step 1: 既存GU/PSCで大型株追加検証（却下）

```bash
npm run backtest:combined -- --compare-max-price --budget 10000000 --start 2024-03-01
```

**結果（¥10M budget, maxPrice sweep）:**

| maxPrice | Trades | PF | MaxDD | NetRet | Calmar |
|---|---:|---:|---:|---:|---:|
| **≤2,500 (現状)** | 228 | **3.01** | 10.3% | **+71.6%** | **3.24** |
| ≤5,000 | 186 | 2.97 | 11.1% | +54.0% | 2.27 |
| ≤10,000 | 197 | 3.06 | 11.2% | +57.7% | 2.42 |
| ≤20,000 〜 50,000 | 同上 | - | - | - | - |

**エントリー価格帯別内訳（maxPrice=¥50,000のBT分解）:**

| 価格帯 | Trades | PF | NetPnL |
|---|---:|---:|---:|
| ¥0-2,500 | **172** | **3.59** | **+¥6.1M** |
| ¥2,500-5,000 | 19 | **0.54** | **-¥417K** |
| ¥5,000-10,000 | 6 | 3.29 | +¥102K |
| ¥10,000+ | **0** | - | ¥0 |

**発見:**
- 大型株(¥10,000+)ではGU(3%+gap)・PSC(+15%急騰)が流動性で消化され**シグナル未発火**
- 中価格帯(¥2,500-5,000)は PF 0.54 で赤字、小型株エッジが消える遷移領域
- 中価格帯をuniverseに追加するとポジション枠を赤字シグナルに奪われ**全体Calmar -30%**
- **エッジは¥0-2,500の小型株帯に完全凝縮**。universe拡大は明確に却下

### Step 2: 大型株モメンタム戦略の単独検証

Jegadeesh-Titman 古典派生を `momentum-*.ts` に実装。

```bash
npm run backtest:momentum -- --largecap --budget 10000000 --start 2024-03-01
```

**パラメータ（`MOMENTUM_LARGECAP_PARAMS`, `momentum-config.ts`）:**

| 項目 | 値 | 理由 |
|---|---|---|
| lookbackDays | 120日(6ヶ月) | 古典論文のエッジ最大帯 |
| minReturnPct | +15% | "弱い上昇"を弾く |
| topN | 3 | 上位3銘柄ロング |
| rebalanceDays | 20日(月次) | 標準的turnover |
| minMarketCap | ¥100B (1,000億円) | TOPIX500相当 |
| maxPrice | ¥100,000 | 実質制限なし |
| atrMultiplier | 3.0 | SL幅(maxLossPctでキャップ) |
| **maxLossPct** | **0.10** | **古典モメンタムは-10%ストップ** |
| **beActivationMultiplier** | **999** | **事実上無効(トレンド伸ばし切る)** |
| **trailMultiplier** | **999** | **事実上無効** |
| marketTrendFilter | **false** | 個別株の強さが本質 |
| indexTrendFilter | true | 日経SMA50は維持 |

**重要な設計判断:**

- BEトレーリング無効化が最重要。デフォルトの `beActivation=1.0` だと大型株(低ATR%)では約1.5%上昇で即BE発動 → 微小な押し目で2-3日以内に損切り。初回BTで保有2.5日・PF 0.84(負け) → BE=999に変えて 保有10.2日・PF 2.61 へ劇的改善
- 大型株モメンタムでは全市場breadthフィルターは不要。日経SMA50だけで十分(むしろ combined統合時に全市場breadth = 小型株ノイズが混入して邪魔)
- maxLossPct=0.10 が古典論文の標準(-10〜15%)。デフォルトの0.03では大型株の通常のボラに即つかまる

**検証結果（2024-03 〜 2026-04, budget ¥10M）:**

| 指標 | 値 |
|---|---:|
| Trades | 28 |
| 勝率 | 50.0% |
| **PF** | **2.63** |
| 期待値 | **+9.84%** |
| 平均勝 | +30.00% |
| 平均負 | -10.32% |
| RR比 | 2.91 |
| MaxDD | 6.3% |
| NetRet | **+24.7%** |
| 保有日数 | 12.8日 |

### Step 3: WF検証（7ウィンドウ, largecap プリセット）

```bash
npm run walk-forward:momentum -- --largecap --budget 10000000
```

- **OOS集計PF=4.87、判定「堅牢 ✓」（IS/OOS比=0.38、OOS > IS の健全パターン）**
- 6窓中2窓休止（IS PF<0.5）
- パラメータ安定: atrMultiplier=2.0 が全窓最適
- OOS総トレード10件、勝率70%（サンプル少なめ）
- **Window 6 (2026-01-22〜04-21) OOS=0件**: 直近はシグナル不発

### Step 4: combined BT 統合検証

`combined-simulation.ts` に momentum を第5戦略として追加。`PositionLimits.momMax`、`SimContext.momConfig/momSignals`、exit/rotation/entry ロジックを実装。

```bash
npm run backtest:combined -- --enable-momentum --mom-max 3 --budget 10000000 --start 2024-03-01
```

**baseline比較（¥10M budget）:**

| 指標 | Baseline (GU3+PSC2) | **+MOM3 (GU3+PSC2+MOM3)** | Δ |
|---|---:|---:|---:|
| Trades | 474 | 495 | +21 |
| 勝率 | 45.4% | 46.5% | +1.1% |
| PF | 3.23 | 3.01 | **-7%** |
| 期待値 | +1.16% | +1.24% | +7% |
| MaxDD | 10.7% | 10.9% | +0.2% |
| **NetRet** | +171.1% | **+174.1%** | **+2%** |
| **Calmar(年率)** | **7.47** | **7.46** | ~0 |
| 稼働率 | 13.7% | **18.2%** | **+4.5%** |

**Momentum単独寄与 (in combined):**

- 16 trades, 勝率 43.8%, PF **1.97**, 期待値 **+5.39%**
- NetPnL **+¥857K (+8.6%)**
- 保有15.6日（単独BTと整合）

### Step 5: 実装上の重要な落とし穴

1. **allData の universe 分離**: `precomputeMomentumSignals` は top `topN*2` しか返さないため、combined で3,034銘柄の allData に対してランキングすると上位は小型株が独占 → 後filterで大型株ゼロ → 空集合になる。**precompute 前に `allDataForMom` (大型株のみ868銘柄)を分離して渡す必要がある**
2. **breadth計算の universe 問題**: combined の `precomputed.dailyBreadth` は全3,034銘柄基準。momentum標準BTは868銘柄基準。同じ閾値0.5でも発火日が異なる → MOMENTUM_LARGECAP_PARAMS で `marketTrendFilter: false` に固定し副作用回避
3. **lookback バッファ**: WF で IS startDate からの120日lookbackが必要 → `walk-forward-momentum.ts` で precompute に `isStartWithBuffer = isStart - (lookback+30)日` を渡す実装にしている

### プロ視点での評価と本番判断

**良い点:**
- Momentum単独でPF 1.97・期待値+5.39% の確実なエッジ
- 稼働率 13.7% → 18.2% で idle cash を一部解消
- Calmar維持（害にならない）

**気になる点:**
- 全体PF -7%（Momentum自身が GU/PSC より弱い）
- NetRet改善は +2% のみ
- コスト負担大（gross +¥1.48M → net +¥857K、コスト42%）
- WF勝率70% vs combined勝率43.8%（サンプル少なくばらつき大）

**判定: 実装はフィーチャーフラグで残置、本番投入はPending**

- **現状運用(¥500K〜¥5M)**: 不要。既存 GU/PSC で最適
- **将来の¥10M+運用時**: idle cash対策として再評価候補
- **追加検証必要**: 別universe(TOPIX Core30のみ / 時価総額1兆円+)、別期間(2018-2022)での頑健性確認

### 実装として残したもの（本番への影響なし）

- `src/lib/constants/momentum.ts`: 既存のまま
- `src/backtest/momentum-config.ts`: `MOMENTUM_LARGECAP_PARAMS` プリセットと WFグリッド追加
- `src/backtest/momentum-run.ts`: `--largecap` `--min-market-cap` `--lookback` `--min-return` `--max-price` フラグ追加
- `scripts/walk-forward-momentum.ts`: `--largecap` フラグ + lookback buffer実装
- `src/backtest/combined-simulation.ts`: momentum を第5戦略として統合（`momConfig`, `momSignals`, `PositionLimits.momMax`, rotation exit）
- `src/backtest/combined-run.ts`: `--enable-momentum` `--mom-max` フラグ + 大型株universeロード + 分離allData
- `src/backtest/types.ts`: `MomentumBacktestConfig.minMarketCap` 追加

## 大型株 週足レンジブレイク (WB) 検証（2026-04-22実施）

**結論: 単独・WF・combined全てパス（WF堅牢✓、combined MaxDD改善-10%）。ただしCalmar劣化(7.47→5.67〜6.59)で本番投入はPending扱い。**
**momentumと組合せると両戦略のPF/期待値が相互改善する「WB+MOMシナジー」を確認。**

momentum検証の流れを踏襲。既存 weekly-break は小型株WFで PF 3.12 堅牢だったが「保有3-5日の資金拘束が gapup と比べ効率悪い」で本番見送り。**大型株ユニバースなら1トレードあたり金額が大きく効率改善**の仮説を検証。

### Step 1: 単独BT（BE/trail無効化が最重要）

初回（WF最適の atr=1.0, be=0.5, trail=0.8 を大型株に転用）は momentum 初回と同じく BE早期発動で壊滅:

- 185 trades, PF 1.13, **MaxDD 21.2%**, 保有1.4日, NetPnL **-¥656K**

BE=0.5×ATR は大型株の低ATR%(約1.5%)だと +2%上昇で即発動 → 微小押し目で2-3日損切り。
BE/trail=999(無効化) + maxLossPct=0.10(-10%) + atr=2.0 で再試行:

```bash
npm run backtest:weekly-break -- --largecap --budget 10000000 --start 2024-03-01
```

| 指標 | 初回(BE=0.5) | **修正後(BE=999)** |
|---|---:|---:|
| Trades | 185 | 71 |
| 勝率 | 37.8% | 40.9% |
| **PF** | 1.13 | **1.38** |
| 期待値 | +0.00% | **+1.57%** |
| 平均勝 | +3.65% | **+14.17%** |
| RR比 | 1.64 | **1.99** |
| MaxDD | 21.2% | **13.0%** |
| 保有日数 | 1.4日 | **11.8日** |
| NetRet | -6.6% | **+3.8%** |
| 稼働率 | 9.5% | **23.1%** |

### Step 2: WF検証（3パラメータグリッド、IS6/OOS3/6窓）

```bash
npm run walk-forward:weekly-break -- --largecap --budget 10000000
```

| Window | IS PF | OOS PF | OOS件数 | OOS勝率 |
|---|---:|---:|---:|---:|
| 1 | 0.70 | 4.95 | 7 | 57.1% |
| 2 | 1.90 | **0.00** | 6 | 0% |
| 3 | 1.74 | 1.65 | 10 | 40% |
| 4 | 0.59 | 1.99 | 16 | 43.8% |
| 5 | 1.95 | 2.27 | 19 | 36.8% |
| 6 | 2.27 | 2.50 | 13 | 38.5% |

**集計: OOS集計PF 1.96, IS/OOS比 0.68, 全窓アクティブ, パラメータ安定(atr=1.5)**
**判定: 堅牢 ✓**

Window 2 が 0件で全敗している点は懸念だが、残り5窓で安定。

### Momentum LC との比較（単独WFレベル）

| 指標 | Momentum LC | **WB LC** |
|---|---:|---:|
| OOS集計PF | 4.87 | 1.96 |
| OOS総trades | 10 | **71 (×7)** |
| OOS勝率 | 70% | 38% |
| 休止窓 | 2/6 | **0/6** |
| 直近Window OOS | 0件 | **13件 PF 2.50** |

**特徴: WBはmomentumより質は低いが量は7倍、全窓稼働で継続性が高い**

### Step 3: combined BT 統合（4パターン比較）

`weekly-break-config.ts` に `WEEKLY_BREAK_LARGECAP_PARAMS` + `generateLargecapWeeklyBreakParameterCombinations` 追加。`combined-run.ts` に `--enable-wb-largecap` `--wb-max` フラグ追加（既存 `wbConfig` サポートを活用）。

```bash
# baseline
npm run backtest:combined -- --budget 10000000 --start 2024-03-01
# + WB のみ
npm run backtest:combined -- --enable-wb-largecap --wb-max 2 --budget 10000000 --start 2024-03-01
# + MOM のみ（参考）
npm run backtest:combined -- --enable-momentum --mom-max 3 --budget 10000000 --start 2024-03-01
# + WB + MOM
npm run backtest:combined -- --enable-wb-largecap --wb-max 2 --enable-momentum --mom-max 3 --budget 10000000 --start 2024-03-01
```

| 構成 | Trades | PF | **MaxDD** | **NetRet** | **Calmar** | 稼働率 |
|---|---:|---:|---:|---:|---:|---:|
| **Baseline (GU3+PSC2)** | 474 | **3.23** | 10.7% | **+171.1%** | **7.47** | 13.7% |
| +MOM3 | 495 | 3.01 | 10.9% | +174.1% | 7.46 | 18.2% |
| **+WB2** | 544 | 2.67 | **9.7%** | +117.7% | 5.67 | 24.0% |
| **+WB2+MOM3** | 559 | 2.66 | **9.6%** | +135.5% | 6.59 | **25.6%** |

**各戦略単独寄与 (in combined):**

| 戦略 | Trades | PF | NetPnL | 期待値 |
|---|---:|---:|---:|---:|
| WB LC (in +WB) | 41 | 1.45 | +¥335K | +0.44% |
| **WB LC (in +WB+MOM)** | 39 | **1.74** | +¥728K | +1.46% |
| MOM LC (in +MOM) | 16 | 1.97 | +¥857K | +5.39% |
| **MOM LC (in +WB+MOM)** | 17 | **2.05** | +¥769K | +4.48% |

### 発見

- **MaxDD 最大改善**: baseline 10.7% → +WB で **9.7%**(-10%)、+WB+MOM で **9.6%**(-10%)。ヘッジ効果あり
- **NetRet 大幅低下**: +WB単体で-31%(171→118%)、+WB+MOM で-21%(171→135%)。WB保有12.8日がGU/PSCの高期待値トレードを資金競合で食う
- **Calmar劣化**: 主KPI Calmar(年率)は baseline 最良。大型株追加系はいずれも劣化
- **稼働率はほぼ倍増**: 13.7% → 25.6%。idle cash解消効果は最大
- **WB+MOMシナジー**: 両方入れると両戦略ともPF/期待値向上。理由: MOM保有14.8日 > WB保有13.0日 で時間軸がずれ、資金競合しない

### プロ視点での本番判断

| 評価軸 | 推奨構成 |
|---|---|
| **Calmar最大化**(CLAUDE.md主KPI) | **Baseline(GU3+PSC2)** |
| MaxDD最小化 | +WB2 or +WB2+MOM3 |
| 稼働率最大化(大資金運用時) | +WB2+MOM3 |

**結論: 実装はフィーチャーフラグで残置、本番投入はPending**

- **現状運用(¥500K〜¥5M)**: 追加しない、baselineが最良
- **¥10M超運用時**: MaxDD -10% + 稼働率倍増が活きる可能性。再評価候補
- **MaxDD重視運用への切替時**: +WB+MOM が選択肢(ただしCalmar代償-12%)

### 実装として残したもの（本番への影響なし）

- `src/backtest/weekly-break-config.ts`: `WEEKLY_BREAK_LARGECAP_PARAMS` + `WEEKLY_BREAK_LARGECAP_PARAMETER_GRID` + `generateLargecapWeeklyBreakParameterCombinations`
- `src/backtest/weekly-break-run.ts`: `--largecap` `--min-market-cap` `--max-price` `--vol-surge` フラグ追加
- `scripts/walk-forward-weekly-break.ts`: `--largecap` フラグ + 大型株グリッド対応
- `src/backtest/combined-run.ts`: `--enable-wb-largecap` `--wb-max` フラグ + WB大型株universe分離
- `src/backtest/types.ts`: `WeeklyBreakBacktestConfig.minMarketCap` 追加

`combined-simulation.ts` は既存 `wbConfig` / `weeklyBreakSignals` / `PositionLimits.wbMax` サポートをそのまま活用。追加変更なし。

## セクター分散上限の検証（2026-04-22実施、不採用）

**結論: 不採用。¥500K運用/¥10M運用どちらでも改善せず、2件/1件制限ではむしろMaxDD+16〜17%悪化する。**

プロの機関投資家で標準的な「同セクター同時保有数上限」を導入できるか検証。相関drawdown削減が期待効果。

```bash
# ¥500K (GU3+PSC2, 最大5枠)
npm run backtest:combined -- --compare-sector --start 2024-03-01

# ¥10M + 全戦略 (GU3+PSC2+WB2+MOM3, 最大10枠)
npm run backtest:combined -- --compare-sector --enable-wb-largecap --wb-max 2 --enable-momentum --mom-max 3 --budget 10000000 --start 2024-03-01
```

### ¥500K / 5枠 結果

| 上限 | Trades | PF | MaxDD | NetRet | Calmar |
|---|---:|---:|---:|---:|---:|
| **制限なし(現状)** | 289 | **3.66** | 9.0% | **180.3%** | **9.37** |
| 3件/セクター | 289 | 3.66 | 9.0% | 180.3% | 9.37 |
| 2件/セクター | 289 | 3.66 | 9.0% | 180.3% | 9.37 |
| 1件/セクター | 280 | 3.40 | 9.9% | 162.3% | 7.67 |

### ¥10M / 10枠 結果

| 上限 | Trades | PF | MaxDD | NetRet | **Calmar** |
|---|---:|---:|---:|---:|---:|
| **制限なし(現状)** | 556 | **2.72** | **9.6%** | **+140.0%** | **6.79** |
| 3件/セクター | 556 | 2.72 | 9.6% | +140.0% | 6.79 |
| 2件/セクター | 544 | 2.55 | **11.1%** | +128.0% | 5.36 |
| 1件/セクター | 541 | 2.65 | **11.2%** | +125.4% | 5.25 |

### 直感に反する発見

**分散上限を入れるとMaxDDがむしろ増える（+16〜17%悪化）。**

1. **3件制限は完全同一結果**: 10枠あっても同セクター4件以上の重複は一度も発生しない
2. **2件/1件制限で捨てる玉は勝ち傾向**: GU/PSC/WB/MOM は「強い銘柄を拾う」戦略で、セクタートレンドがある時は2件目も好調 → 制限すると利益機会を失う
3. **集中リスクは既に自動回避**: 20+セクターの universe + signal filter で実質分散済み

### プロの教訓

**機関投資家的「集中リスク管理」は個別シグナル選別型のシステムトレードには必要ない。**

アクティブ運用では集中が起きる時は「強いセクターに便乗すべき時」で、機械的に切ると機会損失。分散リスク管理は以下の状況で初めて意味を持つ:

- ポジション数が20-30件以上(ETF/mutual fund水準)
- シグナル品質が低く"ランダムに拾う"モード
- レバレッジ高く単一セクターショックで破綻する水準

GU/PSC/WB/MOMを最大10枠で組合せる本プロジェクトではいずれにも該当しない。

### 実装として残したもの（本番への影響なし、将来運用拡大時の再評価用）

- `src/backtest/combined-simulation.ts`: `PositionLimits.maxPerSector` + `SimContext.tickerSectorMap` + `isSectorAtLimit()` ヘルパー + 全5戦略のentry logic に sector check
- `src/backtest/combined-run.ts`: `--max-per-sector N` フラグ、`--compare-sector` 比較モード(レジーム別内訳付き)、`Stock.sector` からのマップロード
- DB `Stock.sector` は既存フィールドを利用（3,092銘柄全てにsector情報あり）

## VIXレジーム別リスク%の可変化（2026-04-22実施、既定変更）

**結論: 既定を `elevated=0.5, high=0.25, crisis=0` に変更。既存実装の high=1.0 は暗黙のバグで、CLAUDE.md の「高ボラでサイズ縮小」コンセプトと矛盾していた。24ヶ月BTで high レジームは未発生のため既存BT結果への影響なし（保険的変更）。**

### 背景

既存実装は `if (todayRegime === "elevated") quantity /= 2` のハードコードで、`high` レジーム(VIX 25-35)では full size のまま走っていた。crisis(VIX>35)はエントリー停止されるが、high は素通し = 意図しない高リスクエントリー。

### 検証

```bash
npm run backtest:combined -- --compare-vix-risk --start 2024-03-01
```

`SimContext.riskScaleByRegime?: Partial<Record<RegimeLevel, number>>` を追加し、5パターンで比較:

| パターン | Trades | PF | MaxDD | NetRet | Calmar |
|---|---:|---:|---:|---:|---:|
| **規定(0.5/0.25)** | 289 | **3.66** | **9.0%** | **+180.3%** | **9.37** |
| 旧規定(0.5/1.0) | 289 | 3.66 | 9.0% | +180.3% | 9.37 |
| 厳格(0.25/0.125) | 282 | 3.26 | 10.1% | +149.6% | 6.89 |
| 緩和(0.75/0.5) | 266 | 3.47 | 11.5% | +163.3% | 6.62 |
| 一定(0.5/0.5) | 289 | 3.66 | 9.0% | +180.3% | 9.37 |

### 発見

- **規定 vs 旧規定 vs 一定 が完全同一** = この24ヶ月期間で high レジームが一度も発生していない
- レジーム別内訳でも A/C/E 期は全パターン同じ、B/D期でのみ elevated が一部発生
- **elevated=0.5 がこの期間では最適**(厳格・緩和どちらもCalmar劣化)
- high 閾値の最適化は長期データ(2020 COVID, 2022金利急騰期)が必要

### 既定値の決定

新既定: `{ elevated: 0.5, high: 0.25, crisis: 0 }`

- **BT期間では完全に無害**(high未発生で差分ゼロ)
- **将来の high 相場で保守的**(従来は full size だった場面で 1/4)
- CLAUDE.md の「リスク管理: 損切りラインの自動設定、連敗時の自動ポジション縮小」コンセプトと整合
- "バグ修正" 的位置づけ(明らかに意図せざる挙動を正しく制御に修正)

### 実装変更

- `src/backtest/combined-simulation.ts`: `getRegimeRiskScale()` ヘルパー追加、`SimContext.riskScaleByRegime` オプション追加、5戦略の hardcoded `elevated` 処理を可変化
- `src/backtest/combined-run.ts`: `--compare-vix-risk` 比較モード追加

本番コード(trading-*.ts / watchlist-builder / entry-executor)は BT側から独立しており、本変更の影響を受けない。運用側でも同様のレジーム別scalingを適用したい場合は別途実装が必要(本変更はBTのみ)。

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
