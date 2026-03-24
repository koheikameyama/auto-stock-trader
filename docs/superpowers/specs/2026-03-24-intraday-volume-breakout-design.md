# イントラデイ出来高ブレイクアウト戦略 設計書

## 背景

### スコアリングシステムの構造的問題

ScoringRecord 309K件の分析により、現行スコアリングの全サブコンポーネントが5日リターンと**逆相関**であることが判明した。

| サブスコア | 高スコアEV (5日) | 低スコアEV (5日) |
|---|---|---|
| MA整列 (18pt) | +0.49% | +0.70% |
| トレンド継続 (10pt) | +0.45% | +0.72% |
| 押し目深さ (15pt) | +0.49% | +0.73% |
| ATR安定性 (10pt) | +0.52% | +0.73% |

75+帯はOOS PF 2.08で機能しているが、0-74帯のスコアには予測力がない。「教科書的な押し目買い」は市場に織り込み済み。

### パラダイムシフト

「予測してからエントリー」→「確認してからエントリー」に転換する。立花証券APIのリアルタイム時価取得を活用し、出来高急増+価格ブレイクアウトという**観測可能な事象**をトリガーとする。

## 設計方針

- 現行のスコアリング（100点満点）とAIレビュー（Go/No-Go）を**エントリー判断から廃止**
- ゲート（リスク管理フィルター）は維持
- 検証済みのエグジットロジック（トレーリングストップ+タイムストップ）は維持
- 立花証券APIのリアルタイム時価取得でザラ場中にシグナル検知

## システム全体フロー

```
┌─ 前場前 (8:00) ──────────────────────────────────────────────────┐
│                                                                    │
│  market-assessment (現行維持)                                       │
│    └─ VIX / CME / 日経 → shouldTrade? regime判定                   │
│                                                                    │
│  watchlist-builder (新規)                                          │
│    └─ DB全銘柄 → ゲートフィルター → ウォッチリスト (~90銘柄)        │
│    └─ 各銘柄の25日平均出来高・20日高値をキャッシュ                   │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
                              ↓
┌─ ザラ場 (9:00-15:00) ────────────────────────────────────────────┐
│                                                                    │
│  breakout-scanner (新規, 5分間隔)                                  │
│    └─ ウォッチリスト全体(~90銘柄)の出来高・現在値を取得            │
│    └─ volumeSurgeRatio ≥ 1.5 → ホットリストに昇格                  │
│                                                                    │
│  breakout-scanner (ホットリスト, 1分間隔)                          │
│    └─ volumeSurgeRatio ≥ 2.0 AND 現在値 > 20日高値 → トリガー発火  │
│    └─ → entry-executor へ                                          │
│                                                                    │
│  entry-executor (新規)                                             │
│    └─ リスク計算（ATRベースSL, ポジションサイズ）                   │
│    └─ 指値注文 + 逆指値SL → 立花証券API                             │
│                                                                    │
│  position-monitor (現行維持)                                       │
│    └─ 約定監視・トレーリングストップ・タイムストップ                │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

## コンポーネント詳細

### 1. ウォッチリスト・ビルダー

**実行タイミング**: 朝8:00（market-assessmentの後）

**入力**: DB上の全銘柄（Stockテーブル）

**ゲート条件**:

| ゲート | 条件 | 目的 |
|---|---|---|
| 流動性 | 25日平均出来高 ≥ 50,000株 | 約定確実性 |
| 価格 | 終値 ≤ 5,000円 | 予算制約（現行SCORING.GATES.MAX_PRICEと同値。ポジションサイズは2%リスクルールで自然に制約される） |
| 最低ボラ | ATR(14)/終値 ≥ 1.5% | スイング適性 |
| 週足下降トレンド | 週足終値 > 週足SMA13 | 落ちるナイフ回避 |
| 決算接近 | 決算まで5日超 | 決算ギャップ回避 |
| 配当接近 | 権利落ちまで3日超 | 配当落ち回避 |

**出力**:

```typescript
interface WatchlistEntry {
  ticker: string;
  avgVolume25: number;      // 25日平均出来高（ブレイクアウト判定の基準）
  high20: number;           // 過去20営業日の最高値（日足のhighカラム。終値ではなくザラ場高値）
  atr14: number;            // ATR（SL計算用）
  latestClose: number;      // 前日終値
}
```

ゲート判定に必要なテクニカルデータは前日終値ベースでDBから取得。ザラ場中のAPI呼び出しは不要。ウォッチリストはインメモリで保持し、DBには保存しない。

### 2. ブレイクアウト・スキャナー

**実行環境**: workerプロセス内のnode-cronジョブ（**1分間隔の単一cron**として実装）

breakout-scannerは1分間隔の単一cronジョブとして実行し、内部でCold/Hotの判定を行う。各銘柄の`lastColdScanTime`を保持し、前回のColdスキャンから5分以上経過した銘柄のみColdスキャンを実行する。ホットリスト・トリガー済みセット・降格カウンターはインメモリのMapで管理する。これによりCold/Hot間の競合やレースコンディションを回避する。

**ティアード・ポーリング**:

| ティア | 対象 | 頻度 | API呼び出し |
|---|---|---|---|
| Cold | ウォッチリスト全体 (~90銘柄) | 5分間隔 | ~1,080 calls/時 (90×12) |
| Hot | 出来高急増候補 (~5-10銘柄) | 1分間隔 | ~600 calls/時 (10×60) |

**レイテンシ見積**: Cold scan 90銘柄 × ~200ms/call ÷ 同時実行5 = ~4秒。Hot scan 10銘柄 = ~0.4秒。いずれもポーリング間隔内に余裕で収まる。

**出来高サージ比率（時間正規化）**:

```
volumeSurgeRatio = cumulativeVolume / (avgVolume25 × elapsedFraction)

elapsedTradingMinutes =
  前場: min(現在時刻 - 9:00, 150)分
  後場: 150 + min(現在時刻 - 12:30, 150)分
  昼休み(11:30-12:30): 150分（前場終了時点で固定）

elapsedFraction = elapsedTradingMinutes / 300
```

**注意**: `cumulativeVolume`は立花証券APIの`pDV`（カラムコード117）から取得する。これは当日の累積出来高であり、ティック単位の出来高ではない。スキャナー側での出来高累積ロジックは不要。

例: 9:30時点（取引30分経過）、avgVolume25 = 100,000株
- 累積15,000株 → ratio = 15,000 / (100,000 × 0.1) = 1.5（やや活発）
- 累積30,000株 → ratio = 30,000 / (100,000 × 0.1) = 3.0（異常な出来高）

**昇格・トリガー条件**:

| 判定 | 条件 | アクション |
|---|---|---|
| Cold → Hot | volumeSurgeRatio ≥ 1.5 | ホットリストに追加、1分間隔に昇格 |
| Hot → Cold | volumeSurgeRatio < 1.2（2回連続） | ホットリストから降格 |
| トリガー発火 | volumeSurgeRatio ≥ 2.0 AND 現在値 > high20 | entry-executorへ |

**ガード条件**:

| 条件 | 理由 |
|---|---|
| 9:05以降のみ判定開始 | 寄付直後の出来高ノイズ回避 |
| 14:30以降はエントリーしない | 引け間際の操作的出来高回避 |
| 同一銘柄は1日1回まで | 重複エントリー防止 |
| 既に保有中の銘柄は除外 | 重複ポジション防止 |
| 1日の新規エントリー上限: 3件 | リスク管理 |

### 3. エントリー・エグゼキューター

**トリガー発火後のフロー**:

```
① リスクチェック
   ├─ market-assessment.shouldTrade = true
   ├─ 本日の新規エントリー数 < 3
   ├─ 買付余力チェック（ローカル計算）
   └─ セクター集中度チェック

② ポジションサイズ計算
   ├─ SL価格 = 現在値 - ATR(14) × 1.0（最大3%）
   ├─ リスク額 = 資金の2%
   └─ 株数 = リスク額 / (現在値 - SL価格)、100株単位に丸め

③ 注文送信（立花証券API）
   ├─ 指値買い注文（現在値で指値）
   └─ 逆指値SL注文（約定確認後に即セット）

④ DB記録
   └─ TradingOrder作成（トリガー情報・volumeSurgeRatio記録）
```

**注文方式**:

| 項目 | 値 | 理由 |
|---|---|---|
| 注文種別 | 指値（現在値） | ブレイクアウト直後のスプレッド拡大を回避 |
| 有効期限 | 当日限り | 未約定なら引けで失効 |
| SL注文 | 逆指値成行 | 約定確認後に即セット |

**流用する既存コンポーネント**:

| コンポーネント | ファイル | 変更 |
|---|---|---|
| ポジションサイズ計算 | `src/core/entry-calculator.ts` | 入力をトリガー情報に変更 |
| SLバリデーション | `src/core/risk-manager.ts` | そのまま流用 |
| 注文送信 | `src/core/broker-orders.ts` | そのまま流用 |
| SL管理 | `src/core/broker-sl-manager.ts` | そのまま流用 |
| 約定監視 | `src/jobs/position-monitor.ts` | そのまま流用 |

### 4. エグジット戦略（現行維持）

| 出口 | ロジック | 変更 |
|---|---|---|
| トレーリングストップ | ATR×2.5で発動、ATR×1.5で追従（swing） | なし |
| タイムストップ | 5営業日で強制クローズ | なし |
| 逆指値SL | ATR×1.0、最大3% | なし |
| ディフェンシブモード | bearish: 微益撤退、crisis: 全決済 | なし |

## 既存コードの変更

### 廃止（エントリーパスから除外）

| コンポーネント | ファイル | 備考 |
|---|---|---|
| stock-scanner | `src/jobs/stock-scanner.ts` | watchlist-builder + breakout-scannerに置き換え |
| order-manager | `src/jobs/order-manager.ts` | entry-executorに置き換え |
| AIレビュー | OpenAI Go/No-Go | 廃止 |

スコアリングコード（`src/core/scoring/*.ts`）は**削除しない**。holding-score（保有銘柄のトレンド劣化監視）で引き続き使用。

### 維持

| コンポーネント | 変更 |
|---|---|
| market-assessment | なし |
| position-monitor | なし |
| holding-score | なし |
| end-of-day | なし |
| broker-client / broker-orders / broker-sl-manager | なし |
| trailing-stop / exit-checker | なし |

### ジョブスケジュール変更

**変更前**:
```
8:00  news-collector → market-assessment → holding-score → stock-scanner
9:30  order-manager
```

**変更後**:
```
8:00  market-assessment → holding-score → watchlist-builder
9:00  breakout-scanner + position-monitor 開始（workerのnode-cron）
      トリガー発火時 → entry-executor（随時）
```

### cron-job.org 変更

| ジョブ | 変更 |
|---|---|
| morning-analysis | stock-scannerをwatchlist-builderに差し替え、news-collector削除 |
| order-manager | 削除 |
| その他 | 変更なし |

## 移行計画

1. 新コンポーネント（watchlist-builder, breakout-scanner, entry-executor）をBROKER_MODE=simulation で実装・テスト
2. 既存のstock-scanner / order-managerのcron-job.orgエンドポイントを無効化
3. morning-analysisのジョブチェーンをwatchlist-builderに差し替え
4. 切り替え前に未約定注文がないことを確認（end-of-dayで自動クリーンアップ済み）

## 既知の制約

- 決算日・配当落ち日のキャッシュは朝8:00時点のDB値。日中に変更された場合は翌朝まで反映されない（現行スコアリングと同じ制約）

## スコープ外

- **バックテスト対応**: 出来高ブレイクアウト戦略のバックテストは別途設計。まずsimulation運用で実績データを蓄積してから着手
- **WebSocketベース価格ストリーミング**: 将来的な高速化オプション。ポーリングで十分と判断した場合は不要
- **買付余力API連携**: 既存のローカル計算を継続。Phase 7で対応予定

## 定数

```typescript
const BREAKOUT = {
  VOLUME_SURGE: {
    HOT_THRESHOLD: 1.5,       // Cold → Hot 昇格
    TRIGGER_THRESHOLD: 2.0,   // トリガー発火
    COOL_DOWN_THRESHOLD: 1.2, // Hot → Cold 降格
    COOL_DOWN_COUNT: 2,       // 降格に必要な連続回数
  },
  PRICE: {
    HIGH_LOOKBACK_DAYS: 20,   // N日高値のN
  },
  POLLING: {
    COLD_INTERVAL_MS: 5 * 60 * 1000,  // 5分
    HOT_INTERVAL_MS: 1 * 60 * 1000,   // 1分
  },
  GUARD: {
    EARLIEST_ENTRY_TIME: "09:05",
    LATEST_ENTRY_TIME: "14:30",
    MAX_DAILY_ENTRIES: 3,
  },
  TRADING_MINUTES_PER_DAY: 300,  // 9:00-11:30(150分) + 12:30-15:00(150分)
};
```
