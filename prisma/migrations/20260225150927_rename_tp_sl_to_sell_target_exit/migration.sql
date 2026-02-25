-- UserDailyRecommendation: カラム名変更（利確/損切り → 売却目標/撤退ライン）
ALTER TABLE "UserDailyRecommendation" RENAME COLUMN "takeProfitRate" TO "sellTargetRate";
ALTER TABLE "UserDailyRecommendation" RENAME COLUMN "stopLossRate" TO "exitRate";
