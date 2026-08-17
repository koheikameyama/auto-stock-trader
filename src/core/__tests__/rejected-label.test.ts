import { describe, it, expect, vi } from "vitest";

// ========================================
// モック設定
// ========================================
// entry-executor は prisma / slack / ブローカーを import するが、ここで検証するのは
// 純粋関数（棄却理由 → ラベル）だけなので、モジュール読み込みが通る最小限だけを潰す。

vi.mock("../../lib/prisma", () => ({
  prisma: {
    rejectedSignal: { findFirst: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("../../lib/slack", () => ({
  notifySlack: vi.fn().mockResolvedValue(undefined),
  notifyOrderPlaced: vi.fn().mockResolvedValue(undefined),
}));

import { getRejectedLabel, NOTIFY_REJECT_LABELS } from "../breakout/entry-executor";
import { checkLiquidity } from "../market-data";
import { LIQUIDITY_FILTER } from "../../lib/constants";

/**
 * ★このテストの主目的は「reason の文面 → ラベル」の対応を固定すること。
 *
 * getRejectedLabel は正規表現で理由文を後付け分類するため、理由を生成する側の文言を
 * 変えるとラベルが静かに「その他」へ落ち、Slack 通知（NOTIFY_REJECT_LABELS）から
 * 外れる。2026-08-14 に GU の板薄棄却2件が無通知で消えたのがこれ。
 * よって**実際の生成元（checkLiquidity など）が返す文字列そのもの**を食わせて検証する。
 */
describe("getRejectedLabel — 流動性系（実際の checkLiquidity の出力で検証）", () => {
  it("板薄で弾かれた reason が「流動性不足」に分類され、通知対象に入る", () => {
    // 注文300株に対し売り板101株（2026-08-14 の 3660.T と同じ状況）
    const result = checkLiquidity(
      { price: 516, askPrice: 517, bidPrice: 516, askSize: 101, bidSize: 500 },
      300,
    );

    expect(result.isLiquid).toBe(false);
    expect(result.reason).toBeDefined();
    expect(getRejectedLabel(result.reason!)).toBe("流動性不足");
    expect(NOTIFY_REJECT_LABELS.has(getRejectedLabel(result.reason!))).toBe(true);
  });

  it("スプレッド超過で弾かれた reason が「流動性不足」に分類され、通知対象に入る", () => {
    // spread が上限を超える板（price 比で MAX_SPREAD_PCT 超）
    const price = 1000;
    const spread = price * (LIQUIDITY_FILTER.MAX_SPREAD_PCT / 100) * 2;
    const result = checkLiquidity(
      { price, askPrice: price + spread, bidPrice: price, askSize: 10000, bidSize: 10000 },
      100,
    );

    expect(result.isLiquid).toBe(false);
    expect(getRejectedLabel(result.reason!)).toBe("流動性不足");
    expect(NOTIFY_REJECT_LABELS.has(getRejectedLabel(result.reason!))).toBe(true);
  });
});

describe("getRejectedLabel — 他経路の代表的な reason", () => {
  it.each([
    ["セクター集中制限: 半導体・電子部品に既に2ポジション保有中（上限: 2）", "セクター集中"],
    ["マクロファクター集中制限: 金利敏感に既に2ポジション保有中（上限: 2）", "マクロ集中"],
    ["gapup 戦略の最大同時保有数（3）に達しています（保有 3 + 発注中 0）", "ポジション数上限"],
    ["現金残高不足（残高: 100000円、必要額: 150000円）", "残高不足"],
    ["集中率上限（33%）を超えるためスキップ（既存投資額: ¥0）", "集中率上限"],
    ["枠上限（GU 3枠を使い切り）で候補を評価せず見送り", "枠上限"],
    ["日次損失制限に達しています。本日の新規取引は停止中です", "日次損失制限"],
    ["3連敗クールダウン中: 最大1ポジション制限（現在: 1）", "連敗クールダウン"],
  ])("%s → %s", (reason, expected) => {
    expect(getRejectedLabel(reason)).toBe(expected);
  });

  it("分類できない理由は「その他」に落ち、かつ通知される（分類漏れを検知するため）", () => {
    expect(getRejectedLabel("未知の理由でスキップしました")).toBe("その他");
    expect(NOTIFY_REJECT_LABELS.has("その他")).toBe(true);
  });
});
