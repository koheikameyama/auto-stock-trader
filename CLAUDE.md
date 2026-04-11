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

**Stock Buddy** - 期待値で勝つ自動株式トレードツール

**コンセプト**: 「損小利大で期待値を積み上げる」

正の期待値を持つトレードを繰り返すことで資産を増やす自動株式トレードツール。勝率ではなく「1トレードあたりの期待値」を最重要KPIとし、損は小さく・利は大きく取るトレンドフォロー戦略を採用する。

> **重要**: 本ツールは個人利用の自動トレードツールです。投資にはリスクが伴います。

### トレード戦略

**損小利大・トレンドフォローで正の期待値を積み上げる**

- **期待値目標**: 1トレードあたり期待値 > 0（`(勝率 × 平均利益%) + (敗率 × 平均損失%) > 0`）
- **出口戦略**: トレーリングストップ一本で利益を伸ばし、タイムストップで塩漬けを防止
- **損切り**: ATRベースで機械的に損切り（最大3%）、固定利確は廃止
- **頻度**: gapup（平均保有1〜2日）+ weekly-break（保有3〜5日）

### コアバリュー

1. **期待値重視**
   - 勝率ではなく「期待値 = (勝率 × 平均利益) - (敗率 × 平均損失)」で判断
   - リスクリワード比 ≥ 1.5 のエントリーのみ許可（RRフィルタ）
   - Profit Factor ≥ 1.3 を運用KPIとして追跡

2. **リスク管理**
   - 損切りラインの自動設定（ATR × 1.0、最大3%）
   - 1トレードあたりのリスクを資金の2%に制限
   - 連敗時の自動ポジション縮小

3. **自動化**
   - エントリー・損切り・トレーリングストップを自動判断・自動執行
   - 市場データの自動取得・分析
   - 日次パフォーマンスレポートの自動生成

4. **継続的改善**
   - トレード結果の記録・分析
   - 期待値・PF・RR比の追跡
   - バックテストによる戦略の定期検証・チューニング

### 設計思想

#### 基本原則: 期待値ファースト

**「勝率より期待値、損小利大で生き残る」**

- **エントリー**: 出来高サージ（2倍以上）+ 20日高値ブレイクで自動エントリー（breakout戦略）
- **ルールベース**: 損切りはATRベースで機械的に実行、利確はトレーリングストップに委ねて利益を伸ばす

#### 運用戦略

**breakout戦略のみで運用中。** スコアリング系コードは削除済み（git履歴で復元可能）。

- **エントリー**: watchlist-builder + breakout-monitor + entry-executor
- **バックテスト**: `npm run backtest:breakout`（日足データでシミュレーション）
- **パラメータ検証**: `npm run walk-forward:breakout`（6ヶ月IS / 3ヶ月OOS × 6ウィンドウ）

#### 実装ガイドライン

- エントリーは出来高サージ + 高値ブレイクの2条件が揃った場合のみ
- 損切りは必ず設定し、例外なく実行する（最大3%）
- 固定利確は使わない — トレーリングストップで利益を伸ばす
- 10営業日経過でクローズ（タイムストップ）

## 技術ルール

**作業前に必ず `.claude/rules/` 配下の関連ルールを確認してください。**

- デプロイ・DB操作を行う前 → `deploy.md` / `database.md`
- GitHub Actionsを編集する前 → `github-actions.md`
- 日付を扱うコードを書く前 → `date-handling.md`
- フロントエンドのUI実装前 → `frontend.md`
- コード全般を書く前 → `coding-standards.md`
- Claude Code の設定を変更する前 → `claude-code-settings.md`
- バックテスト・パラメータを変更する前 → `backtest.md`
- 立花証券APIを実装する前 → `tachibana-api.md`

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
| [screening.md](docs/specs/screening.md) | スクリーニング |
| [stock-comparison.md](docs/specs/stock-comparison.md) | 銘柄比較 |
| [notifications.md](docs/specs/notifications.md) | 通知 |
| [settings.md](docs/specs/settings.md) | 設定・認証 |
| [batch-processing.md](docs/specs/batch-processing.md) | バッチ処理 |
| [trading-architecture.md](docs/specs/trading-architecture.md) | トレーディングアーキテクチャ（ルールベース売買・リスク管理） |
| [admin.md](docs/specs/admin.md) | 管理画面 |
| [backtest-breakout.md](docs/specs/backtest-breakout.md) | ブレイクアウトバックテスト（日足シミュレーション・walk-forward検証） |
| [backtest-gapup.md](docs/specs/backtest-gapup.md) | ギャップアップバックテスト（当日終値エントリー・短期決戦） |
| [broker-api-migration.md](docs/specs/broker-api-migration.md) | 立花証券API移行ガイド（シミュレーション → リアル取引） |
| [tachibana-api-reference.md](docs/specs/tachibana-api-reference.md) | 立花証券 e支店 API リファレンス（v4r8） |

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
| [coding-standards.md](.claude/rules/coding-standards.md) | マジックナンバー、後方互換性、並列化、設計ファイル |
| [claude-code-settings.md](.claude/rules/claude-code-settings.md) | Claude Code 設定管理（permissions はローカルファイル） |
| [backtest.md](.claude/rules/backtest.md) | バックテスト運用（walk-forward の実行タイミング・判定基準） |
| [tachibana-api.md](.claude/rules/tachibana-api.md) | 立花証券 e支店 API（認証、注文、口座、時価、EVENT I/F） |
