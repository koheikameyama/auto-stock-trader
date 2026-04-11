# Stock Buddy

期待値で勝つ自動株式トレードツール。

## コンセプト

**損小利大で期待値を積み上げる**

正の期待値を持つトレードを繰り返すことで資産を増やす自動株式トレードツール。勝率ではなく「1トレードあたりの期待値」を最重要KPIとし、損は小さく・利は大きく取るトレンドフォロー戦略を採用する。

### エントリー戦略

**gapup戦略（主力）+ weekly-break戦略の2本柱**

| 項目 | gapup | weekly-break |
|------|-------|-------------|
| **エントリー** | ギャップアップ（3%）+ 陽線 + 出来高サージ（1.5倍） | 13週高値ブレイク + 週足出来高サージ（1.3倍） |
| **損切り** | ATR×0.8（最大3%） | ATR×1.5（最大3%） |
| **利確** | トレーリングストップ（固定利確なし） | トレーリングストップ（固定利確なし） |
| **平均保有期間** | 1〜2日 | 3〜5日 |
| **ポジション上限** | 最大2 | 最大2（独立カウント） |

### コアバリュー

| 価値 | 説明 |
|------|------|
| **期待値重視** | 勝率ではなく期待値 = (勝率 × 平均利益) - (敗率 × 平均損失) で判断 |
| **リスク管理** | 損切りライン自動設定、1トレードあたりリスク2%、連敗時のポジション縮小 |
| **自動化** | エントリー・損切り・トレーリングストップを自動判断・自動執行 |
| **継続的改善** | トレード結果を記録・分析し、戦略をチューニング |

## 1日の取引フロー

### 前場前（8:00 JST）

| 時刻 | ジョブ | 内容 |
|------|--------|------|
| 8:00 | market-assessment | 市場指標（日経225, VIX, S&P500等）取得 → メカニカルレジーム判定 → AI市場評価 → `shouldTrade` 判定 |
| 8:00 | watchlist-builder | 全銘柄からブレイクアウト候補をフィルタリング（流動性・価格・ボラティリティ・決算除外・週足トレンド） |

トリガー: cron-job.org → GitHub Actions (`cronjob_morning-analysis.yml`)

### 前場・後場（9:00〜15:25 JST）

| 時刻 | ジョブ | 内容 |
|------|--------|------|
| 9:00〜15:30 毎分 | position-monitor | pending注文の約定チェック、openポジションの利確/損切り/トレーリングストップ/タイムストップ |
| 14:50 | gapup-monitor | 当日のギャップアップ銘柄をスキャンし、引け条件付き成行注文で自動エントリー |

position-monitor は Railway Worker の node-cron で毎分実行。gapup-monitor は cron-job.org トリガー。

#### gapup戦略（主力）

- **エントリー条件**: ギャップアップ（3%以上）+ 陽線 + 出来高サージ（1.5倍以上）
- **時間帯**: 14:50（1日1回スキャン）
- **注文**: 引け条件付き成行注文（market-on-close）→ 約定後に逆指値SLを別途発注
- **ポジション上限**: 最大2

#### weekly-break戦略

- **エントリー条件**: 13週高値ブレイク + 週足出来高サージ（1.3倍以上）
- **時間帯**: 金曜 15:20（週1回スキャン）
- **注文**: 翌営業日の寄付成行注文 → 約定後に逆指値SLを別途発注
- **ポジション上限**: 最大2（gapupとは独立カウント）

### 大引け後（15:50 JST）

| 時刻 | ジョブ | 内容 |
|------|--------|------|
| 15:50 | end-of-day | 未決済ポジションの強制決済、VIX≥30時の全ポジション強制決済、期限切れ注文キャンセル、日次サマリー作成、AI日次レビュー |

トリガー: cron-job.org → GitHub Actions (`cronjob_end-of-day.yml`)

### 閉場後（16:00〜 JST）

| 時刻 | ジョブ | 内容 |
|------|--------|------|
| 16:20 | defensive-exit-followup | ディフェンシブ出口判断の事後検証 |
| 16:30 | unfilled-order-followup | 未約定注文の事後検証 |

トリガー: GitHub Actions cron

### 週末

| 時刻 | ジョブ | 内容 |
|------|--------|------|
| 土曜 9:00 | jpx-delisting-sync | JPX廃止予定銘柄の同期 |
| 土曜 10:00 | weekly-review | 週間パフォーマンス分析 + AI戦略レビュー |
| 月曜 3:00 | data-cleanup | 古いデータの削除 |

### エグジット戦略

全戦略共通でトレーリングストップ + タイムストップを採用。

| パラメータ | gapup | weekly-break |
|-----------|-------|-------------|
| 損切り（SL） | ATR×0.8（最大3%） | ATR×1.5（最大3%） |
| BE発動 | ATR×0.3 | ATR×0.3 |
| トレール幅 | ATR×0.3 | ATR×0.3 |
| タイムストップ（基本） | 3営業日 | 5営業日 |
| タイムストップ（上限） | 5営業日 | 10営業日 |

### ジョブ実行基盤

| 基盤 | 用途 |
|------|------|
| Railway Worker (node-cron) | 毎分実行が必要なジョブ（position-monitor） |
| cron-job.org → GitHub Actions | 時間の正確性が重要な日次バッチ（morning, eod） |
| GitHub Actions cron | 数分のズレが許容される処理（followup, weekly, cleanup） |

## 技術スタック

- **Runtime**: Hono + Node.js, TypeScript
- **Database**: PostgreSQL (Prisma ORM)
- **AI**: OpenAI GPT-4
- **株価データ**: yfinance (Python), 立花証券 e支店 API
- **技術指標**: technicalindicators (npm)
- **インフラ**: Railway
- **スケジューラ**: cron-job.org / GitHub Actions

## セットアップ

### 1. 環境変数の設定

`.env.example`をコピーして`.env`を作成し、必要な値を設定します。

```bash
cp .env.example .env
```

#### ブローカー・市場データ設定

トレーディング動作を制御する2つの環境変数:

| 環境変数 | 値 | 説明 |
|---|---|---|
| `TACHIBANA_ENV` | `demo` / `production` | 立花証券APIの接続先 |
| `BROKER_MODE` | `simulation` / `dry_run` / `live` | 注文の発注モード |

**株価データの取得元（固定）:**
- リアルタイムクォート: 立花証券API（全モードで立花APIにログイン）
- ヒストリカル・市場指標・ニュース: yfinance

**各環境変数の影響範囲:**

| 環境変数 | 注文 | 買余力 | WebSocket |
|---|---|---|---|
| `TACHIBANA_ENV` | 接続先(デモ/本番) | `production`のみAPI取得 | 接続先 |
| `BROKER_MODE` | 発注するか否か | - | `live`のみ接続 |

**全組み合わせ一覧:**

| `TACHIBANA_ENV` | `BROKER_MODE` | 注文 | 株価取得 | 買余力 | WebSocket |
|---|---|---|---|---|---|
| `demo` | `simulation` | 発注しない | デモAPI | DB計算 | 接続しない |
| `demo` | `dry_run` | ログのみ | デモAPI | DB計算 | 接続しない |
| `demo` | `live` | デモAPIに発注 | デモAPI | DB計算 | 接続する |
| `production` | `simulation` | 発注しない | 本番API | API取得 | 接続しない |
| `production` | `dry_run` | ログのみ | 本番API | API取得 | 接続しない |
| `production` | `live` | 本番APIに発注 | 本番API | API取得 | 接続する |

**推奨設定パターン:**

| 用途 | `TACHIBANA_ENV` | `BROKER_MODE` |
|---|---|---|
| ローカル開発 | `demo` | `simulation` |
| デモ運用 | `demo` | `live` |
| 本番運用 | `production` | `live` |

### 2. データベースのセットアップ

PostgreSQLデータベースを用意し、接続URLを`.env`の`DATABASE_URL`に設定します。

### 3. 依存パッケージのインストール

```bash
# Node.js パッケージ
npm install

# Python パッケージ
pip install -r scripts/requirements.txt
```

### 4. Prisma マイグレーション

```bash
npx prisma migrate dev --name init
npx prisma generate
```

### 5. 初期データ投入

```bash
python scripts/init_data.py
```

### 6. 開発サーバーの起動

```bash
npm run dev
```

## デプロイ

`main` ブランチへのプッシュで Railway が自動デプロイします。マイグレーションもビルド時に自動実行されます。

## ライセンス

Private
