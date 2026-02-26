# GitHub Actions Workflows

このディレクトリには、Stock Buddyのデータ収集・処理を自動化するワークフローが含まれています。

## ワークフロー一覧

### 1. Twitter Collection (`twitter-collection.yml`)

**目的**: Twitterから株式関連のツイートを収集し、銘柄コードを抽出する

**実行スケジュール**:
- 毎日 21:00 JST (12:00 UTC)
- 手動実行も可能

**処理内容**:
1. Twitterにログイン
2. フォローアカウント・タイムライン・検索から過去24時間のツイートを収集
3. 銘柄コード（4桁）を抽出
4. `twitter_tweets.json` をアーティファクトとしてアップロード

**必要なシークレット**:
- `TWITTER_USERNAME` - Twitterユーザー名
- `TWITTER_EMAIL` - Twitter登録メールアドレス
- `TWITTER_PASSWORD` - Twitterパスワード
- `SLACK_WEBHOOK_URL` - Slack通知用Webhook URL

**出力**:
- アーティファクト: `twitter-data` (保持期間: 1日)

---

### 2. Featured Stocks Generation (`featured-stocks-generation.yml`)

**目的**: Twitterデータを基に今日の注目銘柄を生成する

**実行スケジュール**:
- 毎日 22:00 JST (13:00 UTC) - Twitter収集の1時間後
- 手動実行も可能

**処理内容**:
1. Twitter収集ワークフローのアーティファクトをダウンロード
2. `/api/featured-stocks/generate` APIを呼び出してAI分析を実行
3. 注目銘柄をデータベースに保存

**必要なシークレット**:
- `APP_URL` - アプリケーションのベースURL (例: https://stock-buddy.up.railway.app)
- `CRON_SECRET` - Cron認証用シークレット
- `SLACK_WEBHOOK_URL` - Slack通知用Webhook URL

**依存関係**:
- `twitter-collection.yml` が実行されていることが望ましい（なくても実行可能）

---

### 3. JPX Stock Update (`jpx-weekly-scrape.yml`)

**目的**: 日本取引所グループ（JPX）から新規上場・上場廃止銘柄をスクレイピングし、銘柄マスタを更新する

**実行スケジュール**:
- 毎週月曜日 10:00 JST (01:00 UTC)
- 手動実行も可能

**処理内容**:
1. JPXウェブサイトから新規上場・上場廃止銘柄をスクレイピング
2. 銘柄データを `jpx_stocks.json` に保存
3. PostgreSQLの `Stock` テーブルをUPSERT更新

**必要なシークレット**:
- `PRODUCTION_DATABASE_URL` - 本番環境のPostgreSQL接続URL
- `SLACK_WEBHOOK_URL` - Slack通知用Webhook URL

**出力**:
- アーティファクト: `jpx-stocks-data` (保持期間: 7日)

---

## シークレットの設定方法

### GitHub Secretsに登録

1. GitHubリポジトリの **Settings** > **Secrets and variables** > **Actions** に移動
2. **New repository secret** をクリック
3. 以下のシークレットを登録:

#### 必須シークレット

| シークレット名 | 説明 | 使用ワークフロー |
|-------------|------|---------------|
| `TWITTER_USERNAME` | Twitterユーザー名 | twitter-collection |
| `TWITTER_EMAIL` | Twitter登録メールアドレス | twitter-collection |
| `TWITTER_PASSWORD` | Twitterパスワード | twitter-collection |
| `APP_URL` | アプリケーションURL | featured-stocks-generation |
| `CRON_SECRET` | Cron認証用シークレット | featured-stocks-generation |
| `PRODUCTION_DATABASE_URL` | PostgreSQL接続URL | jpx-stock-update |
| `SLACK_WEBHOOK_URL` | Slack通知Webhook | 全ワークフロー |

#### シークレット値の例

```bash
# Twitter
TWITTER_USERNAME=your_twitter_username
TWITTER_EMAIL=your_email@example.com
TWITTER_PASSWORD=your_secure_password

# アプリケーション
APP_URL=https://stock-buddy.up.railway.app
CRON_SECRET=your_cron_secret_key

# データベース
PRODUCTION_DATABASE_URL=postgresql://user:password@host.railway.app:5432/railway
```

---

## 手動実行方法

各ワークフローは手動でも実行できます:

1. GitHubリポジトリの **Actions** タブに移動
2. 実行したいワークフローを選択
3. **Run workflow** ボタンをクリック
4. ブランチを選択して **Run workflow** を実行

---

## トラブルシューティング

### Twitter収集が失敗する

- **原因**: Twitter認証情報が間違っている、またはアカウントがロックされている
- **対処法**:
  - GitHub Secretsの認証情報を確認
  - Twitterアカウントのセキュリティ設定を確認
  - 必要に応じて `cookies.json` をクリア

### Featured Stocks生成でアーティファクトが見つからない

- **原因**: Twitter収集ワークフローが実行されていない、または失敗した
- **対処法**:
  - Twitter収集ワークフローのログを確認
  - 手動でTwitter収集を先に実行してから再試行
  - アーティファクトは自動的に1日で削除されるため、同日中に実行する必要がある

### JPX更新でスクレイピングが失敗する

- **原因**: JPXのウェブサイト構造が変更された
- **対処法**:
  - `scripts/jpx/scrape_stocks.py` のHTMLパーサーを更新
  - JPXのウェブサイト構造を確認して、セレクタを修正

### データベース接続エラー

- **原因**: `PRODUCTION_DATABASE_URL` が間違っている、またはネットワークエラー
- **対処法**:
  - GitHub Secretsの接続URLを確認
  - Railwayダッシュボードで正しい接続URLを確認
  - データベースが起動していることを確認

---

## 開発ガイドライン

### 新しいワークフローを追加する場合

1. **Python スクリプトを使用する**
   - GitHub ActionsではPythonスクリプトを推奨（heredocはYAMLパーサーエラーの原因）
   - エラーハンドリングを適切に実装
   - ログ出力を詳細に

2. **スケジュールを考慮する**
   - 他のワークフローとの依存関係を確認
   - API レート制限を考慮
   - タイムゾーンはUTCで指定（JST = UTC+9）

3. **シークレット管理**
   - 環境変数で機密情報を管理
   - README に必要なシークレットを文書化

4. **通知を追加する**
   - 成功・失敗時のSlack通知を追加
   - エラーメッセージを明確に

---

## 関連ドキュメント

- [Twitter収集スクリプト](../../scripts/twitter/README.md)
- [JPXスクレイピングスクリプト](../../scripts/jpx/README.md)
- [プロジェクトREADME](../../README.md)
