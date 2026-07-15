import { describe, it, expect } from "vitest";
import { evaluateDefensiveMode } from "../position-monitor";
import { determineMarketRegime } from "../../core/market-regime";

describe("evaluateDefensiveMode", () => {
  it("当日の評価が無い（market-assessment 未実行）→ 発火しない", () => {
    // stale な前日値で全決済する方が有害。SLは板に生きているので保護は残る（却下リスト #25）
    expect(evaluateDefensiveMode(null)).toEqual({ active: false, trigger: null });
  });

  it("sentiment=crisis（日経/CMEキルスイッチ）→ 発火", () => {
    const r = evaluateDefensiveMode({ sentiment: "crisis", vix: 15 });
    expect(r.active).toBe(true);
    expect(r.trigger).toContain("日経/CME");
  });

  it("VIX > 30 → 発火（sentiment が normal でも）", () => {
    // sentiment は日経-3%/CME-3%でしか立たず VIX では立たない。
    // BT は VIX>30 で決済する前提なので、ここで拾わないと BT と乖離する。
    const r = evaluateDefensiveMode({ sentiment: "normal", vix: 30.1 });
    expect(r.active).toBe(true);
    expect(r.trigger).toContain("VIX 30.1");
  });

  it("VIX ちょうど30 → 発火しない（BT の determineMarketRegime と同じ排他的比較）", () => {
    expect(evaluateDefensiveMode({ sentiment: "normal", vix: 30 }).active).toBe(false);
  });

  it("VIX が null（データ欠損）→ 発火しない", () => {
    expect(evaluateDefensiveMode({ sentiment: "normal", vix: null }).active).toBe(false);
  });

  it("VIX が数値化できない → 発火しない（NaN で誤発火しない）", () => {
    expect(evaluateDefensiveMode({ sentiment: "normal", vix: "N/A" }).active).toBe(false);
  });

  it("Prisma Decimal 相当（toString を持つオブジェクト）でも数値として扱える", () => {
    const decimalLike = { toString: () => "35.5", valueOf: () => 35.5 };
    expect(evaluateDefensiveMode({ sentiment: "normal", vix: decimalLike }).active).toBe(true);
  });

  // ============================================================
  // BT ↔ 本番のパリティ（KOH-551 の本題）
  // ============================================================
  it("BT の processDefensive と同一条件で発火する", () => {
    // BT: `todayRegime === "crisis"` (determineMarketRegime(vix).level)
    // 本番: evaluateDefensiveMode({sentiment:"normal", vix}).active
    // 両者が全VIX帯で一致することを確認する
    for (const vix of [10, 19.9, 20, 24.9, 25, 29.9, 30, 30.1, 35, 52.3, 82.7]) {
      const btWouldClose = determineMarketRegime(vix).level === "crisis";
      const liveWouldClose = evaluateDefensiveMode({ sentiment: "normal", vix }).active;
      expect(liveWouldClose, `VIX ${vix} で BT と本番が不一致`).toBe(btWouldClose);
    }
  });
});
