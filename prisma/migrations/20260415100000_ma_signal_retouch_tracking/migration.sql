-- AlterTable: MA押し目シグナルにリタッチ追跡カラムを追加
-- touchCount: MAタッチ回数（多いほどサポートが強い）
-- lastTouchAt: 最新リタッチ時刻（NULLなら初回タッチのみ）
-- lastTouchPrice: 最新リタッチ価格（プロはこの価格でエントリー判断）

ALTER TABLE "IntraDayMaPullbackSignal" ADD COLUMN "touchCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "IntraDayMaPullbackSignal" ADD COLUMN "lastTouchAt" TIMESTAMP(3);
ALTER TABLE "IntraDayMaPullbackSignal" ADD COLUMN "lastTouchPrice" DOUBLE PRECISION;
