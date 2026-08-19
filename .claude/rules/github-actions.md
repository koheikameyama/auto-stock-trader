# GitHub Actions

## ワークフローファイル命名規則

| プレフィックス | 意味 | 例 |
|---|---|---|
| `cronjob_` | cron-job.org から直接トリガー | `cronjob_end-of-day.yml` |
| `scheduled_` | GitHub Actions cron スケジュール | `scheduled_weekly-review.yml` |
| `reusable_` | 他ワークフローから呼び出される | `reusable_backfill-stock-data.yml` |
| `ci_` | CI（テスト・lint等） | `ci_test.yml` |

## スケジューラの使い分け

**時間の正確性が重要なバッチ処理は cron-job.org を使用してください。**

### 理由

GitHub Actionsのcronスケジュールは実行タイミングが数分〜数十分ずれることがある。取引時間に連動する処理など、時間の正確性が求められるバッチはcron-job.orgを使用する。

### 使い分け基準

| スケジューラ | 用途 | 対象ジョブ |
|-------------|------|-----------|
| **cron-job.org** | 平日に毎日実行するバッチ処理 | morning-analysis, order-manager, end-of-day, ghost-review, defensive-exit-followup, unfilled-order-followup, daily-backtest |
| **GitHub Actions cron** | 週末・低頻度など、数分〜数十分のズレが許容される処理 | jpx-delisting-sync, weekly-review, scoring-accuracy-report, check-openai-usage, backfill-prices |

### ⛔ cron の day-of-month と day-of-week は OR になる

**「第1土曜」のつもりで `"0 2 1-7 * 6"` と書いてはいけない。**

POSIX cron 仕様では、day-of-month (第3フィールド) と day-of-week (第5フィールド) の**両方**を
`*` 以外にすると **OR 条件**になる。`"0 2 1-7 * 6"` は「毎月1〜7日の土曜」ではなく
**「毎月1〜7日の毎日 + 毎週土曜」= 月11〜12回**実行される。

実例 (KOH-605): `scheduled_monthly-strategy-health.yml` がこの書き方で 2026-05〜08 の3ヶ月間
毎日実行され続けた (CI 約12分/回の浪費 + Slack に「月次」レポートが連日投下)。

**正しい書き方**: cron は片側だけ指定し、もう片側の条件はゲートジョブで判定する。

```yaml
on:
  schedule:
    - cron: "0 2 * * 6"  # 毎週土曜に起動し、ジョブ側で第1土曜に絞る

jobs:
  check-first-saturday:
    runs-on: ubuntu-latest
    outputs:
      run: ${{ steps.gate.outputs.run }}
    steps:
      - id: gate
        run: |
          DAY=$(TZ=Asia/Tokyo date +%-d)
          if [ "${{ github.event_name }}" = "workflow_dispatch" ] || [ "$DAY" -le 7 ]; then
            echo "run=true" >> "$GITHUB_OUTPUT"
          else
            echo "run=false" >> "$GITHUB_OUTPUT"
          fi

  main-job:
    needs: check-first-saturday
    if: needs.check-first-saturday.outputs.run == 'true'
```

- `workflow_dispatch` (手動実行) はゲートを素通しにする
- 後続ジョブに `if: always()` がある場合は `always() && needs.check-first-saturday.outputs.run == 'true'` にする (ゲートまで素通ししてしまうため)

### cron-job.orgの設定方法

**設定変更はcron-job.org APIを使用してください。**

```bash
# ジョブ一覧取得
curl -s -H "Authorization: Bearer $CRONJOB_API_KEY" \
  "https://api.cron-job.org/jobs" | jq

# ジョブ作成
curl -s -X PUT -H "Authorization: Bearer $CRONJOB_API_KEY" \
  -H "Content-Type: application/json" \
  "https://api.cron-job.org/jobs" \
  -d '{
    "job": {
      "url": "https://example.com/api/cron/endpoint",
      "title": "ジョブ名",
      "enabled": true,
      "schedule": {
        "timezone": "Asia/Tokyo",
        "hours": [9],
        "minutes": [0],
        "mdays": [-1],
        "months": [-1],
        "wdays": [1,2,3,4,5]
      },
      "requestMethod": 1
    }
  }'

# ジョブ更新
curl -s -X PATCH -H "Authorization: Bearer $CRONJOB_API_KEY" \
  -H "Content-Type: application/json" \
  "https://api.cron-job.org/jobs/{jobId}" \
  -d '{
    "job": { "enabled": false }
  }'
```

### チェックリスト

新しいバッチ処理追加時：
- [ ] 時間の正確性が必要か判断
- [ ] 必要 → cron-job.orgにAPIで設定
- [ ] 不要 → GitHub Actions cronで設定

## ワークフローのジョブ設計

**複数のタスクを実行するワークフローは、ジョブ（jobs）を分割してください。**

### 理由

1. **再実行性**: 失敗したジョブから再実行できる（Re-run failed jobs）
2. **依存関係の明確化**: `needs` で実行順序を定義
3. **並列実行**: 独立したジョブは並列で実行される

### 基本パターン

```yaml
jobs:
  task-a:
    runs-on: ubuntu-latest
    steps: ...

  task-b:
    needs: task-a # task-a の完了後に実行
    runs-on: ubuntu-latest
    steps: ...

  task-c:
    needs: task-a # task-b と並列実行可能
    runs-on: ubuntu-latest
    steps: ...

  notify:
    needs: [task-b, task-c]
    if: always() # 前のジョブが失敗しても実行
    runs-on: ubuntu-latest
    steps: ...
```

### 条件付き実行

```yaml
jobs:
  determine-context:
    runs-on: ubuntu-latest
    outputs:
      context: ${{ steps.check.outputs.context }}
    steps:
      - id: check
        run: echo "context=close" >> $GITHUB_OUTPUT

  conditional-job:
    needs: determine-context
    if: needs.determine-context.outputs.context == 'close'
    runs-on: ubuntu-latest
    steps: ...
```

### チェックリスト

新しいワークフロー作成時：

- [ ] 1つのジョブに複数の独立したタスクを詰め込まない
- [ ] `needs` で依存関係を定義
- [ ] 通知ジョブは `if: always()` で常に実行
- [ ] 条件付き実行が必要な場合は出力変数を使用

## スクリプト言語の選択

**GitHub Actionsでスクリプトを作成する場合は必ずPythonを使用してください。**

### 理由

1. **エラーハンドリング**: try-exceptで詳細なエラー処理が可能
2. **ログ出力**: 進捗状況を詳細に表示できる
3. **保守性**: コードが読みやすく、修正しやすい
4. **YAML干渉回避**: heredoc構文によるYAMLパーサーエラーを防げる

### ✅ 良い例（Python）

```yaml
- name: Generate daily reports
  env:
    APP_URL: ${{ secrets.APP_URL }}
    CRON_SECRET: ${{ secrets.CRON_SECRET }}
  run: python scripts/generate_daily_report.py
```

```python
# scripts/generate_daily_report.py
import requests
import sys
import os

def generate_reports(app_url: str, cron_secret: str):
    try:
        response = requests.post(
            f"{app_url}/api/reports/generate-all",
            headers={"Authorization": f"Bearer {cron_secret}"},
            timeout=180
        )

        if response.status_code not in [200, 201]:
            print(f"Error: {response.text}")
            sys.exit(1)

        print("✅ Reports generated successfully")
        return response.json()
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    app_url = os.getenv("APP_URL")
    cron_secret = os.getenv("CRON_SECRET")
    generate_reports(app_url, cron_secret)
```

### ❌ 悪い例（curl + heredoc）

```yaml
- name: Generate daily reports
  run: |
    curl -X POST "$APP_URL/api/reports/generate-all" \
      -H "Authorization: Bearer $CRON_SECRET" \
      -d "$(cat <<'EOF'
    {
      "key": "value"
    }
    EOF
    )"
```

### 既存のPythonスクリプト

プロジェクトには以下のPythonスクリプトがあります：

- `scripts/generate_daily_analysis.py` - 日次分析実行
- `scripts/generate_daily_report.py` - 週次レポート生成
- `scripts/generate_featured_stocks.py` - 今日の注目銘柄生成
- `scripts/fetch_stocks.py` - 株価データ取得
- `scripts/init_data.py` - 初期データ投入

## Slack通知

**GitHub Actionsワークフローには必ずSlack通知を追加してください。**

### 標準パターン

```yaml
- name: Notify Slack on success
  if: success()
  uses: rtCamp/action-slack-notify@v2
  env:
    SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK_URL }}
    SLACK_TITLE: "✅ [処理名]に成功しました"
    SLACK_MESSAGE: |
      処理の詳細メッセージ ✅
    SLACK_COLOR: good
    SLACK_FOOTER: "Auto Stock Trader"

- name: Notify Slack on failure
  if: failure()
  uses: rtCamp/action-slack-notify@v2
  env:
    SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK_URL }}
    SLACK_TITLE: "❌ [処理名]に失敗しました"
    SLACK_MESSAGE: |
      処理中にエラーが発生しました
      詳細はGitHub Actionsログを確認してください
    SLACK_COLOR: danger
    SLACK_FOOTER: "Auto Stock Trader"
```

### ルール

1. **成功時**: `if: success()` で緑色（`good`）通知
2. **失敗時**: `if: failure()` で赤色（`danger`）通知
3. **アクション**: `rtCamp/action-slack-notify@v2` を使用
4. **Webhook**: `secrets.SLACK_WEBHOOK_URL` を使用
5. **フッター**: 必ず `"Auto Stock Trader"` を設定

### チェックリスト

新しいワークフロー作成時：

- [ ] 成功時のSlack通知を追加
- [ ] 失敗時のSlack通知を追加
- [ ] タイトルに処理内容を明記
- [ ] メッセージに適切な詳細を記載
