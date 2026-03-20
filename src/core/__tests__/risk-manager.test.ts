import { describe, it, expect } from "vitest";
import {
  estimateGapRisk,
  getRiskPctByScore,
  calculatePositionSize,
  validateStopLoss,
} from "../risk-manager";
import {
  STOP_LOSS,
  POSITION_SIZING,
  GAP_RISK,
} from "../../lib/constants";

// ========================================
// estimateGapRisk
// ========================================

describe("estimateGapRisk", () => {
  it("過去データにギャップなし + ATRあり → ATRフロアを返す", () => {
    // 全てギャップなし（open = prevClose）
    const data = Array.from({ length: 10 }, () => ({
      open: 1000,
      close: 1000,
    }));
    const atr14 = 30;
    const currentPrice = 1000;

    const result = estimateGapRisk(data, atr14, currentPrice);
    const expectedFloor =
      (atr14 * GAP_RISK.ATR_FLOOR_MULTIPLIER) / currentPrice;
    expect(result).toBeCloseTo(expectedFloor);
  });

  it("大きなギャップダウン → 実績値（ATRキャップまで）", () => {
    // i=0のopen=900, i=1のclose=1000 → ギャップダウン10%
    const data = [
      { open: 900, close: 1000 },
      { open: 1000, close: 1000 },
      { open: 1000, close: 1000 },
    ];
    const atr14 = 30;
    const currentPrice = 1000;

    const result = estimateGapRisk(data, atr14, currentPrice);
    const atrCap =
      (atr14 * GAP_RISK.ATR_CAP_MULTIPLIER) / currentPrice;
    // 10% > ATRキャップなのでキャップされる
    expect(result).toBeCloseTo(atrCap);
  });

  it("ATRなし → フォールバック3%をフロアとして使用", () => {
    const data = Array.from({ length: 10 }, () => ({
      open: 1000,
      close: 1000,
    }));
    const result = estimateGapRisk(data, null, 1000);
    expect(result).toBeCloseTo(0.03);
  });

  it("データ1件（lookback=0）→ maxGapDownPct=0, ATRフロアを返す", () => {
    const data = [{ open: 1000, close: 1000 }];
    const atr14 = 30;
    const currentPrice = 1000;

    const result = estimateGapRisk(data, atr14, currentPrice);
    const expectedFloor =
      (atr14 * GAP_RISK.ATR_FLOOR_MULTIPLIER) / currentPrice;
    expect(result).toBeCloseTo(expectedFloor);
  });

  it("prevClose=0 → スキップされる", () => {
    const data = [
      { open: 1000, close: 1000 },
      { open: 500, close: 0 }, // prevClose=0
      { open: 1000, close: 1000 },
    ];
    const result = estimateGapRisk(data, 30, 1000);
    // prevClose=0のペアはスキップされ、正常なペアのみ使用
    expect(result).toBeGreaterThan(0);
  });

  it("小さなギャップダウン → ATRフロアが優先", () => {
    // 1%のギャップダウン（ATRフロアより小さい）
    const data = [
      { open: 990, close: 1000 },
      { open: 1000, close: 1000 },
    ];
    const atr14 = 30;
    const currentPrice = 1000;

    const result = estimateGapRisk(data, atr14, currentPrice);
    const atrFloor =
      (atr14 * GAP_RISK.ATR_FLOOR_MULTIPLIER) / currentPrice;
    expect(result).toBeCloseTo(atrFloor);
  });
});

// ========================================
// getRiskPctByScore
// ========================================

describe("getRiskPctByScore", () => {
  it("score未指定 → デフォルト2%", () => {
    expect(getRiskPctByScore()).toBe(POSITION_SIZING.RISK_PER_TRADE_PCT);
    expect(getRiskPctByScore(undefined)).toBe(
      POSITION_SIZING.RISK_PER_TRADE_PCT,
    );
  });

  it("score=80（Sランク）→ 3.0%", () => {
    expect(getRiskPctByScore(80)).toBe(3.0);
  });

  it("score=75（Sランク境界）→ 3.0%", () => {
    expect(getRiskPctByScore(75)).toBe(3.0);
  });

  it("score=65（Aランク）→ 2.0%", () => {
    expect(getRiskPctByScore(65)).toBe(2.0);
  });

  it("score=60（Aランク境界）→ 2.0%", () => {
    expect(getRiskPctByScore(60)).toBe(2.0);
  });

  it("score=50（Bランク）→ 1.5%", () => {
    expect(getRiskPctByScore(50)).toBe(1.5);
  });

  it("score=0（Bランク最低）→ 1.5%", () => {
    expect(getRiskPctByScore(0)).toBe(1.5);
  });
});

// ========================================
// calculatePositionSize
// ========================================

describe("calculatePositionSize", () => {
  it("price <= 0 → 0", () => {
    expect(calculatePositionSize(0, 1000000, 20)).toBe(0);
    expect(calculatePositionSize(-100, 1000000, 20)).toBe(0);
  });

  it("budget <= 0 → 0", () => {
    expect(calculatePositionSize(1000, 0, 20)).toBe(0);
    expect(calculatePositionSize(1000, -100, 20)).toBe(0);
  });

  it("maxPositionPct <= 0 → 0", () => {
    expect(calculatePositionSize(1000, 1000000, 0)).toBe(0);
  });

  it("予算ベースのみ（SLなし）→ 100株単位", () => {
    // budget=1,000,000, pct=20%, price=1000
    // maxAmount = 200,000, shares = 200
    const result = calculatePositionSize(1000, 1000000, 20);
    expect(result).toBe(200);
    expect(result % 100).toBe(0);
  });

  it("リスクベースが予算ベースより小さい → リスクベースを採用", () => {
    // price=1000, SL=970, risk/share=30
    // score=50 → riskPct=1.5%, riskAmount=15,000
    // riskBasedShares = 15,000/30 = 500
    // budgetBased = 1,000,000 * 20% / 1000 = 200
    // min(200, 500) = 200 → 予算ベースの方が小さい
    //
    // price=1000, SL=995, risk/share=5 のケースで
    // riskBasedShares = 15,000/5 = 3000 → 予算ベース200が小さい → 200
    //
    // 逆にリスクが大きいケース:
    // price=5000, SL=4800, risk/share=200, budget=10,000,000, pct=20%
    // budgetBased = 10,000,000 * 20% / 5000 = 400
    // score=50 → riskPct=1.5%, riskAmount=150,000
    // riskBasedShares = 150,000/200 = 750
    // min(400, 750) = 400
    const result = calculatePositionSize(5000, 10000000, 20, 4800, undefined, 50);
    expect(result).toBe(400);

    // リスクベースが小さくなるケース
    // price=5000, SL=4900, risk/share=100, budget=10,000,000, pct=20%
    // budgetBased = 400
    // score=0 → riskPct=1.5%, riskAmount=150,000
    // riskBasedShares = 150,000/100 = 1500
    // min(400, 1500) = 400 ... まだ予算が小さい
    //
    // もっとSLを近くして riskAmount/riskPerShare を小さくする
    // price=1000, SL=950, risk/share=50, budget=5,000,000, pct=50%
    // budgetBased = 5,000,000 * 50% / 1000 = 2500
    // score=0 → riskPct=1.5%, riskAmount=75,000
    // riskBasedShares = 75,000/50 = 1500
    // min(2500, 1500) = 1500 → 100株単位 = 1500
    const result2 = calculatePositionSize(1000, 5000000, 50, 950, undefined, 0);
    expect(result2).toBe(1500);
  });

  it("100株単位に切捨て", () => {
    // budget=150,000, pct=100%, price=1000
    // budgetBased = 150 → 100株に切り捨て
    const result = calculatePositionSize(1000, 150000, 100);
    expect(result).toBe(100);
  });

  it("100株未満 → 0", () => {
    // budget=50,000, pct=100%, price=1000
    // budgetBased = 50 → 0株に切り捨て
    const result = calculatePositionSize(1000, 50000, 100);
    expect(result).toBe(0);
  });

  it("ギャップリスクがSLリスクより大きい → ギャップリスクを使用", () => {
    // price=1000, SL=990, slRisk=10
    // gapRiskPct=0.05, gapRisk=50
    // effectiveRisk = max(10, 50) = 50
    // score=75 → riskPct=3.0%, riskAmount=300,000
    // riskBasedShares = 300,000/50 = 6000
    // budgetBased = 10,000,000 * 20% / 1000 = 2000
    // min(2000, 6000) = 2000
    const result = calculatePositionSize(1000, 10000000, 20, 990, 0.05, 75);
    expect(result).toBe(2000);
  });

  it("スコアでリスク%が傾斜する", () => {
    // 同条件でスコアだけ変更
    // price=1000, SL=970, risk/share=30, budget=500,000, pct=100%
    // budgetBased = 500
    // score=80 → 3.0%, riskAmount=15,000, riskShares=500
    const highScore = calculatePositionSize(1000, 500000, 100, 970, undefined, 80);
    // score=0 → 1.5%, riskAmount=7,500, riskShares=250
    const lowScore = calculatePositionSize(1000, 500000, 100, 970, undefined, 0);
    expect(highScore).toBeGreaterThanOrEqual(lowScore);
  });
});

// ========================================
// validateStopLoss
// ========================================

describe("validateStopLoss", () => {
  it("全ルール通過 → wasOverridden=false", () => {
    // entryPrice=1000, SL=985 (1.5%下), ATR=20
    // gap=15, ATR*0.5=10 < 15, ATR*2.0=40 > 15 → OK
    const result = validateStopLoss(1000, 985, 20, []);
    expect(result.wasOverridden).toBe(false);
    expect(result.reason).toBe("OK");
    expect(result.validatedPrice).toBe(985);
  });

  it("最大損失率3%超過 → 強制3%に設定", () => {
    // entryPrice=1000, SL=960 (4%下) → 3%=970に強制
    const result = validateStopLoss(1000, 960, null, []);
    expect(result.wasOverridden).toBe(true);
    expect(result.validatedPrice).toBeCloseTo(
      1000 * (1 - STOP_LOSS.MAX_LOSS_PCT),
    );
  });

  it("ATR近すぎ（gap < ATR*0.5）→ ATR*0.8に引き上げ", () => {
    // entryPrice=1000, SL=996 (gap=4), ATR=20
    // ATR*0.5=10 > gap=4 → ATR*0.8=16 に引き上げ → SL=984
    const result = validateStopLoss(1000, 996, 20, []);
    expect(result.wasOverridden).toBe(true);
    expect(result.validatedPrice).toBeCloseTo(
      1000 - 20 * STOP_LOSS.ATR_DEFAULT_MULTIPLIER,
    );
  });

  it("ATR遠すぎ（gap > ATR*2.0）→ ATR*1.5に引き下げ", () => {
    // entryPrice=1000, SL=950 (gap=50), ATR=20
    // ATR*2.0=40 < gap=50 → ATR*1.5=30 に引き下げ → SL=970
    const result = validateStopLoss(1000, 950, 20, []);
    expect(result.wasOverridden).toBe(true);
    expect(result.validatedPrice).toBeCloseTo(
      1000 - 20 * STOP_LOSS.ATR_ADJUSTED_MULTIPLIER,
    );
  });

  it("ATRなし → 最大損失率チェックのみ適用", () => {
    // entryPrice=1000, SL=985 → 1.5% → OK
    const result = validateStopLoss(1000, 985, null, []);
    expect(result.wasOverridden).toBe(false);
    expect(result.validatedPrice).toBe(985);
  });

  it("ATR調整後に3%超過 → 最終チェックで3%に強制", () => {
    // entryPrice=1000, SL=985 (gap=15), ATR=100
    // ATR*0.5=50 > gap=15 → ATR*0.8=80 → SL=920 (8%下)
    // 最終チェック: 8% > 3% → 3%に強制 → SL=970
    const result = validateStopLoss(1000, 985, 100, []);
    expect(result.wasOverridden).toBe(true);
    expect(result.validatedPrice).toBeCloseTo(
      1000 * (1 - STOP_LOSS.MAX_LOSS_PCT),
    );
  });

  it("結果は小数第2位まで丸められる", () => {
    const result = validateStopLoss(1000, 985, 20, []);
    const decimalPlaces = result.validatedPrice.toString().split(".")[1];
    if (decimalPlaces) {
      expect(decimalPlaces.length).toBeLessThanOrEqual(2);
    }
  });
});
