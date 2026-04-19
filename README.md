# Auto Stock Trader

リスク調整後リターンで勝つ自動株式トレードツール。

## コンセプト

**損小利大で複利を効かせ、Calmar比を最大化する**

正の期待値を前提条件としつつ、**リスク調整後リターン（Calmar比）を主KPI**とする自動株式トレードツール。自動化の強みを活かして複数戦略で機会を積み上げ、最大DDを抑えながら複利で資産を増やす。

- **主KPI**: Calmar比 ≥ 3.0（年率リターン / 最大DD）
- **副KPI**: 資本稼働率、PF、平均保有日数
- **前提条件**: 期待値 > 0、PF ≥ 1.3、RR比 ≥ 1.5

### エントリー戦略

**gapup + PSC（高騰後押し目）の2本柱**

| 項目 | gapup | PSC |
|------|-------|-----|
| **エントリー** | ギャップアップ（3%以上）+ 陽線 + 出来高サージ（1.5倍以上） | 直近20日+15%急騰後、高値-5%以内で出来高サージ1.5倍+陽線で再加速 |
| **損切り** | ATR×0.8 | ATR×0.8 |
| **利確** | トレーリングストップ（固定利確なし） | トレーリングストップ（固定利確なし） |
| **平均保有期間** | 1〜2日 | 1〜2日 |
| **ポジション上限** | 最大3（独立カウント） | 最大1（独立カウント） |

> **参考**: 週足レンジブレイク（weekly-break）は WF で堅牢判定（OOS PF=3.12）だが、combined バックテストで gapup/PSC と資金を奪い合うと PF・リターンとも現構成に劣るため、本番エントリーは無効化（`ENTRY_ENABLED: false`）。

### コアバリュー

| 価値 | 説明 |
|------|------|
| **リスク調整後リターン重視** | Calmar比・PF・期待値・最大DDを総合判断。per-trade期待値は必要条件であり十分条件ではない |
| **リスク管理** | ATRベースの機械的損切り、1トレードあたりリスク2%、連敗時のポジション縮小、VIX≥30で強制決済 |
| **自動化の徹底活用** | エントリー・損切り・トレーリングストップを自動判断・自動執行。回転率を最大化して大数の法則で勝つ |
| **継続的改善** | トレード結果を記録・分析し、walk-forward でパラメータの汎化性能を定期検証 |

## 1日の取引フロー

### 前場前（8:00 JST）

| 時刻 | ジョブ | 内容 |
|------|--------|------|
| 8:00 | market-assessment | 市場指標（日経225, VIX, S&P500等）取得 → メカニカルレジーム判定 → AI市場評価 → `shouldTrade` 判定 |
| 8:00 | watchlist-builder | 全銘柄からブレイクアウト候補をフィルタリング（流動性・価格・ボラティリティ・決算除外・週足トレンド） |

トリガー: cron-job.org → GitHub Actions (`cronjob_morning-analysis.yml`)

### 前場・後場（9:00〜15:30 JST）

| 時刻 | ジョブ | 内容 |
|------|--------|------|
| 9:00〜11:30 / 12:30〜15:30 毎分 | broker-reconciliation → position-monitor | 証券API保有/注文の突合、openポジションの損切り/トレーリングストップ/タイムストップ判定 |
| 15:24 | gapup-monitor | 当日のギャップアップ銘柄をスキャンし、クロージングオークション（15:25〜）直前に成行エントリー |
| 15:24 | psc-monitor | 高騰後押し目銘柄をスキャンし、クロージングオークション直前に成行エントリー |

position-monitor は Railway Worker の node-cron で市場時間中を毎分実行（11:30〜12:30の昼休みは除外）。15:24スキャナは接続エラー等のretryableな失敗時に20秒間隔で最大3回試行。

#### gapup戦略

- **エントリー条件**: ギャップアップ（3%以上）+ 陽線 + 出来高サージ（1.5倍以上）
- **時間帯**: 15:24（1日1回スキャン）
- **注文**: クロージングオークション狙いの成行買い → 約定後に逆指値SLを別途発注
- **ポジション上限**: 最大3

#### PSC戦略（高騰後押し目 / Post-Surge Consolidation）

- **エントリー条件**: 直近20日で+15%急騰 + 高値から-5%以内 + 出来高サージ（1.5倍以上）+ 陽線（4条件）
- **時間帯**: 15:24（1日1回スキャン）
- **注文**: クロージングオークション狙いの成行買い → 約定後に逆指値SLを別途発注
- **ポジション上限**: 最大1（独立カウント）

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
| 金曜 19:00 | weekly-memory-review | 記憶の週次振り返り（long-term昇格判定） |
| 土曜 9:00 | jpx-delisting-sync | JPX廃止予定銘柄の同期 |
| 土曜 10:00 | weekly-review | 週間パフォーマンス分析 + AI戦略レビュー |
| 土曜 10:00 | weekly-backtest | 統合バックテスト（combined）の定期実行 |
| 月初土曜 11:00 | monthly-walk-forward | 全戦略のwalk-forward分析 |
| 月曜 3:00 | data-cleanup | 古いデータの削除 |

### エグジット戦略

全戦略共通でATRベースSL + ブレイクイーブン + トレーリングストップ + タイムストップを採用。パラメータはwalk-forward検証による最適値。

| パラメータ | gapup | PSC |
|-----------|-------|-----|
| 損切り（SL） | ATR×0.8 | ATR×0.8 |
| BE発動 | ATR×0.3 | ATR×0.3 |
| トレール幅 | ATR×0.3 | ATR×0.5 |
| タイムストップ（基本） | 3営業日 | 5営業日 |
| タイムストップ（上限） | 5営業日 | 7営業日 |

### ジョブ実行基盤

| 基盤 | 用途 |
|------|------|
| Railway Worker (node-cron) | 市場時間中の毎分実行（broker-reconciliation + position-monitor）、15:24実行（gapup-monitor / psc-monitor） |
| cron-job.org → GitHub Actions | 時間の正確性が重要な日次バッチ（morning, eod） |
| GitHub Actions cron | 数分のズレが許容される処理（followup, weekly, backtest, cleanup） |

## 技術スタック

- **Runtime**: Hono + Node.js, TypeScript
- **Database**: PostgreSQL (Prisma ORM)
- **AI**: OpenAI (gpt-4o-mini)
- **株価データ**: yfinance (Python) / 立花証券 e支店 API v4r8
- **技術指標**: technicalindicators (npm)
- **インフラ**: Railway
- **スケジューラ**: cron-job.org / GitHub Actions / node-cron

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
