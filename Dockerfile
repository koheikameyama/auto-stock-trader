FROM node:22-slim

WORKDIR /app

# OpenSSL for Prisma + Python3 for yfinance sidecar + curl for health check
RUN apt-get update -y && \
    apt-get install -y openssl python3 python3-pip python3-venv curl && \
    rm -rf /var/lib/apt/lists/*

# Python yfinance サービスの依存関係インストール
COPY yfinance-service/requirements.txt ./yfinance-service/
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir -r yfinance-service/requirements.txt

# Node.js 依存関係インストール
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev --ignore-scripts && \
    npx prisma generate

COPY . .

CMD ["bash", "scripts/start.sh"]
