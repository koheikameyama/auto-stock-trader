# Stock Buddy

期待値で勝つ自動株式トレードツール。

## コンセプト

**損小利大で期待値を積み上げる**

正の期待値を持つトレードを繰り返すことで資産を増やす自動株式トレードツール。勝率ではなく「1トレードあたりの期待値」を最重要KPIとし、損は小さく・利は大きく取るトレンドフォロー戦略を採用する。

### エントリー戦略: インtraday出来高ブレイクアウト

**現在はブレイクアウト戦略のみで運用中**（2026-03-25〜）

| 項目 | 方針 |
|------|------|
| **エントリー** | 出来高サージ（2倍以上）+ 20日高値ブレイクで自動エントリー |
| **損切り** | ATRベースで機械的に損切り（最大3%） |
| **利確** | トレーリングストップで利益を伸ばす（固定利確なし） |
| **頻度** | スイングトレード（保有期間3〜10営業日） |

> **Note**: 以前のスコアリング+AIレビュー方式のエントリーは無効化されています（コード・ワークフローはコメントアウトで保持）。breakoutの実績検証後に並列運用を検討予定。

### コアバリュー

| 価値 | 説明 |
|------|------|
| **期待値重視** | 勝率ではなく期待値 = (勝率 × 平均利益) - (敗率 × 平均損失) で判断 |
| **リスク管理** | 損切りライン自動設定、1トレードあたりリスク2%、連敗時のポジション縮小 |
| **自動化** | エントリー・損切り・トレーリングストップを自動判断・自動執行 |
| **継続的改善** | トレード結果を記録・分析し、戦略をチューニング |

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

トレーディング動作を制御する3つの環境変数:

| 環境変数 | 値 | 説明 |
|---|---|---|
| `TACHIBANA_ENV` | `demo` / `production` | 立花証券APIの接続先 |
| `BROKER_MODE` | `simulation` / `dry_run` / `live` | 注文の発注モード |
| `MARKET_DATA_PROVIDER` | `yfinance` / `tachibana` | 株価データの取得元 |

**各環境変数の影響範囲:**

| 環境変数 | 注文 | 株価取得 | 買余力 | WebSocket |
|---|---|---|---|---|
| `TACHIBANA_ENV` | 接続先(デモ/本番) | - | `production`のみAPI取得 | 接続先 |
| `BROKER_MODE` | 発注するか否か | - | - | `live`のみ接続 |
| `MARKET_DATA_PROVIDER` | - | 取得元(yfinance/立花) | - | - |

**全組み合わせ一覧:**

| `TACHIBANA_ENV` | `BROKER_MODE` | `MARKET_DATA_PROVIDER` | 注文 | 株価取得 | 買余力 | WebSocket |
|---|---|---|---|---|---|---|
| `demo` | `simulation` | `yfinance` | 発注しない | yfinance | DB計算 | 接続しない |
| `demo` | `simulation` | `tachibana` | 発注しない | デモAPI | DB計算 | 価格用のみログイン |
| `demo` | `dry_run` | `yfinance` | ログのみ | yfinance | DB計算 | 接続しない |
| `demo` | `dry_run` | `tachibana` | ログのみ | デモAPI | DB計算 | 接続しない |
| `demo` | `live` | `yfinance` | デモAPIに発注 | yfinance | DB計算 | 接続する |
| `demo` | `live` | `tachibana` | デモAPIに発注 | デモAPI | DB計算 | 接続する |
| `production` | `simulation` | `yfinance` | 発注しない | yfinance | API取得 | 接続しない |
| `production` | `simulation` | `tachibana` | 発注しない | 本番API | API取得 | 価格用のみログイン |
| `production` | `dry_run` | `yfinance` | ログのみ | yfinance | API取得 | 接続しない |
| `production` | `dry_run` | `tachibana` | ログのみ | 本番API | API取得 | 接続しない |
| `production` | `live` | `yfinance` | 本番APIに発注 | yfinance | API取得 | 接続する |
| `production` | `live` | `tachibana` | 本番APIに発注 | 本番API | API取得 | 接続する |

**推奨設定パターン:**

| 用途 | `TACHIBANA_ENV` | `BROKER_MODE` | `MARKET_DATA_PROVIDER` |
|---|---|---|---|
| ローカル開発(API接続なし) | `demo` | `simulation` | `yfinance` |
| デモ運用 | `demo` | `live` | `tachibana` |
| 本番運用 | `production` | `live` | `tachibana` |

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
