#!/bin/bash
# ============================================
# cron-job.org 更新スクリプト
# PR #119 マージ後に実行すること
# ============================================
set -euo pipefail

# .env から API キーを読み込み
source "$(dirname "$0")/../.env"

API="https://api.cron-job.org/jobs"
AUTH="Authorization: Bearer $CRONJOB_API_KEY"

# GitHub PAT を既存ジョブから取得
echo "📋 既存ジョブから GitHub PAT を取得中..."
GH_PAT=$(curl -s -H "$AUTH" "$API/7321804" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(data['jobDetails']['extendedData']['headers']['Authorization'].split(' ')[1])
")
echo "✅ PAT 取得完了"

# ── 1. 不要ジョブの削除（12件） ──
echo ""
echo "🗑️  不要ジョブを削除中..."

DELETE_IDS=(
  # featured-stocks.yml (廃止)
  7319333  # featured-stocks 10:30 JST
  7319337  # featured-stocks 09:30 JST
  7319334  # featured-stocks 13:00 JST
  7319335  # featured-stocks 14:00 JST
  7319336  # featured-stocks 15:40 JST
  # fetch-news.yml (session-batch に統合)
  7321802  # fetch-news 07:30 JST
  7321803  # fetch-news 12:00 JST
  # stock-predictions.yml (session-batch に変更)
  7319340  # stock-predictions 09:30 JST
  7319341  # stock-predictions 10:30 JST
  7319342  # stock-predictions 13:00 JST
  7319343  # stock-predictions 14:00 JST
  7319344  # stock-predictions 15:40 JST
)

for JOB_ID in "${DELETE_IDS[@]}"; do
  RESULT=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE -H "$AUTH" "$API/$JOB_ID")
  if [ "$RESULT" = "200" ]; then
    echo "  ✅ 削除: $JOB_ID"
  else
    echo "  ❌ 削除失敗: $JOB_ID (HTTP $RESULT)"
  fi
done

# ── 2. recommendation-report → ai-accuracy-report に更新 ──
echo ""
echo "🔄 recommendation-report を ai-accuracy-report に更新中..."

RESULT=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH -H "$AUTH" -H "Content-Type: application/json" \
  "$API/7321805" \
  -d '{
    "job": {
      "title": "ai-accuracy-report 18:00 JST",
      "url": "https://api.github.com/repos/koheikameyama/stock-buddy/actions/workflows/ai-accuracy-report.yml/dispatches"
    }
  }')
if [ "$RESULT" = "200" ]; then
  echo "  ✅ 更新完了"
else
  echo "  ❌ 更新失敗 (HTTP $RESULT)"
fi

# ── 3. session-batch ジョブを新規作成（5件） ──
echo ""
echo "➕ session-batch ジョブを作成中..."

SESSIONS=("morning:0:10:session-batch morning 09:10 JST" "mid-morning:1:10:session-batch mid-morning 10:10 JST" "afternoon:3:40:session-batch afternoon 12:40 JST" "mid-afternoon:4:40:session-batch mid-afternoon 13:40 JST" "close:6:40:session-batch close 15:40 JST")

for ENTRY in "${SESSIONS[@]}"; do
  IFS=':' read -r SESSION HOUR MINUTE TITLE <<< "$ENTRY"

  RESULT=$(curl -s -X PUT -H "$AUTH" -H "Content-Type: application/json" \
    "$API" \
    -d "{
      \"job\": {
        \"url\": \"https://api.github.com/repos/koheikameyama/stock-buddy/actions/workflows/session-batch.yml/dispatches\",
        \"title\": \"$TITLE\",
        \"enabled\": true,
        \"saveResponses\": true,
        \"schedule\": {
          \"timezone\": \"UTC\",
          \"hours\": [$HOUR],
          \"minutes\": [$MINUTE],
          \"mdays\": [-1],
          \"months\": [-1],
          \"wdays\": [1,2,3,4,5]
        },
        \"requestMethod\": 1,
        \"extendedData\": {
          \"headers\": {
            \"Accept\": \"application/vnd.github.v3+json\",
            \"Authorization\": \"Bearer $GH_PAT\"
          },
          \"body\": \"{\\\"ref\\\": \\\"main\\\", \\\"inputs\\\": {\\\"session\\\": \\\"$SESSION\\\"}}\"
        }
      }
    }")

  JOB_ID=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('jobId','ERROR'))" 2>/dev/null || echo "ERROR")
  if [ "$JOB_ID" != "ERROR" ]; then
    echo "  ✅ 作成: $TITLE (jobId: $JOB_ID)"
  else
    echo "  ❌ 作成失敗: $TITLE"
    echo "     $RESULT"
  fi
done

# ── 4. 最終確認 ──
echo ""
echo "📋 最終ジョブ一覧:"
curl -s -H "$AUTH" "$API" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for job in sorted(data['jobs'], key=lambda j: j['title']):
    status = '🟢' if job['enabled'] else '🔴'
    print(f\"  {status} {job['jobId']:>8} | {job['title']}\")
"

echo ""
echo "✅ cron-job.org 更新完了！"
