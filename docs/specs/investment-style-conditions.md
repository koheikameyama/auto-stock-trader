# 投資スタイル別 分析条件リファレンス

投資スタイル（安定配当型/成長投資型/アクティブ型）ごとの、おすすめ・購入分析・ポートフォリオ分析で適用される条件・閾値・ロジックの一覧。

## 目次

- [1. 投資スタイルの定義](#1-投資スタイルの定義)
- [2. 共通セーフティルール（ルールベース強制補正）](#2-共通セーフティルールルールベース強制補正)
- [3. 日次おすすめ（Daily Recommendation）](#3-日次おすすめdaily-recommendation)
- [4. 購入分析（Purchase Recommendation）](#4-購入分析purchase-recommendation)
- [5. ポートフォリオ分析（Portfolio Analysis）](#5-ポートフォリオ分析portfolio-analysis)
- [6. 出口戦略（利確・損切り）](#6-出口戦略利確損切り)
- [7. 補助指標・共通閾値](#7-補助指標共通閾値)
- [8. 地合い動的閾値（防御モード）](#8-地合い動的閾値防御モード)
- [9. 決算・配当権利落ち対応](#9-決算配当権利落ち対応)
- [10. ギャップアップモメンタムシグナル](#10-ギャップアップモメンタムシグナル)
- [11. UX解説テキスト（補正理由の表示）](#11-ux解説テキスト補正理由の表示)
- [12. ソースファイル一覧](#12-ソースファイル一覧)

---

## 1. 投資スタイルの定義

> ソース: `lib/constants.ts:33-109`

| 項目 | 安定配当型（CONSERVATIVE） | 成長投資型（BALANCED） | アクティブ型（AGGRESSIVE） |
|---|---|---|---|
| アイコン | 🛡️ | ⚖️ | 🚀 |
| ラベル | 安定配当型 | 成長投資型 | アクティブ型 |
| コンセプト | 資産保護を最優先 | リスクとリワードのバランス | 利益の最大化を優先 |
| ユーザー心理 | 「損をしたくない」 | 「リスク・リワードを取りたい」 | 「機会損失を最も嫌う」 |
| 重視するトレンド | 長期トレンド | 中期トレンド | 短期モメンタム |
| GOを出す条件 | 下値確認（RSI反発+支持線維持） | トレンド転換（ゴールデンクロス等） | モメンタム出現（出来高急増+高値突破） |
| 迷った時のデフォルト | avoid（見送り） | stay（様子見） | stay（ウォッチ継続） |

---

## 2. 共通セーフティルール（ルールベース強制補正）

AIの判断に対して**ルールベースで強制的に補正**するロジック。おすすめ候補の除外と、購入分析の buy→stay 変更の両方で使用。

> ソース: `lib/stock-safety-rules.ts`, `lib/constants.ts:381-474`

### 2-1. 急騰ブロック（isSurgeStock）

週間変化率がこの値以上の場合、buy→stay に強制補正（おすすめからは除外）。

| スタイル | 閾値 | 定数名 |
|---|---|---|
| 安定配当型 | +20% | `MOMENTUM.CONSERVATIVE_SURGE_THRESHOLD` |
| 成長投資型 | +25% | `MOMENTUM.BALANCED_SURGE_THRESHOLD` |
| アクティブ型 | +50% | `MOMENTUM.AGGRESSIVE_SURGE_THRESHOLD` |
| デフォルト | +25% | `MOMENTUM.DEFAULT_SURGE_THRESHOLD` |

### 2-2. 下落ブロック（isInDecline）

週間変化率がこの値以下の場合、buy→stay に強制補正（おすすめからは除外）。

| スタイル | 閾値 | 定数名 |
|---|---|---|
| 安定配当型 | -10% | `MOMENTUM.CONSERVATIVE_DECLINE_THRESHOLD` |
| 成長投資型 | -15% | `MOMENTUM.BALANCED_DECLINE_THRESHOLD` |
| アクティブ型 | -20% | `MOMENTUM.AGGRESSIVE_DECLINE_THRESHOLD` |
| デフォルト | -15% | `MOMENTUM.DEFAULT_DECLINE_THRESHOLD` |

### 2-3. 危険銘柄（isDangerousStock）

**赤字 かつ ボラティリティ > 50%** の場合、全スタイル共通で除外/補正。

### 2-4. 過熱圏ブロック（isOverheated）

25日移動平均線からの乖離率が **+20%以上** の場合、buy→stay に強制補正。

| スタイル | 適用 |
|---|---|
| 安定配当型 | ブロック |
| 成長投資型 | ブロック |
| アクティブ型 | **スキップ**（`MOMENTUM.AGGRESSIVE_SKIP_OVERHEAT = true`） |

> 閾値: `MA_DEVIATION.UPPER_THRESHOLD = 20`（%）

### 2-5. ギャップアップ急騰ブロック（getGapUpSurgeThreshold）

ギャップアップ率がこの値以上の場合にブロック。

| スタイル | 閾値 | 定数名 |
|---|---|---|
| 安定配当型 | 10% | `TIMING_INDICATORS.GAP_UP_SURGE_CONSERVATIVE` |
| 成長投資型 | 15% | `TIMING_INDICATORS.GAP_UP_SURGE_BALANCED` |
| アクティブ型 | 20% | `TIMING_INDICATORS.GAP_UP_SURGE_AGGRESSIVE` |

### 2-6. テクニカルブレーキ（getTechnicalBrakeThreshold）

combinedTechnical.strength がこの値以上の場合、buy→stay に補正。

| スタイル | 閾値 | 定数名 |
|---|---|---|
| 安定配当型 | 70% | `TECHNICAL_BRAKE.CONSERVATIVE` |
| 成長投資型 | 75% | `TECHNICAL_BRAKE.BALANCED` |
| アクティブ型 | 85% | `TECHNICAL_BRAKE.AGGRESSIVE` |

### 2-7. 赤字×急騰（isUnprofitableSurge）

赤字企業が週間 **+20%以上** 急騰している場合、仕手株やバブルの可能性が高いとして補正。

> 閾値: `MOMENTUM.UNPROFITABLE_SURGE_THRESHOLD = 20`

---

## 3. 日次おすすめ（Daily Recommendation）

> ソース: `lib/recommendation-scoring.ts`, `lib/prompts/daily-recommendation-prompt.ts`

### 3-1. スコアリング重み配分

各指標を 0-100 に正規化し、重み付け合計でスコア算出。

> ソース: `lib/recommendation-scoring.ts:38-45`

| 指標 | 安定配当型 | 成長投資型 | アクティブ型 |
|---|---|---|---|
| weekChangeRate（モメンタム） | 15% | 25% | 35% |
| volumeRatio（出来高） | 15% | 25% | 30% |
| volatility（ボラティリティ） | 30%（低い方が高スコア） | 25% | 20% |
| marketCap（時価総額） | 40% | 25% | 15% |

- 安定配当型のみ volatility を**反転**（低ボラ = 高スコア）

### 3-2. リスクペナルティ

赤字 AND 高ボラティリティ（>50%）の銘柄へのスコア減算。

| スタイル | ペナルティ |
|---|---|
| 安定配当型 | -30点 |
| 成長投資型 | -20点 |
| アクティブ型 | -10点 |

### 3-3. 急騰ペナルティ（スコアリング内）

| 条件 | 安定配当型・成長投資型 | アクティブ型 |
|---|---|---|
| 週間 +30%以上 | -20点 | なし |
| 週間 +20%以上 | -10点 | なし |

### 3-4. 下落ペナルティ（スコアリング内）

| 条件 | ペナルティ |
|---|---|
| 週間変化率 ≤ スタイル別閾値 | -25点（`STRONG_DECLINE_SCORE_PENALTY`） |
| 週間変化率 ≤ 閾値+3% | -15点（`DECLINE_SCORE_PENALTY`） |

### 3-5. 移動平均乖離率ペナルティ/ボーナス

| 条件 | スコア | 備考 |
|---|---|---|
| 乖離率 ≥ +20% | -20点 | アクティブ型はスキップ |
| 乖離率 ≤ -20% AND 黒字 AND ボラ≤30% | +10点 | 全スタイル |

### 3-6. セクタートレンドボーナス/ペナルティ

| 条件 | スコア |
|---|---|
| compositeScore ≥ 40（強い追い風） | +15点 |
| compositeScore ≥ 20（追い風） | +10点 |
| compositeScore ≤ -20（逆風） | -5点 |
| compositeScore ≤ -40（強い逆風） | -10点 |

### 3-7. 候補除外（スコアリング前）

以下に該当する銘柄はスコアリング対象から完全除外。

- `isDangerousStock`（赤字×高ボラ）→ 全スタイル除外
- `isSurgeStock`（急騰閾値超え）→ スタイル別閾値で除外
- `isInDecline`（下落閾値以下）→ スタイル別閾値で除外
- `isOverheated`（過熱圏）→ アクティブ型以外で除外
- 異常急騰: 週間 +50%超（アクティブ型は +80%超）→ 完全除外

### 3-8. AI選定基準（プロンプト）

> ソース: `lib/prompts/daily-recommendation-prompt.ts:59-83`

| 観点 | 安定配当型 | 成長投資型 | アクティブ型 |
|---|---|---|---|
| 銘柄規模 | 大型株優先 | バランス | 小型～中型成長株 |
| ボラティリティ | 低ボラ | 中間 | 高ボラ許容（黒字なら） |
| 業績 | 黒字必須 | 黒字優先（成長赤字も可） | 赤字×高ボラ以外は可 |
| 急騰 | +25%以上避ける | +35%以上避ける | モメンタム重視 |
| 下落 | -10%以下避ける | -15%以下避ける | -20%以下避ける |
| 過熱圏 | 避ける | 避ける | OK |
| バリュー/グロース比率 | バリュー4-5:グロース2-3 | 半々 | グロース4-5:バリュー2-3 |

### 3-9. セクター分散・予算フィルタ

- **セクター上限**: 各セクターから最大5銘柄（`SCORING_CONFIG.MAX_PER_SECTOR`）
- **AI入力上限**: 最大15銘柄（`SCORING_CONFIG.MAX_CANDIDATES_FOR_AI`）
- **予算フィルタ**: 予算×1.5倍までを候補、スコアリング後に予算内を優先（5件未満なら予算超も追加）

---

## 4. 購入分析（Purchase Recommendation）

> ソース: `lib/prompts/purchase-recommendation-prompt.ts`, `lib/style-analysis.ts`

### 4-1. AI判断基準（プロンプト）

| 観点 | 安定配当型 | 成長投資型 | アクティブ型 |
|---|---|---|---|
| 重視トレンド | 長期トレンド | 中期トレンド | 短期モメンタム |
| buy条件 | 長期2つ以上が上昇、またはR/R比1:3以上 | 中期が上昇 | 短期が上昇 |
| 長期down時 | 原則 stay/avoid | 中期で判断 | 短期モメンタムあれば buy OK |
| confidence | 2つ以上上昇でないと≤0.65 | - | - |
| 迷ったら | avoid | stay | stay |
| アドバイスのトーン | リスク限定・慎重エントリー | リスク/リターン両面 | アップサイドと攻める理由 |
| 赤字銘柄 | セクター買いなら短期戦で提案可（caution必須） | - | - |
| リバウンド狙い | - | - | 引け強い+出来高あれば積極buy |

### 4-2. セーフティルール適用（ルールベース後処理）

> ソース: `lib/style-analysis.ts:83-193`

AIが buy を出しても、以下の条件でルールベースで stay に強制変更:

1. **下落トレンド**: `isInDecline()` → buy→stay、confidence に -0.1 ペナルティ
2. **急騰銘柄**: `isSurgeStock()` → buy→stay
3. **過熱圏**: `isOverheated()` → buy→stay、confidence に -0.15 ペナルティ（アクティブ型はスキップ）

### 4-3. 買いタイミング判定

buy 推奨の場合、エントリータイミングを判定:

| 条件 | タイミング |
|---|---|
| 乖離率 > 5% OR RSI > 70 | `dip`（押し目買い推奨） |
| 上記以外 | `market`（成行買い可） |

### 4-4. 撤退ライン率・売却目標率の目安

リスクリワード比1:3以上を保証（売却目標率 >= 撤退ライン率 × 3）。ATRベースの最低撤退幅を適用後、売却目標率が不足する場合はシステムが自動引き上げ。

| スタイル | 撤退ライン率 | 売却目標率 |
|---|---|---|
| 安定配当型 | 0.03〜0.10 | 0.09〜0.30 |
| 成長投資型 | 0.05〜0.15 | 0.15〜0.45 |
| アクティブ型 | 0.07〜0.20 | 0.21〜0.60以上 |

撤退ライン率が上限を超えた場合、buy → stay に降格（ボラティリティが高すぎてリスクに見合わない）:

| スタイル | 撤退ライン率の上限 | 超えたら |
|---|---|---|
| 安定配当型 | 10% | buy → stay |
| 成長投資型 | 15% | buy → stay |
| アクティブ型 | 20% | buy → stay |

### 4-5. アクティブ型リバウンド狙いロジック

> ソース: `lib/constants.ts:452-466`

安定配当型・成長投資型が stay でも、以下の条件でアクティブ型のみ buy に昇格:

| 条件 | 閾値 |
|---|---|
| 引けにかけて強い（ローソク足分析の強度） | ≥ 55% |
| 出来高を伴う（20日平均比） | ≥ 1.5倍 |
| リバウンド時の confidence | 0.60 |
| 引け強い＋出来高ありの confidence | 0.65 |
| 既にbuyのアクティブ型への confidence ブースト | +0.05 |

### 4-6. avoid（見送り推奨）の条件

- 「かなり強いマイナス条件」が揃った場合のみ
- 複合条件: 赤字継続+改善兆候なし、全テクニカルが強いネガティブ、致命的悪材料
- confidence 0.8以上、迷う場合は stay

### 4-7. ねじれ局面（短期down × 長期up）

- 全スタイル stay とし、buyCondition で押し目価格と戦略を提示
- アクティブ型の confidence は他スタイルより高めに設定可能

---

## 5. ポートフォリオ分析（Portfolio Analysis）

> ソース: `lib/prompts/portfolio-analysis-prompt.ts`, `lib/style-analysis.ts`

### 5-1. AI判断基準（プロンプト）

| 観点 | 安定配当型 | 成長投資型 | アクティブ型 |
|---|---|---|---|
| 重視点 | 早めの利確・損切り | 中期トレンド | 利益最大化 |
| 短期テクニカル悪化 | sell検討を早めに | 中期上昇なら hold | 中長期上昇なら hold |
| 含み益あり | 早めの利確提案 | 部分利確 | 利確は遅め |
| 推奨売却割合 | 高め（75-100%） | 中間 | 低め（25-50%） |
| 買い増し | 慎重 | 中間 | 上昇トレンドなら積極的 |
| recommendation | buy / hold / sell | buy / hold / sell | buy / hold / sell |

### 5-2. 利益確定促進ルール

含み益がある状態で短期下落予兆がある場合の利確条件。

> ソース: `lib/constants.ts:404-414`

| スタイル | 最低含み益率 | 推奨売却割合 | 定数名 |
|---|---|---|---|
| 安定配当型 | +3%以上 | 75% | `PROFIT_TAKING_PROMOTION.CONSERVATIVE_*` |
| 成長投資型 | +8%以上 | 50% | `PROFIT_TAKING_PROMOTION.BALANCED_*` |
| アクティブ型 | +15%以上 | 25% | `PROFIT_TAKING_PROMOTION.AGGRESSIVE_*` |

### 5-3. 売りタイミング判断の閾値

> ソース: `lib/constants.ts:417-426`

| 閾値 | 値 | 用途 |
|---|---|---|
| 乖離率下限 | -5% | これ未満で戻り売り推奨 |
| RSI売られすぎ | 30 | これ未満で戻り売り推奨 |
| パニック売り閾値 | スタイル別（下記参照） | これ以下でsell→hold強制補正 |
| 利確優先閾値 | +10% | これ以上で利確優先 |
| 損切り優先閾値 | -15% | これ以下で損切り優先 |
| 平均購入価格近接 | +5%以内 | 指値提案用 |
| トレンド保護無視閾値 | -15% | これ以上の損失で中長期トレンド保護を無視 |

#### パニック売り防止ルール（スタイル別閾値）

> ソース: `lib/constants.ts` `SELL_TIMING.PANIC_SELL_THRESHOLD`

25日移動平均線からの下方乖離率が閾値以下の場合、sell→hold（ポートフォリオ）/ avoid→stay（購入判断）に強制補正する。

| スタイル | 閾値 | 説明 |
|---|---|---|
| 安定配当型 | 無効（null） | 損切りを絶対優先。パニック売り防止は適用しない |
| 成長投資型 | -25% | やや深めに設定。-25%以下で発動 |
| アクティブ型 | -20% | リバウンド狙いを重視。現状維持 |

**解除条件（以下のいずれかを満たす場合、パニック売り防止は適用しない）:**

1. **市場パニック時**: 日経平均の週間変化率が-7%以下（`isMarketPanic`）
2. **VIX高水準**: VIX（恐怖指数）が30以上（`GEOPOLITICAL_RISK.VIX_HIGH`）
3. **損切りライン到達時**（ポートフォリオ分析のみ）: 含み損が-15%以下（`SELL_TIMING.STOP_LOSS_THRESHOLD`）

### 5-4. セーフティルール適用（ルールベース後処理）

> ソース: `lib/style-analysis.ts:199-235`

- **急騰銘柄の買い増し抑制**: `isSurgeStock()` → buy→hold に変更（スタイル別閾値）

### 5-5. 下落トレンド中の買い増し見送り目安

| スタイル | 閾値 |
|---|---|
| 安定配当型 | 週間変化率 -10%以下 |
| 成長投資型 | 週間変化率 -15%以下 |
| アクティブ型 | 週間変化率 -20%以下 |

### 5-6. 急騰後の利確検討目安

| スタイル | 閾値 |
|---|---|
| 安定配当型 | 週間 +20%以上 |
| 成長投資型 | 週間 +25%以上 |
| アクティブ型 | 週間 +50%以上 |

### 5-7. 購入直後の猶予期間

> ソース: `lib/constants.ts:171-177`

| 項目 | 値 |
|---|---|
| 猶予期間 | 3日間（売り推奨を抑制） |
| 強制警告閾値 | -15%（猶予期間中でも警告） |

### 5-8. 安定配当型の戦略的ホールド例外

以下の**3条件すべて**を満たす場合に限り、短期下落でも hold を許容:

1. 長期トレンド（longTermTrend）が明確に「up」
2. 下落の主因が市場全体の軟調（銘柄の相対強度がアウトパフォーム or 中立）
3. 強いサポートラインの上に株価が位置している

### 5-9. ねじれ局面（短期down × 中長期up）のスイング戦略

hold 判定時、advice の末尾にスイングシミュレーションを追記:
- 現在の保有数量 × 現在価格 = 売却金額
- 短期予測安値で再購入した場合の株数を推計
- 差分を具体的に提示（+○株の可能性）
- 売買手数料・タイミングリスクの注意も添える

---

## 6. 出口戦略（利確・損切り）

### 6-1. 損切り・利確の係数

> ソース: `lib/constants.ts:43-56`

ボラティリティ（ATR）に係数を乗算して損切り・利確ラインを算出。

| 項目 | 安定配当型 | 成長投資型 | アクティブ型 |
|---|---|---|---|
| 損切り係数 | 1.5（タイト） | 2.5（標準） | 4.0（ワイド） |
| 利確係数 | 1.0（早め確定） | 1.5（標準、R/R 1:2） | 2.0（野心的） |

### 6-2. フォールバック損切り率

ATRが利用できない場合のフォールバック。

> ソース: `lib/constants.ts:60-68`

| スタイル | フォールバック損切り率 |
|---|---|
| 安定配当型 | 5% |
| 成長投資型 | 8% |
| アクティブ型 | 12% |

### 6-3. 利確マイルストーン

利益率が以下に達したら通知: **10%、20%、30%**

---

## 7. 補助指標・共通閾値

### 7-1. テクニカル指標の閾値

> ソース: `lib/constants.ts:142-169`

| 指標 | 閾値 | 値 |
|---|---|---|
| RSI 買われすぎ | OVERBOUGHT | 70 |
| RSI やや買われすぎ | SLIGHTLY_OVERBOUGHT | 60 |
| RSI 売られすぎ | OVERSOLD | 30 |
| RSI やや売られすぎ | SLIGHTLY_OVERSOLD | 40 |
| MACD 強い上昇 | STRONG_UPTREND | 1 |
| MACD 上昇 | UPTREND | 0 |
| MACD 強い下落 | STRONG_DOWNTREND | -1 |
| 時価総額（大型） | LARGE | 10,000（10兆円以上） |
| 時価総額（中型） | MEDIUM | 1,000（1,000億円以上） |
| 配当利回り（高） | HIGH | 4% |
| 配当利回り（普通） | NORMAL | 2% |
| PBR 適正 | FAIR_VALUE | 1未満=割安 |
| PBR やや高め | SLIGHTLY_HIGH | 1.5 |

### 7-2. 出来高分析の閾値

> ソース: `lib/constants.ts:429-434`

| 項目 | 閾値 | 意味 |
|---|---|---|
| 分配売り | 下落日出来高/上昇日出来高 ≥ 1.5 | 構造的な下落シグナル |
| 出来高薄い調整 | 下落日出来高/上昇日出来高 ≤ 0.7 | 一時的な下落 |
| 分析対象日数 | 直近10日 | - |

### 7-3. タイミング補助指標

> ソース: `lib/constants.ts:437-450`

| 指標 | 閾値 | 用途 |
|---|---|---|
| ギャップアップ警告 | 5%以上 | AIに警告指示 |
| 出来高急増（異常） | 5.0倍以上 | 仕手株リスク判定 |
| 出来高急増（材料確認） | 2.0倍以上 | AIに材料確認指示 |
| 出来高急増（注目） | 1.5倍以上 | 注目度上昇 |

### 7-4. 相対強度分析

> ソース: `lib/constants.ts:477-484`

| 項目 | 閾値 |
|---|---|
| アウトパフォーム | 銘柄変化率 - 市場変化率 ≥ +3% |
| アンダーパフォーム | 銘柄変化率 - 市場変化率 ≤ -3% |
| sell→hold保護 | アウトパフォーム差 ≥ +5% |

### 7-5. 市場指標

> ソース: `lib/constants.ts:223-227`

| 項目 | 閾値 |
|---|---|
| 市場急落判定 | 週間変化率 -5% |
| 上昇トレンド判定 | 週間変化率 +3% |
| 下落トレンド判定 | 週間変化率 -3% |

### 7-6. 移動平均乖離率

> ソース: `lib/constants.ts:368-379`

| 項目 | 値 |
|---|---|
| 計算期間 | 25日移動平均 |
| 上方乖離閾値 | +20% |
| 下方乖離閾値 | -20% |
| 上方乖離時 confidence ペナルティ | -0.15 |
| 下方乖離時 confidence ボーナス | +0.10 |
| 押し目買い推奨の乖離率閾値 | +5%超 |
| RSI過熱判定 | 70超 |

---

## 8. 地合い動的閾値（防御モード）

日経平均の週間変化率が大幅マイナスの場合、全スタイルの閾値を引き締める「防御モード」。

> ソース: `lib/constants.ts`（`MARKET_DEFENSIVE_MODE`）, `lib/market-index.ts`, `lib/stock-safety-rules.ts`

### 8-1. 発動条件

| 項目 | 値 | 定数名 |
|---|---|---|
| パニック閾値 | 週間変化率 -7%以下 | `MARKET_DEFENSIVE_MODE.PANIC_THRESHOLD` |

`MarketIndexData.isMarketPanic` が `true` の場合に防御モードが発動。

### 8-2. 引き締め係数

防御モード発動時、既存閾値に以下の係数を乗算して引き締める。

| 対象 | 係数 | 定数名 | 効果 |
|---|---|---|---|
| 急騰閾値 | ×0.7 | `SURGE_TIGHTENING_FACTOR` | 例: +20% → +14% |
| 下落閾値 | ×0.7（絶対値） | `DECLINE_LOOSENING_FACTOR` | 例: -10% → -7% |
| 過熱閾値 | ×0.75 | `OVERHEAT_TIGHTENING_FACTOR` | 例: +20% → +15% |
| ギャップアップ閾値 | ×0.7 | `GAP_UP_TIGHTENING_FACTOR` | 例: 10% → 7% |
| confidence | -0.1 | `CONFIDENCE_REDUCTION` | 全体的に信頼度低下 |

### 8-3. 適用範囲

| 分析タイプ | 適用内容 |
|---|---|
| 日次おすすめ | 候補フィルタ引き締め、スコアペナルティ |
| 購入分析 | セーフティルール閾値引き締め、プロンプトに防御モード警告 |
| ポートフォリオ分析 | 買い増し閾値引き締め、プロンプトに防御モード警告 |

---

## 9. 決算・配当権利落ち対応

決算直前の買い推奨ブロックと、配当権利落ち後の誤認売り防止。

> ソース: `lib/constants.ts`（`EARNINGS_SAFETY`）, `lib/stock-safety-rules.ts`, `lib/stock-analysis-context.ts`

### 9-1. 決算直前ブロック

| 項目 | 値 | 定数名 |
|---|---|---|
| 買いブロック期間 | 決算3日前〜 | `EARNINGS_SAFETY.PRE_EARNINGS_BLOCK_DAYS` |
| 警告表示期間 | 決算7日前〜 | `EARNINGS_SAFETY.EARNINGS_NEAR_WARNING_DAYS` |
| confidence ペナルティ | -0.1 | `EARNINGS_SAFETY.EARNINGS_NEAR_CONFIDENCE_PENALTY` |

**ルールベース補正:**
- 決算3日前以内: buy → stay に強制変更（全スタイル共通、`correctionExplanation` 付き）
- 決算7日前以内: buy の confidence に -0.1 ペナルティ

### 9-2. 配当権利落ち保護

| 項目 | 値 | 定数名 |
|---|---|---|
| 保護期間 | 権利落ち後3日間 | `EARNINGS_SAFETY.POST_EX_DIVIDEND_DAYS` |

**ルールベース補正（ポートフォリオ分析のみ）:**
- 権利落ち後3日以内 かつ 含み損が -5% 以内: sell → hold に保護（`correctionExplanation` 付き）
- AIプロンプトに「権利落ちによる下落はトレンド転換ではない」旨のコンテキストを挿入

### 9-3. 適用範囲

| 分析タイプ | 決算前 | 配当落ち |
|---|---|---|
| 日次おすすめ | 3日前以内の銘柄を候補から除外 | - |
| 購入分析 | buy→stay強制 + プロンプト警告 | プロンプトで誤認防止 |
| ポートフォリオ分析 | プロンプト警告のみ | sell→hold保護 + プロンプトコンテキスト |

### 9-4. データソース

- `nextEarningsDate`: Stockテーブル（`fetch_earnings_data.py` が yfinance `stock.calendar` の "Earnings Date" から取得）
- `exDividendDate`: Stockテーブル（`fetch_earnings_data.py` が yfinance `stock.calendar` の "Ex-Dividend Date" から取得）
- ※日本株ではyfinanceの配当落ち日データの信頼性が低い場合あり。nullの場合は保護ルール不適用

---

## 10. ギャップアップモメンタムシグナル

小さいギャップアップを安全ブロックだけでなく、正のモメンタムシグナルとしても活用する。

> ソース: `lib/constants.ts`（`GAP_UP_MOMENTUM`）, `lib/candlestick-patterns.ts`, `lib/stock-safety-rules.ts`

### 10-1. 正シグナル判定条件

3条件のうち**2つ以上**を満たす場合に正のモメンタムシグナルと判定。

| 条件 | 閾値 | 定数名 |
|---|---|---|
| ギャップアップ率 | 2%〜5% | `GAP_UP_MOMENTUM.MIN_GAP_UP` / `MAX_GAP_UP` |
| 引けの強さ | ≥ 70% | `GAP_UP_MOMENTUM.CLOSING_STRENGTH_THRESHOLD` |
| 出来高確認 | ≥ 1.3倍 | `GAP_UP_MOMENTUM.VOLUME_CONFIRMATION_THRESHOLD` |

**引けの強さ**: `(close - low) / (high - low) * 100`（`calculateClosingStrength()`）

### 10-2. 効果

| 状況 | 効果 | 定数名 |
|---|---|---|
| アクティブ型が stay の場合 | buy に昇格候補 | - |
| 既に buy の場合 | confidence +0.08 | `GAP_UP_MOMENTUM.CONFIDENCE_BOOST` |

### 10-3. 適用範囲

| 分析タイプ | 適用内容 |
|---|---|
| 日次おすすめ | 適用なし（候補段階ではギャップデータの粒度が不足） |
| 購入分析 | アクティブ型リバウンドロジックに統合 + プロンプト指示 |
| ポートフォリオ分析 | 買い増しシグナルとしてプロンプトコンテキストに追加 |

---

## 11. UX解説テキスト（補正理由の表示）

セーフティルールがAI判断を補正した際、ユーザーに分かりやすい解説テキストを生成・表示する。

> ソース: `lib/correction-explanation.ts`, `lib/style-analysis.ts`, `lib/purchase-recommendation-core.ts`, `lib/portfolio-analysis-core.ts`

### 11-1. 仕組み

- `PurchaseStyleAnalysis` / `PortfolioStyleAnalysis` に `correctionExplanation: string | null` フィールドを追加
- 各セーフティルール補正箇所で `generateCorrectionExplanation()` を呼び出し、テキストを設定
- `styleAnalyses` JSON内のサブフィールドなのでDBスキーマ変更不要

### 11-2. 対応ルールID一覧

| ルールID | 補正内容 | 対象分析 |
|---|---|---|
| `surge_block` | 急騰ブロック（buy→stay） | 購入 |
| `decline_block` | 下落ブロック（buy→stay） | 購入 |
| `overheat_block` | 過熱圏ブロック（buy→stay） | 購入 |
| `gap_up_surge_block` | ギャップアップ急騰ブロック | 購入 |
| `technical_brake` | テクニカルブレーキ | 購入 |
| `unprofitable_surge` | 赤字×急騰（仕手株リスク） | 購入 |
| `market_crash_block` | 市場急落ブロック | 購入 |
| `pre_earnings_block` | 決算直前ブロック | 購入 |
| `panic_sell_protection` | パニック売り防止（sell→hold） | ポートフォリオ |
| `trend_protection` | 中長期トレンド保護（sell→hold） | ポートフォリオ |
| `relative_strength_protection` | 相対強度保護（sell→hold） | ポートフォリオ |
| `profit_taking_promotion` | 利確促進（hold→sell） | ポートフォリオ |
| `surge_buy_block` | 急騰時買い増し抑制（buy→hold） | ポートフォリオ |
| `post_ex_dividend` | 配当権利落ち保護（sell→hold） | ポートフォリオ |
| `defensive_mode_surge` | 防御モード急騰引き締め | 購入 |
| `defensive_mode_decline` | 防御モード下落引き締め | 購入 |
| `defensive_mode_overheat` | 防御モード過熱引き締め | 購入 |
| `defensive_mode_gap_up` | 防御モードギャップアップ引き締め | 購入 |

### 11-3. 表示例

```
週間変化率が+20%を超えており、安定配当型の「急騰ブロックルール」に抵触したため、
押し目を待つ判断になりました。
```

### 11-4. 適用範囲

| 分析タイプ | 適用内容 |
|---|---|
| 日次おすすめ | 適用なし（個別セーフティルール補正がないため） |
| 購入分析 | 全補正箇所に `correctionExplanation` 設定 |
| ポートフォリオ分析 | 全補正箇所に `correctionExplanation` 設定 |

---

## 12. ソースファイル一覧

| ファイル | 内容 |
|---|---|
| `lib/constants.ts` | 全定数（スタイル定義、係数、閾値） |
| `lib/recommendation-scoring.ts` | 日次おすすめのスコアリングロジック |
| `lib/stock-safety-rules.ts` | セーフティルール（急騰/下落/危険/過熱の判定関数） |
| `lib/style-analysis.ts` | 投資スタイル別セーフティルール適用・タイミング判定 |
| `lib/prompts/daily-recommendation-prompt.ts` | 日次おすすめのAIプロンプト |
| `lib/prompts/purchase-recommendation-prompt.ts` | 購入分析のAIプロンプト |
| `lib/prompts/portfolio-analysis-prompt.ts` | ポートフォリオ分析のAIプロンプト |
| `lib/correction-explanation.ts` | UX解説テキスト生成（補正理由テンプレート） |
| `lib/stock-analysis-context.ts` | AIプロンプト用コンテキスト生成（防御モード・決算・配当落ち） |
| `lib/candlestick-patterns.ts` | ローソク足パターン分析（引けの強さ計算） |
| `lib/market-index.ts` | 市場指標データ取得（パニック判定含む） |
| `lib/sector-trend.ts` | セクタートレンドスコアボーナス計算 |
