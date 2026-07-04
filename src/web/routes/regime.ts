/**
 * 相場局面（レジーム）API
 *
 * regime-shift-detector の出力を JSON で公開する。相場局面ダッシュボード
 * (KOH-499 / KOH-515) の Web・配信 共通のデータソース。
 *
 * - GET /api/regime      : 公開・無料サブセット（レベル + 一言のみ）。
 *                          案B「無料は物足りなさを残す」に従い、指標値・内訳は返さない。
 * - GET /api/regime/full : 指標値・5シグナル内訳・D期への距離。将来の有料エンタイトルメントで
 *                          gate する。現状は app.ts の Basic 認証内側に置き、無料側に詳細を漏らさない。
 *
 * 局面データは引け後に日次更新のため、短時間の in-memory キャッシュで DB 負荷を抑える。
 */

import { Hono } from "hono";
import {
  detectRegimeShift,
  getLevelEmoji,
  getLevelLabel,
  getLevelSummary,
  SIGNAL_LABELS,
  type BullMarketResult,
  type BullMarketSignals,
} from "../../core/regime-shift-detector";
import { getTodayForDB } from "../../lib/market-date";

const app = new Hono();

/** 局面は引け後に日次更新のため、5分キャッシュで DB 負荷を抑える */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** 全シグナル数（D期までの距離計算・分母表示に使用） */
const SIGNAL_TOTAL = Object.keys(SIGNAL_LABELS).length;

let cache: { at: number; result: BullMarketResult } | null = null;

async function getRegime(): Promise<BullMarketResult> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.result;
  const result = await detectRegimeShift({ asOfDate: getTodayForDB() });
  cache = { at: now, result };
  return result;
}

/** Date → JST基準の YYYY-MM-DD（asOfDate は UTC 00:00 = JST日付として保存されている） */
function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * GET /api/regime — 公開・無料サブセット
 * レベル・ラベル・絵文字・一言サマリー・基準日のみ。指標値や内訳は返さない。
 */
app.get("/", async (c) => {
  try {
    const r = await getRegime();
    return c.json({
      asOfDate: toDateStr(r.asOfDate),
      level: r.level,
      levelLabel: getLevelLabel(r.level),
      emoji: getLevelEmoji(r.level),
      summary: getLevelSummary(r.level),
    });
  } catch (e) {
    console.error("[api/regime] detection failed:", e);
    return c.json({ error: "regime_unavailable" }, 503);
  }
});

/**
 * GET /api/regime/full — 有料相当（指標値・5シグナル内訳・D期への距離）
 * 現状は Basic 認証の内側。Phase 1 で LINE Login + Stripe のエンタイトルメントに置き換える。
 */
app.get("/full", async (c) => {
  try {
    const r = await getRegime();
    const missing = (Object.keys(r.signals) as (keyof BullMarketSignals)[])
      .filter((k) => !r.signals[k])
      .map((k) => SIGNAL_LABELS[k]);

    return c.json({
      asOfDate: toDateStr(r.asOfDate),
      level: r.level,
      levelLabel: getLevelLabel(r.level),
      emoji: getLevelEmoji(r.level),
      summary: getLevelSummary(r.level),
      signalCount: r.signalCount,
      signalTotal: SIGNAL_TOTAL,
      indicators: {
        breadth: r.current.breadth,
        breadthChange30d: r.current.breadthChange30d,
        nikkei: r.current.nikkei,
        nikkeiSma50: r.current.nikkeiSma50,
        nikkeiSma50Slope10d: r.current.nikkeiSma50Slope10d,
        vix: Number.isFinite(r.current.vix) ? r.current.vix : null,
      },
      signals: r.signals,
      distanceToStrong: {
        needed: SIGNAL_TOTAL - r.signalCount,
        missing,
      },
    });
  } catch (e) {
    console.error("[api/regime/full] detection failed:", e);
    return c.json({ error: "regime_unavailable" }, 503);
  }
});

export default app;
