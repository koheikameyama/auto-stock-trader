-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastActivityAt" TIMESTAMP(3);

-- Backfill: 既存ユーザーの lastActivityAt を updatedAt で初期化
-- デプロイ直後に全ユーザーが非アクティブ扱いになるのを防ぐ
UPDATE "User" SET "lastActivityAt" = "updatedAt";

-- CreateIndex
CREATE INDEX "User_lastActivityAt_idx" ON "User"("lastActivityAt");
