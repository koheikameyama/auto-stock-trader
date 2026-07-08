import { describe, it, expect, vi } from "vitest";

// renderDailyPost は純関数だが、モジュール import 時に prisma / bluesky 連鎖が
// 走るため軽量モックで遮断する
vi.mock("../../lib/prisma", () => ({ prisma: {} }));
vi.mock("../../lib/bluesky", () => ({ postToBluesky: vi.fn() }));
vi.mock("../../lib/threads", () => ({ postToThreads: vi.fn() }));
vi.mock("../../lib/slack", () => ({ notifySlack: vi.fn() }));

import { renderDailyPost, renderXPost, DISCLAIMER, X_DISCLAIMER } from "../daily-social-post";
import { PUBLIC_SITE_URL } from "../../lib/constants";
import type {
  PerformanceSnapshot,
  ClosedTradePerf,
  EntryContext,
} from "../../core/public-performance";

function graphemes(text: string): number {
  return [...text].length;
}

function ctx(date: string, breadthPct: number): EntryContext {
  return { date, breadthPct, level: "MODERATE_BULL", emoji: "🟢" };
}

function trade(
  returnPct: number,
  entryDate: string,
  entry: EntryContext | null,
): ClosedTradePerf {
  return { returnPct, entryDate, exitDate: "2026-07-06", entry };
}

function mkPerf(closed: ClosedTradePerf[], newEntries = 0): PerformanceSnapshot {
  const wins = closed.filter((t) => t.returnPct >= 0).length;
  return {
    today: {
      newEntries,
      closed,
      wins,
      losses: closed.length - wins,
      weightedReturnPct: 2.0,
    },
    month: { wins: 4, losses: 2, pf: 2.1 },
    cumulativeReturnPct: 12.3,
    recentClosed: closed,
  };
}

const DAY_LABEL = "7/6(月)";
const REGIME_LINE = "相場: breadth 48.2% ／ VIX 18.3 ／ ⚪ 強気2/5";

describe("renderDailyPost", () => {
  it("決済3件以下は1件ずつ仕込み時局面を添える", () => {
    const text = renderDailyPost({
      dayLabel: DAY_LABEL,
      regimeLine: REGIME_LINE,
      perf: mkPerf([
        trade(4.2, "2026-06-30", ctx("2026-06-30", 62)),
        trade(-0.8, "2026-07-02", ctx("2026-07-02", 55)),
      ]),
    });

    expect(text).toContain("決済2件（1勝1敗）損益 +2.0%");
    expect(text).toContain("└ +4.2%（6/30 🟢breadth 62%で仕込み）");
    expect(text).toContain("└ -0.8%（7/2 🟢breadth 55%で仕込み）");
    expect(text).toContain(DISCLAIMER);
    expect(graphemes(text)).toBeLessThanOrEqual(300);
  });

  it("決済4件以上は仕込み日・breadthのレンジで集約する", () => {
    const text = renderDailyPost({
      dayLabel: DAY_LABEL,
      regimeLine: REGIME_LINE,
      perf: mkPerf([
        trade(4.2, "2026-06-30", ctx("2026-06-30", 62)),
        trade(-0.8, "2026-07-01", ctx("2026-07-01", 58)),
        trade(1.1, "2026-07-02", ctx("2026-07-02", 55)),
        trade(2.5, "2026-07-02", ctx("2026-07-02", 55)),
      ]),
    });

    expect(text).toContain("仕込み: 6/30〜7/2（breadth 55〜62%）");
    expect(text).not.toContain("└");
  });

  it("局面が復元できないトレードは損益のみ表示する", () => {
    const text = renderDailyPost({
      dayLabel: DAY_LABEL,
      regimeLine: REGIME_LINE,
      perf: mkPerf([trade(4.2, "2026-06-30", null)]),
    });

    expect(text).toContain("└ +4.2%");
    expect(text).not.toContain("で仕込み");
  });

  it("決済・新規なしの日は「休む局面」を維持する", () => {
    const text = renderDailyPost({
      dayLabel: DAY_LABEL,
      regimeLine: REGIME_LINE,
      perf: mkPerf([]),
    });

    expect(text).toContain("本日: エントリーなし（休む局面）");
  });

  it("300 grapheme に収まらない場合は仕込み表記を段階的に落とす（免責は常に残す）", () => {
    const closed = [
      trade(4.2, "2026-06-30", ctx("2026-06-30", 62)),
      trade(-0.8, "2026-07-01", ctx("2026-07-01", 58)),
      trade(1.1, "2026-07-02", ctx("2026-07-02", 55)),
    ];

    // regimeLine を伸ばしながら「明細を出すなら必ず300以内 / 溢れたら明細を落とす」
    // という不変条件を確認する
    for (let len = 0; len <= 220; len += 10) {
      const text = renderDailyPost({
        dayLabel: DAY_LABEL,
        regimeLine: "R".repeat(len),
        perf: mkPerf(closed),
      });

      if (text.includes("で仕込み") || text.includes("仕込み:")) {
        expect(graphemes(text)).toBeLessThanOrEqual(300);
      }
      expect(text).toContain(DISCLAIMER);
    }

    // 短い regimeLine では per-trade 明細、極端に長いと明細なしに落ちる
    const short = renderDailyPost({
      dayLabel: DAY_LABEL,
      regimeLine: REGIME_LINE,
      perf: mkPerf(closed),
    });
    expect(short).toContain("で仕込み");

    const long = renderDailyPost({
      dayLabel: DAY_LABEL,
      regimeLine: "R".repeat(220),
      perf: mkPerf(closed),
    });
    expect(long).not.toContain("で仕込み");
    expect(long).not.toContain("仕込み:");
    expect(long).toContain("[+4.2% / -0.8% / +1.1%]");
  });
});

/** X(twitter-text) の重み付け文字数。URLは23固定、CJK/かな/全角は2、他は1 */
function xWeighted(text: string): number {
  const t = text.replace(/https?:\/\/\S+/g, "x".repeat(23));
  let w = 0;
  for (const ch of t) {
    const c = ch.codePointAt(0)!;
    const cjk =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0x303e) ||
      (c >= 0x3041 && c <= 0x33ff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    w += cjk ? 2 : 1;
  }
  return w;
}

const REGIME_COMPACT = "🟢 強気3/5 ／ breadth 55% ／ VIX 18.5";

describe("renderXPost", () => {
  it("決済ありの日を1行ずつのコンパクト本文にまとめ、X上限(280)に収める", () => {
    const x = renderXPost({
      dayLabel: DAY_LABEL,
      regimeCompact: REGIME_COMPACT,
      perf: mkPerf([
        trade(4.2, "2026-06-30", ctx("2026-06-30", 62)),
        trade(-0.8, "2026-07-02", ctx("2026-07-02", 55)),
      ]),
    });

    expect(x).toContain("📊 自動売買ログ 7/6(月)");
    expect(x).toContain(REGIME_COMPACT);
    expect(x).toContain("本日 決済2件 損益+2.0%");
    expect(x).toContain("今月4勝2敗 PF2.10");
    expect(x).toContain("累計+12.3%");
    expect(x).toContain(X_DISCLAIMER);
    expect(x).toContain(PUBLIC_SITE_URL);
    // per-trade明細・空行は持たない（コンパクト）
    expect(x).not.toContain("└");
    expect(x).not.toContain("\n\n");
    // X無料枠の上限に収まる
    expect(xWeighted(x)).toBeLessThanOrEqual(280);
  });

  it("決済なし・エントリーなしの日は「休む局面」を1行で表す", () => {
    const x = renderXPost({
      dayLabel: DAY_LABEL,
      regimeCompact: REGIME_COMPACT,
      perf: mkPerf([]),
    });
    expect(x).toContain("本日 エントリーなし（休む局面）");
    expect(xWeighted(x)).toBeLessThanOrEqual(280);
  });

  it("月次サマリーが無くても本日行だけで成立する", () => {
    const perf = mkPerf([trade(1.0, "2026-07-06", null)]);
    perf.month = null;
    perf.cumulativeReturnPct = null;
    const x = renderXPost({ dayLabel: DAY_LABEL, regimeCompact: REGIME_COMPACT, perf });
    expect(x).toContain("本日 決済1件 損益+2.0%");
    expect(x).not.toContain("今月");
    expect(x).not.toContain("／ 今月");
  });
});
