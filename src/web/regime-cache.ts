/**
 * 相場局面（レジーム）の取得を短時間キャッシュする共有ヘルパー。
 * 局面は引け後に日次更新のため、API・公開ページの両方から同じキャッシュを使う。
 */

import {
  detectRegimeShift,
  type BullMarketResult,
} from "../core/regime-shift-detector";
import { getTodayForDB } from "../lib/market-date";

/** 局面は引け後に日次更新のため、5分キャッシュで DB 負荷を抑える */
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { at: number; result: BullMarketResult } | null = null;

export async function getRegimeCached(): Promise<BullMarketResult> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.result;
  const result = await detectRegimeShift({ asOfDate: getTodayForDB() });
  cache = { at: now, result };
  return result;
}
