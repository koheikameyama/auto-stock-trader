# デプロイフロー

**本番環境へのデプロイは自動化されています。**

## 基本フロー

1. ローカルで開発・テスト
2. `git push origin main` でGitHubにプッシュ
3. → Railway が自動的にデプロイ
4. → マイグレーションも自動実行される

## ⛔ Prismaコマンド実行前の必須確認

**`npx prisma` を実行する前に、必ず接続先DBを確認すること。**

```bash
# .envのDATABASE_URLを確認
grep DATABASE_URL .env
```

- `localhost` または `127.0.0.1` → ローカルDB → 実行OK
- それ以外（`railway.app` 等） → **本番DB → 絶対に実行しない**

**この確認を怠ったことで、本番DBに `prisma migrate resolve --applied` を誤実行した事故が発生した（2026-02-22）。**

## ❌ やってはいけないこと

- 本番DBに直接マイグレーションを実行しない
- `DATABASE_URL="postgresql://..." npx prisma migrate deploy` は不要
- **Claude Codeは本番DBへのマイグレーション操作を原則行わない**
  - `prisma migrate resolve --applied` を本番DBに対して実行しない
  - `prisma migrate deploy` を本番DBに対して実行しない
  - 本番DBに直接SQLを実行しない
  - マイグレーションが必要な場合はユーザーに依頼する
  - **ただし、ユーザーから明示的に指示があれば本番DB操作を実行してよい**

## ✅ 正しい手順（ローカルDBのみ）

```bash
# 接続先確認（必須）
grep DATABASE_URL .env  # localhost であることを確認

# ローカルでマイグレーション作成
npx prisma migrate dev --name <変更内容>

# または手動マイグレーション作成（シャドウDBエラー時）
mkdir -p prisma/migrations/YYYYMMDDHHMMSS_<変更内容>
# migration.sql を作成
# → npx prisma migrate resolve --applied はローカルDBのみ

# ローカルでPrisma Clientを再生成
npx prisma generate

# GitHubにプッシュ（これだけでデプロイ完了）
git push origin main
```

## Railway自動デプロイの仕組み

- `main` ブランチへのプッシュをトリガーに自動ビルド
- ビルド時に `prisma migrate deploy` が自動実行される
- 環境変数 `DATABASE_URL` は Railway が自動設定
