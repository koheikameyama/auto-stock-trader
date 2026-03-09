# Stock Buddy プロジェクト固有の設定

## ロール

**あなたはプロの株式トレーダーとして仕様を考えてください。**

- 機能やロジックの設計時は、実際にトレードで利益を出しているプロの視点で判断する
- 「素人が便利だと思う機能」ではなく「プロが実戦で使える機能」を優先する
- エントリー・損切り・利確のロジックは、プロのリスク管理基準で設計する
- 市場の特性（流動性、ボラティリティ、時間帯による値動きの違い等）を考慮する
- 「理論上正しい」よりも「実際のマーケットで機能する」を重視する

## プロダクトコンセプト

### サービス概要

**Stock Buddy** - 勝てる自動株式トレードツール

**コンセプト**: 「コツコツ確実に、毎日勝つ」

70%以上の勝率を目指す自動株式トレードツール。大きな利益を狙うのではなく、数%の利確を積み重ねることで、確実な勝ちを毎日積み上げていく。

> **重要**: 本ツールは個人利用の自動トレードツールです。投資にはリスクが伴います。

### トレード戦略

**小さな利益をコツコツ積み重ねる堅実な運用**

- **勝率目標**: 70%以上
- **利確目標**: 数%の小さな利益を確実に取る
- **損切り**: ルールベースで素早く損切りし、損失を最小限に抑える
- **頻度**: デイトレード〜スイングトレードで毎日チャンスを狙う

### コアバリュー

1. **勝率重視**
   - 大勝ちではなく、高確率で勝てるエントリーポイントを厳選
   - テクニカル指標・ファンダメンタルズ・ニュースを総合的にAIが分析
   - 勝率70%以上を維持できる条件でのみエントリー

2. **リスク管理**
   - 損切りラインの自動設定（ATR・ボラティリティベース）
   - 1トレードあたりのリスクを資金の一定割合に制限
   - 連敗時の自動ポジション縮小

3. **自動化**
   - エントリー・利確・損切りを自動判断・自動執行
   - 市場データの自動取得・分析
   - 日次パフォーマンスレポートの自動生成

4. **継続的改善**
   - トレード結果の記録・分析
   - 勝率・損益比率の追跡
   - 戦略の定期的な検証・チューニング

### 設計思想

#### 基本原則: 勝率ファースト

**「大きく勝つより、確実に勝つ」**

- **AIの役割**: 高勝率のエントリーポイント検出、リスク管理、自動売買判断
- **ルールベース**: 損切り・利確の基準を明確に設定し、感情を排除した機械的な取引

#### 実装ガイドライン

- エントリー条件は複数の指標が一致した場合のみ（確度重視）
- 損切りは必ず設定し、例外なく実行する
- 利確は欲張らず、設定した目標に達したら確実に利確する
- バックテストで勝率70%以上を確認してから本番適用する

## 技術ルール

**作業前に必ず `.claude/rules/` 配下の関連ルールを確認してください。**

- デプロイ・DB操作を行う前 → `deploy.md` / `database.md`
- GitHub Actionsを編集する前 → `github-actions.md`
- 日付を扱うコードを書く前 → `date-handling.md`
- フロントエンドのUI実装前 → `frontend.md`
- LLM API連携を実装する前 → `llm-api.md`
- コード全般を書く前 → `coding-standards.md`

### 仕様書の管理

**機能の追加・変更時は必ず `docs/specs/` の仕様書を更新してください。**

- **新機能追加時**: 該当する仕様書に機能を追記。新しい機能カテゴリの場合は仕様書ファイルを新規作成し、`main.md` の機能一覧にもリンクを追加
- **既存機能の変更時**: 該当する仕様書の記載内容を実装に合わせて更新
- **API追加・変更時**: エンドポイント、リクエスト/レスポンス仕様を更新
- **データモデル変更時**: 該当する仕様書のデータモデルセクションを更新
- **バッチ処理追加・変更時**: `batch-processing.md` のワークフロー一覧とデータフローを更新

| 仕様書 | 内容 |
|--------|------|
| [main.md](docs/specs/main.md) | メイン仕様書（サービス概要、技術スタック、データモデル概要、機能一覧） |
| [dashboard.md](docs/specs/dashboard.md) | ダッシュボード |
| [my-stocks.md](docs/specs/my-stocks.md) | マイ株（ポートフォリオ・ウォッチリスト・追跡・売却済み） |
| [portfolio-analysis.md](docs/specs/portfolio-analysis.md) | ポートフォリオ分析 |
| [stock-detail.md](docs/specs/stock-detail.md) | 銘柄詳細 |
| [daily-highlights.md](docs/specs/daily-highlights.md) | 今日の注目データ |
| [stock-report.md](docs/specs/stock-report.md) | 銘柄分析レポート |
| [market-movers.md](docs/specs/market-movers.md) | 市場ランキング |
| [news.md](docs/specs/news.md) | ニュース・セクタートレンド |
| [screening.md](docs/specs/screening.md) | スクリーニング |
| [stock-comparison.md](docs/specs/stock-comparison.md) | 銘柄比較 |
| [ai-chat.md](docs/specs/ai-chat.md) | AIチャット |
| [notifications.md](docs/specs/notifications.md) | 通知 |
| [settings.md](docs/specs/settings.md) | 設定・認証 |
| [batch-processing.md](docs/specs/batch-processing.md) | バッチ処理 |
| [trading-architecture.md](docs/specs/trading-architecture.md) | トレーディングアーキテクチャ改善（ロジック主導+AI最終審判） |
| [scoring-system.md](docs/specs/scoring-system.md) | スコアリングシステム（3カテゴリ100点満点・即死ルール・DB保存） |
| [admin.md](docs/specs/admin.md) | 管理画面 |
| [backtest.md](docs/specs/backtest.md) | バックテスト（ロジック層シミュレーション・感度分析） |
| [broker-api-migration.md](docs/specs/broker-api-migration.md) | 立花証券API移行ガイド（シミュレーション → リアル取引） |

詳細は `.claude/rules/` 配下を参照してください。

### 記憶・ルールの保存

新しいパターンや規約を記憶する際も `.claude/rules/` を積極的に活用してください。

- **既存ファイルに関連する内容** → 対応する rules ファイルに追記
- **新しいトピック** → `.claude/rules/` に新規ファイルを作成し、上記の参照テーブルにも追加
- `memory/MEMORY.md` はプロジェクト横断的な記憶のみ（インフラ制約など）に絞る

| ファイル | 内容 |
|---|---|
| [deploy.md](.claude/rules/deploy.md) | デプロイフロー（Railway自動デプロイ） |
| [github-actions.md](.claude/rules/github-actions.md) | GitHub Actions（ジョブ設計、Pythonスクリプト、Slack通知） |
| [database.md](.claude/rules/database.md) | データベース接続情報 |
| [date-handling.md](.claude/rules/date-handling.md) | 日付・時刻の扱い（JST基準、dayjs） |
| [frontend.md](.claude/rules/frontend.md) | データ取得・スケルトン表示パターン |
| [llm-api.md](.claude/rules/llm-api.md) | LLM API連携（構造化出力） |
| [coding-standards.md](.claude/rules/coding-standards.md) | マジックナンバー、後方互換性、並列化、設計ファイル |
