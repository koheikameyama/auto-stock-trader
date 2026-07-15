# Auto Stock Trader プロジェクト固有の設定

## ロール

**あなたはプロの株式トレーダーとして仕様を考えてください。**

- 機能やロジックの設計時は、実際にトレードで利益を出しているプロの視点で判断する
- 「素人が便利だと思う機能」ではなく「プロが実戦で使える機能」を優先する
- エントリー・損切り・利確のロジックは、プロのリスク管理基準で設計する
- 市場の特性（流動性、ボラティリティ、時間帯による値動きの違い等）を考慮する
- 「理論上正しい」よりも「実際のマーケットで機能する」を重視する

## プロダクトコンセプト

### サービス概要

**Auto Stock Trader** - リスク調整後リターンで勝つ自動株式トレードツール

**コンセプト**: 「損小利大で複利を効かせ、Calmar比を最大化する」

正の期待値を前提条件としつつ、**リスク調整後リターン（Calmar比）を主KPI**とする自動株式トレードツール。自動化の強みを活かして複数戦略で機会を積み上げ、最大DDを抑えながら複利で資産を増やす。

> **重要**: 本ツールは個人利用の自動トレードツールです。投資にはリスクが伴います。

### トレード戦略

**損小利大・トレンドフォローで Calmar比 を最大化する**

- **主KPI**: Calmar比 ≥ 3.0（年率リターン / 最大DD）
- **前提条件**: 期待値 > 0、PF ≥ 1.3、RR比 ≥ 1.5
- **出口戦略**: トレーリングストップ一本で利益を伸ばし、タイムストップで塩漬けを防止
- **損切り**: ATRベースで機械的に損切り（最大3%）、固定利確は廃止
- **頻度**: gapup（平均保有1〜2日）+ PSC（保有1〜2日）の複数戦略で機会を積み上げ

### コアバリュー

1. **リスク調整後リターン重視**
   - 主KPI: **Calmar比 ≥ 3.0**（年率リターン / 最大DD）
   - 副KPI: 資本稼働率、Sharpe比、平均保有日数
   - 前提条件: 期待値 > 0、PF ≥ 1.3、RR比 ≥ 1.5
   - **期待値単独では判断しない**。per-trade期待値は必要条件、Calmar比が十分条件

2. **リスク管理**
   - 損切りラインの自動設定（ATR × 1.0、最大3%）
   - 1トレードあたりのリスクを資金の2%に制限
   - 連敗時の自動ポジション縮小

3. **自動化の徹底活用**
   - エントリー・損切り・トレーリングストップを自動判断・自動執行
   - 人間の判断コストがゼロなので**回転率を最大化**（自動化の強みを活かす）
   - 複数戦略・複数セットアップで機会を積み上げ、大数の法則で勝つ
   - ルールベースで判断バイアス排除

4. **継続的改善**
   - トレード結果の記録・分析
   - **Calmar比・PF・期待値・資本稼働率・最大DDを追跡**
   - バックテストによる戦略の定期検証・チューニング

### 設計思想

#### 基本原則: リスク調整後リターンファースト

**「リスク調整後で勝ち、損小利大で複利を効かせる」**

- **KPI優先順位**: Calmar比 > PF > 期待値 > 勝率
- **エッジ厳選 vs 回転率**: 自動化の強みを活かし回転率重視。per-trade期待値が多少下がっても、Calmar比が改善するなら採用
- **ルールベース**: 損切りはATRベースで機械的に実行、利確はトレーリングストップに委ねて利益を伸ばす
- **シンプルさ優先**: 統計的に同等なら条件が少ない方を選ぶ（過学習リスク低減）

#### なぜ「期待値ファースト」ではないか

期待値（per-trade）は**素人にも分かりやすい指標**だが、プロの運用では単独で使うべきではない:

1. **機会コスト無視**: 期待値+3%×10回/年 < 期待値+1%×100回/年（自動化なら後者が可能）
2. **複利効果無視**: 継続運用では頻度も重要
3. **リスク調整無視**: 同じ期待値でもDDが違えば運用可能性が違う

**正しいフレームワーク**: 「期待値 > 0」を必要条件とし、その上で Calmar比を最大化する。

#### 運用戦略

**gapup + PSC の2本柱で運用中。** breakout / weekly-break / スコアリング系は停止・削除済み（git履歴で復元可能）。

- **エントリー**:
  - gapup: `watchlist-builder` + `gapup-monitor` + `entry-executor`（平日15:24発注、翌日のクロージング前に寄り付きギャップアップを捕捉）
  - PSC (高騰後押し目): `watchlist-builder` + `post-surge-consolidation-monitor` + `entry-executor`（同15:24発注）
- **バックテスト**:
  - `npm run backtest:combined`（GU + PSC を共有資金プールでシミュレーション、本番判断の主指標）
  - `npm run backtest:gapup` / `npm run backtest:psc`（診断用の個別BT）
- **パラメータ検証**: `npm run walk-forward:gapup` / `npm run walk-forward:psc`（6ヶ月IS / 3ヶ月OOS）

#### 実装ガイドライン

- 損切りは必ず設定し、例外なく実行する（ATR×0.8、最大3%）
- 固定利確は使わない — トレーリングストップで利益を伸ばす
- タイムストップで塩漬け防止（gapup: 1〜2営業日、PSC: 5〜7営業日）
- **約定の記録には必ずブローカーの実約定価格を使う**（KOH-547）。BTの `exitPrice` は「決済すべきか」の判定用であって「いくらで売れたか」ではなく、日中に大きく乖離する。損益・実現損益・DD判定の土台になるので、モデル値で記録してはいけない
- **DBだけ閉じる「幻の決済」を作らない**（KOH-550）。`closePosition` は必ず実際のブローカー約定に裏付けられた経路からのみ呼ぶ。売り注文が失敗したら close も通知もせず 🚨 を上げる

#### 戦略のシーズン性と監視

> **⚠️ 2026-07-15 (KOH-548) 以降、本文中のBT数値の前提が変わっている。**
> `exit-checker` の既定が `end-of-bar` → `stop-at-open` になり、トレール決済の約定価格が
> 「その日の始値」から「トレール価格」に修正された（旧はイントラバー先読み。GU/PSC では常時発火していた）。
> **本文に引用されている Calmar / NetRet / MaxDD は同一エンジン内の相対比較としては有効だが、
> 現エンジンで再実行しても一致しない。** 旧エンジンの再現は `--intrabar-model end-of-bar`。
> 詳細は `.claude/rules/backtest.md` 却下リスト #39。

**2026-05-21 過去9年データ検証で確定:** 既存戦略 (GU+PSC) は **「2-3ヶ月続く大強気相場 (D期) でだけ大きく稼ぐシーズン性戦略」**。過去9年で D期相当は 2020-04 / 2024-01 / **2025-07-08** の3回 = 約3年に1回。残り期間 (60%以上) は "offseason" として "ゼロ近辺で耐える" のが本質。詳細は `.claude/rules/backtest.md` 却下リスト #21。

- **D期入り監視**: `regime-shift-notify` (引け後cron, 段階的5シグナル評価) を Slack 通知。検出ロジック不可能 (D期は事後確定) なので「強気モニター」として段階的可視化 (STRONG/MODERATE/EARLY/NEUTRAL)
- **offseason 補完**: 米株ETF (1547 SPY / 1545 NASDAQ100) 戦略は **2026-05-21 に本番実装済み (A-4 完了)**。breadth<54% (idle 帯) 限定で gap≥0.5%+vol≥1.5x+陽線。WF OOS PF 1.91 / Calmar 5.24。立花API で取引可。**発注は GU/PSC と同じ worker.ts node-cron 15:24・引け成行に統一済 (`us-etf-monitor`, KOH-498)** — 当初の翌朝寄付成行・GitHub Actions 方式は CI遅延で寄付を逃し受付エラーになる構造的バグがあり刷新。月次ヘルスチェック (`us-etf-health-check`)。**combined BT 統合も完了 (KOH-492): `--enable-etf` で GU/PSC+ETF を共有プール検証。ETF追加で NetRet +106pp・稼働率 +7pp、MaxDD +2.7pp で Calmar ほぼ横ばい。詳細は `.claude/rules/backtest.md`「事例: combined BT への ETF 統合」**
- **offseason 補完(Phase A 観察モードで本番稼働中, 検証 KOH-502 / 本番化 KOH-504)**: 自社株買いカタリスト。TDnet「自己株式取得に係る事項の決定」を idle帯(breadth<54%)で開示翌営業日引けエントリー、-12%固定SL+20営業日タイムストップ。**却下リスト史上初の「価格と無相関・offseason稼働」エッジ**(単独8年8勝, idle帯 PF 2.11)。**¥500K でも フルサイクル窓(2019-2026)で Calmar 4.7→12.1(+157%)・MaxDD 31.5→19.6%(-12pp) と大勝ち**（offseasonの遊休現金を使い MaxDD 激減）。負けるのは 2024-03〜 の持続D期窓だけ(GU/PSC が全資金を回す局面で補完不要)。レジーム転換Exit は買いのドリフトを切るので非推奨。**本番状態(2026-07-03〜)**: live TDnet取得(やのしん)を worker.ts node-cron 毎営業日20:00で稼働(`src/jobs/buyback-monitor.ts`, `src/core/buyback/tdnet-fetcher.ts`)、`BuybackSignal` テーブルに記録+Slack通知するが **`BUYBACK.OBSERVE_ONLY=true` で発注は禁止**(Phase A=数週間フォワードで ①やのしん安定性 ②signal妥当性 ③現局面挙動 を観察)。**Phase B で環境変数 `BUYBACK_OBSERVE_ONLY=false` にし立花引け成行発注を有効化**(us-etf-monitor.ts が雛形、スキーマは executed/brokerOrderNumber/positionId まで設計済)。BT側 `--enable-buyback`(フラグOFFでbaseline不変)は検証用に残置。詳細は `.claude/rules/backtest.md`「事例: 自社株買いカタリスト戦略の検証」
- **offseason 補完(本番稼働中, 検証 KOH-531 / 本番化 KOH-554)**: パニック底反発。**VIX(前日終値)>25 × breadth<40% × N225連続下落≥3日(エピソード初日のみ) → 1321(日経225ETF)を引け成行買い、-12%固定SL + 20営業日タイムストップ、枠1**。「価格由来だが発火が市況と逆相関」という唯一の戦略で、①fullcycle改善 ②D期無傷 ③buyback非競合 を同時に満たす。**本番状態(2026-07-15〜)**: `src/jobs/panic-monitor.ts` が worker.ts の 15:24 entry-monitors で GU/PSC/us-etf の後に逐次実行。`PANIC_ENTRY_ENABLED=false` で即停止可(Exitは常に動く)。発火は年2回未満。**⚠️ 判定はすべて前営業日の確定終値**(本番15:24に当日breadthは存在せず、全3,000銘柄のライブ時価は立花の負荷ルール違反)。BTもこの1営業日ラグを織り込んだ定義で再検証済み(fullcycle Calmar +24.6% / D期 -7.8% / buyback joint +14.5%)。**⚠️ この戦略に触ってはいけないもの: トレーリング(辛抱型ドリフトが死ぬ)と VIX>30/crisis の防御決済(底で強制売却になる)** — position-monitor の両方から除外済(BT の `etfCrisisBypass` の移植)。**逆指値SLは板に生きているのでテールは保護される**。詳細は `.claude/rules/backtest.md`「事例: パニック底反発の live 実装」
- **戦略変更は禁物**: シーズン性を受け入れる。次のD期 (2027-2028年頃想定) を取り逃さない準備が最重要

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
| [multi-broker-api-comparison.md](docs/specs/multi-broker-api-comparison.md) | 証券会社API比較・移行戦略（立花証券 / Webull証券 / Interactive Brokers） |

詳細は `.claude/rules/` 配下を参照してください。

### 記憶・ルールの保存

**進化的記憶システムを使用しています。** `memory/evolution.md` を参照してください。

- **日次の決定事項**: `memory/daily/` に自動記録（SessionEnd Hook）
- **繰り返すパターン**: 週次振り返りで `memory/long-term/` に昇格
- **重要なルール**: pain_count ≥ 3 で `.claude/rules/` に自動昇格
- **グローバルルール**: pain_count ≥ 5 または手動判断で `CLAUDE.md` に追加

#### 昇格フロー

```
memory/daily/ (pain_count: 0)
  ↓ 週次振り返り（毎週金曜 19:00 JST）
memory/long-term/ (pain_count: 1-2)
  ↓ pain_count ≥ 3
.claude/rules/ (強制力: 強)
  ↓ pain_count ≥ 5 または手動判断
CLAUDE.md (強制力: 最強)
```

詳細は `memory/evolution.md` と `memory/README.md` を参照してください。

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
