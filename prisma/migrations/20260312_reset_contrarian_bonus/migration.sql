-- 逆行ボーナス条件厳格化に伴い、旧基準で付与済みのボーナスをリセット
UPDATE "ScoringRecord" SET "contrarianBonus" = 0 WHERE "contrarianBonus" > 0;
