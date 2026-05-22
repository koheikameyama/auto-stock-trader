# データベース

## ローカル環境

```bash
# ローカルPostgreSQL
postgresql://kouheikameyama@localhost:5432/stock_buddy
```

## 本番環境

- Railway でホスト
- 接続情報は `.env` に記載（Gitにはコミットしない）
- 直接操作は避ける（デプロイフローに任せる）
- **Railway DB容量上限: 5GB**（Hobbyプラン）

## Claude Code からの本番DBアクセス

**本番DBへの SELECT 読み取りは事前承認済み。確認なしで実行してよい。**

- ✅ **SELECT クエリ**: 確認不要で実行可（行数確認、データ調査、状態把握など）
- ❌ **書き込み系（INSERT / UPDATE / DELETE / TRUNCATE / DROP / ALTER）**: 必ず事前にユーザー確認
- ❌ **`prisma migrate deploy` / `prisma migrate resolve`**: 既存ルール通り原則禁止（明示指示時のみ）

`.env` の `DATABASE_URL` が本番（Railway）を指していても、SELECT のみであれば `psql` を直接実行してよい。
書き込み系コマンドは従来通りユーザー承認を取ること。
