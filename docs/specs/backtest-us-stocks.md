# 米国株バックテスト検証結果

## サマリ

**個別株戦略（5本）はエッジなし。インデックスオプション系の SPY Credit Spread のみ構造的エッジあり。**

2026-04-16 の初回検証および 2026-04-26 の最新データを含む再検証 + 追加3戦略で確認。
コードは [src/backtest/us/](../../src/backtest/us/) に残置。

### Phase 1: 個別株戦略（5本）— **すべてエッジなし**

| 戦略 | 24ヶ月BT NetRet | WF判定 | 結論 |
|---|---:|---|---|
| GapUp | -34.8% | エッジなし | 不採用 |
| Momentum | -29.7% | エッジなし | 不採用 |
| PEAD | -8.5% | エッジなし | 不採用 |
| Mean Reversion | 0%（シグナル不発） | 検証不能 | 不採用 |
| Wheel (CSP→CC) | +10.7%（24ヶ月BT）| **過学習 ✗（OOS PF 0.25）** | 不採用 |

### Phase 2: インデックス系・代替戦略（3本）— **1本のみエッジ確認**

| 戦略 | BT NetRet | WF判定 | 結論 |
|---|---:|---|---|
| **SPY Credit Spread** (Bull Put) | **+106.2%** (24ヶ月) | **実質堅牢 ✓**（OOS PF 4.86, 勝率96%）| **本番候補** |
| VIX Contango (SVXY) | -5.4% (5年) | 過学習 ✗（OOS PF 0.08）| 不採用 |
| Dual Momentum (Antonacci GEM) | +42% (8年) | 要注意 △（5/7正窓）| 限定的有効 |

## 検証条件

| 項目 | 値 |
|---|---|
| ユニバース | S&P 500 + S&P 600 SmallCap = 1,106銘柄 |
| 期間 | 2024-04-25 〜 2026-04-24（24ヶ月） |
| WF構成 | IS 6ヶ月 / OOS 3ヶ月 × 7ウィンドウ |
| 予算 | $3,300（約50万円相当） |
| データソース | yfinance（OHLCV、決算日、VIX、S&P 500） |
| コスト | SEC fee + spread モデル、T+1 受渡 |

## 戦略別BT結果（2024-04-25 〜 2026-04-24, $3,300）

### GapUp

ギャップアップ +X% & 出来高サージで当日終値エントリー。日本のGU戦略と同型。

| 指標 | 値 |
|---|---:|
| Trades | 504 |
| 勝率 | 42.9% |
| PF | **0.51** |
| 期待値 | -0.63% |
| RR | 0.66 |
| 平均保有日 | 1.2d |
| MaxDD | 35.0% |
| **NetRet** | **-34.8%** |

判定: **エッジなし**。日本中小型株のような遅延エッジが米国大型株では成立しない（流動性・Algo競合）。

### Momentum

クロスセクション・モメンタム（過去N日リターン上位TopNを保有、定期リバランス）。

| 指標 | 値 |
|---|---:|
| Trades | 163 |
| 勝率 | 35.6% |
| PF | **0.41** |
| 期待値 | -1.61% |
| RR | 0.78 |
| 平均保有日 | 3.6d |
| MaxDD | 30.5% |
| **NetRet** | **-29.7%** |

判定: **エッジなし**。短期モメンタムは米国では reversal リスクが大きい。

### PEAD (Post-Earnings Announcement Drift)

決算発表後のサプライズ方向への継続トレンドを狙う。

| 指標 | 値 |
|---|---:|
| Trades | 80 |
| 勝率 | 46.3% |
| PF | **0.38** |
| 期待値 | -0.65% |
| RR | 0.46 |
| 平均保有日 | 1.6d |
| MaxDD | 9.6% |
| **NetRet** | **-8.5%** |

判定: **エッジなし**。古典的アノマリーだが、現代の米国市場では ARM/HFT に先取りされている。

### Mean Reversion

RSI<40 + ボリンジャーバンド下限割れ + 出来高サージで反発を狙う。

| 指標 | 値 |
|---|---:|
| Trades | 0（シグナル不発） |

判定: **検証不能**。エントリー条件（RSI<40 ∧ BB割れ ∧ Vol×1.0以上）が24ヶ月で1度も満たされなかった。条件緩和して再検証する場合は config を見直し。

### Wheel (CSP → assignment → CC サイクル)

OTM Put売り → assignmentで現物取得 → OTM Call売り → called away → 繰り返し。
Black-Scholes で価格付け、デルタベースで権利行使価格選定。

#### 24ヶ月BT

| 指標 | 値 |
|---|---:|
| 完了サイクル | 62 |
| CSP売却 | 62 |
| Assigned率 | 9.7% |
| CC売却 | 45 |
| Called Away率 | 11.1% |
| Early Close率 | 55.1% |
| 受領プレミアム | $492.57 |
| 年率換算プレミアム | 154.5% |
| 平均サイクル日数 | 21.6d |
| MaxDD | 17.0% |
| **NetRet** | **+10.7%** |

#### WF再走（2026-04-26）

| Window | IS PF | OOS PF | OOS Trades | OOS勝率 | 最適パラメータ |
|---:|---:|---:|---:|---:|---|
| 1 | 4.41 | 1.37 | 13 | 92.3% | pd=0.3, dte=45, pt=0.5 |
| 2 | ∞ | **0.10** | 11 | 81.8% | pd=0.15, dte=21, pt=0.5 |
| 3 | 0.63 | ∞ | 7 | 100% | pd=0.15, dte=45, pt=0.5 |
| 4 | 0.58 | 1.46 | 14 | 85.7% | pd=0.3, dte=30, pt=0.5 |
| 5 | ∞ | 0.95 | 4 | 75.0% | pd=0.15, dte=45, pt=0.5 |
| 6 | ∞ | **0.14** | 13 | 84.6% | pd=0.15, dte=21, pt=0.5 |
| 7 | 2.19 | **0.24** | 4 | 75.0% | pd=0.3, dte=45, pt=0.65 |

**集計: OOS PF 0.25, 勝率 86.4%, 全7窓アクティブ → 判定「過学習 ✗」**

判定: **エッジなし**。
- 24ヶ月BTで +10.7% 出たのは"勝ったタイミング"を全部取った結果で、ウィンドウ分割で過学習が露呈
- 勝率86.4%は高いが**負け1発のサイズが平均勝×7倍程度**（assignment後の含み損 → CC で覆えない DD）。Wheelのテール損失構造そのもの
- パラメータが `dte=21/30/45`、`pt=0.5/0.65` で全くバラバラ、安定パラメータが見つからない
- 前回WF（2026-04-16, OOS PF=0.53）と同じ結論

## Phase 2: インデックス系・代替戦略

### SPY Credit Spread (Bull Put) — **本番候補**

#### 戦略

- インデックス（SPY = ^GSPC ÷ 10）の OTM put credit spread
- 売: short put @ delta -0.20（OTM）
- 買: long put @ 5pt下（hedge、max loss定義）
- 受領クレジット → 利益目標50%で早期決済 or 満期保有
- BS価格モデル、VIXをIVプロキシ
- 同時2ポジ、cycle終わったら次

#### 24ヶ月BT結果（2024-04-25 〜 2026-04-24, $3,300予算）

| 指標 | 値 |
|---|---:|
| Spreads | 87 |
| 勝率 | **95.4%** |
| PF | **3.55** |
| 期待値 | +8.05%（max lossに対する%）|
| 平均保有日 | 15.0d |
| Avg Credit Ratio | 18.5% of width |
| MaxDD | 17.8% |
| Sharpe | 1.96 |
| **NetRet** | **+106.2%** |

- Profit Target Hits: 79（早期決済）/ Expired Worthless: 4（満期消滅）/ Max Loss: 3 / Partial: 1

#### WF結果（2024-01-26 〜 2026-04-25, 7ウィンドウ）

| Window | IS PF | OOS PF | OOS勝率 | OOS Trades | パラメータ |
|---:|---:|---:|---:|---:|---|
| 1 | 1.03 | ∞ | 100% | 13 | delta=0.30, dte=35 |
| 2 | ∞ | ∞ | 100% | 13 | delta=0.15, dte=45 |
| 3 | ∞ | **0.15** | 60% | 5 | delta=0.15, dte=35 |
| 4 | 1.93 | ∞ | 100% | 20 | delta=0.30, dte=21 |
| 5 | 2.80 | ∞ | 100% | 15 | delta=0.30, dte=21 |
| 6 | ∞ | ∞ | 100% | 18 | delta=0.15, dte=21 |
| 7 | ∞ | 1.45 | 87.5% | 16 | delta=0.15, dte=21 |

**OOS集計PF 4.86, 勝率 96.0%, 全7窓アクティブ → 実質「堅牢 ✓」**
（自動判定が「過学習 ✗」になっているのは IS=∞/OOS=∞ で IS/OOS比がNaNになるロジックバグ。OOS集計PF 4.86 は堅牢閾値 1.3 を大きく上回る）

#### エッジの構造的根拠

1. **Volatility Risk Premium (VRP)**: implied vol > realized vol が長期的に成立。OTM put 売りは IV を売って RV を買う構造でアルファ
2. **インデックスはガンマ小**: 個別株 Wheel と違い early assignment ほぼなし、テールが定義済み
3. **Profit Target 50%**: 早期決済で時間損失を確実に取り、満期前のドローダウンを回避
4. **VIXフィルター + SMA50**: 大幅なベア相場では新規エントリー停止

#### 残課題

- **Window 3 (2025-01-26〜04-25, OOS PF 0.15)**: 関税ショック期の SPY 急落で max loss 発生
  → ストップロス追加 or VIXフィルター強化で改善余地
- **profit target=0.5 のみ全窓安定**、delta/dte は 2-3値で揺れる → ロバストな1パラメータ固定が望ましい
- **24-30ヶ月のみ検証**：2018年Volmageddon・2020年COVID期での挙動は未検証

### VIX Contango (SVXY) — **エッジなし**

#### 戦略

- SVXY (-0.5x VIX short-term futures ETF) を保有
- VIX <= 22 でエントリー、VIX > 25 で撤退、VIX前日比+20%急上昇で撤退
- ストップロス -10%

#### 5年BT結果（2021-05-01 〜 2026-04-24）

| 指標 | 値 |
|---|---:|
| Positions | 14 |
| 勝率 | 30.8% |
| PF | 0.94 |
| 期待値 | +1.43% |
| MaxDD | **49.6%** |
| NetRet | -5.4% |

#### WF結果

OOS集計PF **0.08**, 勝率 12.5%, 4/7窓アクティブ → **過学習 ✗**

#### 却下理由

- VIX-cap exit 25 が遅すぎ、SVXY が既に大幅下落してから退場
- 14 positions in 5 years（保有期間73日平均）= サンプル少
- 2022 vol regime shift で機能停止

### Dual Momentum (Antonacci GEM) — **限定的有効**

#### 戦略

- 12ヶ月リターン上位の equity ETF (SPY/EFA) を月次リバランスで保有
- 絶対モメンタム陰性なら AGG (米国総合債券) へ退避

#### 8年BT結果（2018-01-01 〜 2026-04-24）

| 指標 | 値 |
|---|---:|
| Rebalances | 100 / Switches | 16 |
| 勝率 | 46.7% |
| PF | 2.15 |
| 期待値 | +3.77% |
| MaxDD | **37.2%** |
| NetRet | +42.0%（年率約4.4%）|
| Asset Participation | SPY 69%, AGG 18%, EFA 13% |

#### WF結果（2021-10〜2026-04, 7ウィンドウ）

| Window | IS PF | OOS PF | OOS Ret% | OOS MaxDD% |
|---:|---:|---:|---:|---:|
| 1 | 0.00 | 休止 | - | - |
| 2 | 0.00 | 休止 | - | - |
| 3 | 164.84 | ∞ | +3.20% | 5.0% |
| 4 | ∞ | 0.00 | 0.00% | 7.8% |
| 5 | ∞ | 0.00 | 0.00% | 16.8% |
| 6 | ∞ | ∞ | +5.04% | 4.7% |
| 7 | ∞ | ∞ | +1.17% | 11.1% |

5/7 アクティブ、3/5 正リターン、合計+9.4%（54ヶ月で年率約2%）→ **要注意 △**

#### 評価

- SPY 単純保有（2018-2026 で年率 ~12%）に大きく劣る
- 252日lookback では COVID/2022bear に反応遅すぎ → MaxDD 37%
- パラメータ不安定（lookback 63/126/252 が窓ごと変動）
- **idle cash の代替としては妥当**（1ファンドで運用、信託料率低、税効率良い）が、Calmar/絶対リターン重視ならSPY買付の方が良い

## 構造的に米国でエッジが出ない理由

1. **流動性とHFT競合**: 日本中小型株（時価総額数百億円帯）にあるような出来高ギャップ・遅延反応エッジは、米国S&P構成銘柄では Algo/HFT に即座に解消される
2. **コスト構造の悪化**: SEC fee + bid/ask spread + T+1金利は、低エッジ戦略では致命的
3. **手数料無料の罠**: $0手数料でも spread と PFOF（Payment For Order Flow）でコスト負担が大きい
4. **Wheel特有のテール**: 高勝率（80-90%）でも assignment 時の含み損で1発の負けが大きく、リスク調整後は赤字

## ファイル一覧

### バックテストエンジン [src/backtest/us/](../../src/backtest/us/)

#### Phase 1: 個別株戦略（不採用、参考用残置）
- PEAD: `us-pead-config.ts` / `us-pead-simulation.ts` / `us-pead-run.ts`
- GapUp: `us-gapup-config.ts` / `us-gapup-simulation.ts` / `us-gapup-run.ts`
- Momentum: `us-momentum-config.ts` / `us-momentum-simulation.ts` / `us-momentum-run.ts`
- Mean Reversion: `us-mean-reversion-config.ts` / `us-mean-reversion-simulation.ts` / `us-mean-reversion-run.ts`
- Wheel: `us-wheel-config.ts` / `us-wheel-simulation.ts` / `us-wheel-run.ts` / `us-wheel-types.ts`

#### Phase 2: インデックス系・代替戦略
- **SPY Credit Spread（本番候補）**: `us-credit-spread-types.ts` / `us-credit-spread-config.ts` / `us-credit-spread-simulation.ts` / `us-credit-spread-run.ts`
- VIX Contango（不採用）: `us-vix-contango-types.ts` / `us-vix-contango-config.ts` / `us-vix-contango-simulation.ts` / `us-vix-contango-run.ts`
- Dual Momentum（限定的）: `us-dual-momentum-types.ts` / `us-dual-momentum-config.ts` / `us-dual-momentum-simulation.ts` / `us-dual-momentum-run.ts`

#### 共通
- `us-types.ts` / `us-data-fetcher.ts` / `us-trading-costs.ts` / `us-simulation-helpers.ts`
- BS価格モデル: [src/core/options-pricing.ts](../../src/core/options-pricing.ts)

### Walk-forward スクリプト [scripts/](../../scripts/)

- Phase 1: `walk-forward-us-pead.ts` / `walk-forward-us-gapup.ts` / `walk-forward-us-momentum.ts` / `walk-forward-us-mean-reversion.ts` / `walk-forward-us-wheel.ts`
- Phase 2: `walk-forward-us-credit-spread.ts` / `walk-forward-us-vix-contango.ts` / `walk-forward-us-dual-momentum.ts`

### データバックフィル

**米国データ収集は別リポジトリ [`auto-us-stock-trader`](../../../auto-us-stock-trader/) に分離済み（2026-04-27）。**

| スクリプト | 内容 |
|---|---|
| `scripts/data/backfill_daily_bars.py` | S&P 500/600 OHLCV |
| `scripts/data/backfill_earnings.py` | 決算日 |
| `scripts/data/backfill_index.py` | ^GSPC, ^VIX |
| `scripts/data/backfill_vol_etfs.py` | VXX/SVXY/UVXY/SVIX/VIXY |
| `scripts/data/backfill_rotation_etfs.py` | SPY/EFA/AGG/QQQ/IWM/TLT/GLD/BND |

GitHub Actions で平日 JST 7:00（米国close後）/ 毎週土曜 JST 8:00 に自動実行。
スキーマ管理は本リポ（auto-stock-trader）の Prisma で継続、データ収集側は psycopg2 直書き。

## 実行方法（再検証する場合）

```bash
# データ更新（auto-us-stock-trader リポで実行）
cd ../auto-us-stock-trader
DATABASE_URL="postgresql://kouheikameyama@localhost:5432/auto_stock_trader" \
  python scripts/data/backfill_daily_bars.py --index sp500 --yes
DATABASE_URL="postgresql://kouheikameyama@localhost:5432/auto_stock_trader" \
  python scripts/data/backfill_daily_bars.py --index sp600 --yes
DATABASE_URL="postgresql://kouheikameyama@localhost:5432/auto_stock_trader" \
  python scripts/data/backfill_index.py --yes
DATABASE_URL="postgresql://kouheikameyama@localhost:5432/auto_stock_trader" \
  python scripts/data/backfill_earnings.py --yes

cd ../auto-stock-trader

# Phase 1: 単体BT
npm run backtest:us-pead
npm run backtest:us-gapup
npm run backtest:us-momentum
npm run backtest:us-mean-reversion
npm run backtest:us-wheel

# Phase 2: 単体BT
npm run backtest:us-credit-spread       # 本番候補
npm run backtest:us-vix-contango        # 却下済
npm run backtest:us-dual-momentum       # 限定的有効

# WF
npm run walk-forward:us-pead
npm run walk-forward:us-gapup
npm run walk-forward:us-momentum
npm run walk-forward:us-mean-reversion
npm run walk-forward:us-wheel
npm run walk-forward:us-credit-spread
npm run walk-forward:us-vix-contango
npm run walk-forward:us-dual-momentum
```

## 既知の不具合

`src/backtest/metrics.ts:31` で `winRate` を 100倍済みなのに run スクリプト群（`us-*-run.ts`）で再度100倍する → 表示が「4286.0%」のような1万倍値になる。実際の値は表示の1/100。本ドキュメント内の数値は補正済。

## 今後の方針

### Phase 1（個別株）の教訓
- **再検証 NG**: 同じ戦略の細かなパラメータ調整は時間の無駄。本ドキュメントを根拠に却下する
- 米国S&P500/600個別株は流動性・HFT競合で日足遅延エッジゼロ

### Phase 2 で確立されたこと
- **インデックスオプションには構造的アルファ（VRP）が存在**：SPY Credit Spread はWFでもOOS PF 4.86
- VIX関連戦略（VIX Contango/SVXY）は米国market微細構造ではエッジなし
- ETFローテーション（Dual Momentum）は SPY 単純保有を上回らないが、idle cash運用としては許容

### 次に試す候補（実装優先度順）

1. **SPY/QQQ Iron Condor**: Bull Put + Bear Call の同時保有で双方向のVRP取得
2. **SPY Calendar Spread**: 異なる満期の同行使価で時間価値差を取得
3. **VIX期間構造ベース動的ポジション**: VX1/VX2 比率で contango/backwardation 判定
4. **個別株 Earnings Strangle Selling**: PEAD と異なり IV crush を狙う売り戦略

### 新規戦略を試す場合の前提

- 期待値 > 0.5%/trade、平均保有10日以上、PF > 1.5 のいずれかを満たさない戦略は最初から検討対象外
- インデックス（SPY/QQQ/IWM）優先、個別株は最終手段
- VRP系（オプション売り）はテール管理が必須（max loss定義済構造を選ぶ）

### SPY Credit Spread 本番投入に向けた残作業

- [ ] 2018-2020期間（Volmageddon, COVID）でのストレステスト
- [ ] 実SPY/SPX option chainデータでのbacktest（現在はBS理論値のみ）
- [ ] bid-ask spread を考慮した実効P&L計算
- [ ] ストップロス追加によるWindow 3的な急落耐性検証
- [ ] 立花証券 / Webull / IBKR でのオプション取引手数料・最低契約数確認
