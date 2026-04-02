#!/bin/bash
set -e

echo "[start] Starting yfinance sidecar..."
/opt/venv/bin/python yfinance-service/main.py &
PYTHON_PID=$!

# yfinance サービスの起動を待機（最大30秒）
for i in $(seq 1 30); do
  if curl -s http://localhost:8000/health > /dev/null 2>&1; then
    echo "[start] yfinance sidecar is ready (PID: $PYTHON_PID)"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "[start] WARNING: yfinance sidecar failed to start, continuing with yahoo-finance2 fallback"
  fi
  sleep 1
done

echo "[start] Running Prisma migrations..."
npx prisma migrate deploy

echo "[start] Starting Node.js worker..."
npx tsx src/worker.ts
