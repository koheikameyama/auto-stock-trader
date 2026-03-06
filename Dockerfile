FROM node:22-slim

WORKDIR /app

# OpenSSL for Prisma
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev

COPY . .

CMD npx prisma migrate deploy && npx tsx src/worker.ts
