/**
 * セクター分析モジュール
 *
 * セクター集中リスク管理とセクターモメンタム（相対パフォーマンス）を提供する。
 */

import { prisma } from "../lib/prisma";
import { getSectorGroup, getMacroFactor, SECTOR_RISK } from "../lib/constants";

/** 事前取得データ（重複クエリ削減用） */
export interface SectorCheckPrefetch {
  openPositions?: Array<{ stockId: string; stock: { id: string; jpxSectorName: string | null } }>;
}

// ========================================
// セクター集中チェック
// ========================================

export interface SectorConcentration {
  sectorGroup: string;
  positionCount: number;
  stockIds: string[];
}

/**
 * 現在のオープンポジションのセクター集中度を計算する
 */
export async function getSectorConcentration(
  prefetch?: SectorCheckPrefetch,
): Promise<
  SectorConcentration[]
> {
  const openPositions = prefetch?.openPositions ?? await prisma.tradingPosition.findMany({
    where: { status: "open" },
    include: { stock: { select: { id: true, jpxSectorName: true } } },
  });

  const sectorMap = new Map<
    string,
    { count: number; stockIds: string[] }
  >();

  for (const pos of openPositions) {
    const group = getSectorGroup(pos.stock.jpxSectorName);
    if (!group) continue;

    const entry = sectorMap.get(group) ?? { count: 0, stockIds: [] };
    entry.count++;
    entry.stockIds.push(pos.stockId);
    sectorMap.set(group, entry);
  }

  return Array.from(sectorMap.entries()).map(([sectorGroup, data]) => ({
    sectorGroup,
    positionCount: data.count,
    stockIds: data.stockIds,
  }));
}

/**
 * 新規ポジションのセクター集中チェック
 *
 * 同一セクターグループに既にMAX_SAME_SECTOR_POSITIONS以上のポジションがある場合は不許可。
 */
export async function canAddToSector(
  stockId: string,
  prefetch?: SectorCheckPrefetch,
): Promise<{ allowed: boolean; reason: string }> {
  const stock = await prisma.stock.findUnique({
    where: { id: stockId },
    select: { jpxSectorName: true, tickerCode: true },
  });

  if (!stock) {
    return { allowed: false, reason: "銘柄が見つかりません" };
  }

  const sectorGroup = getSectorGroup(stock.jpxSectorName);
  if (!sectorGroup) {
    // セクター不明の場合は許可（集中チェック不能）
    return { allowed: true, reason: "OK" };
  }

  const concentration = await getSectorConcentration(prefetch);
  const existing = concentration.find((c) => c.sectorGroup === sectorGroup);

  if (
    existing &&
    existing.positionCount >= SECTOR_RISK.MAX_SAME_SECTOR_POSITIONS
  ) {
    return {
      allowed: false,
      reason: `セクター集中制限: ${sectorGroup}に既に${existing.positionCount}ポジション保有中（上限: ${SECTOR_RISK.MAX_SAME_SECTOR_POSITIONS}）`,
    };
  }

  return { allowed: true, reason: "OK" };
}

// ========================================
// マクロファクター集中チェック
// ========================================

export interface MacroConcentration {
  macroFactor: string;
  positionCount: number;
  stockIds: string[];
}

/**
 * 現在のオープンポジションのマクロファクター集中度を計算する
 */
export async function getMacroConcentration(
  prefetch?: SectorCheckPrefetch,
): Promise<MacroConcentration[]> {
  const openPositions = prefetch?.openPositions ?? await prisma.tradingPosition.findMany({
    where: { status: "open" },
    include: { stock: { select: { id: true, jpxSectorName: true } } },
  });

  const macroMap = new Map<string, { count: number; stockIds: string[] }>();

  for (const pos of openPositions) {
    const sectorGroup = getSectorGroup(pos.stock.jpxSectorName);
    const factor = getMacroFactor(sectorGroup);
    if (!factor) continue;

    const entry = macroMap.get(factor) ?? { count: 0, stockIds: [] };
    entry.count++;
    entry.stockIds.push(pos.stockId);
    macroMap.set(factor, entry);
  }

  return Array.from(macroMap.entries()).map(([macroFactor, data]) => ({
    macroFactor,
    positionCount: data.count,
    stockIds: data.stockIds,
  }));
}

/**
 * 新規ポジションのマクロファクター集中チェック
 *
 * 同一マクロファクターに既にMAX_SAME_MACRO_POSITIONS以上のポジションがある場合は不許可。
 */
export async function canAddToMacroFactor(
  stockId: string,
  prefetch?: SectorCheckPrefetch,
): Promise<{ allowed: boolean; reason: string }> {
  const stock = await prisma.stock.findUnique({
    where: { id: stockId },
    select: { jpxSectorName: true, tickerCode: true },
  });

  if (!stock) {
    return { allowed: false, reason: "銘柄が見つかりません" };
  }

  const sectorGroup = getSectorGroup(stock.jpxSectorName);
  const macroFactor = getMacroFactor(sectorGroup);

  if (!macroFactor) {
    // マクロファクター不明の場合は許可（集中チェック不能）
    return { allowed: true, reason: "OK" };
  }

  const concentration = await getMacroConcentration(prefetch);
  const existing = concentration.find((c) => c.macroFactor === macroFactor);

  if (
    existing &&
    existing.positionCount >= SECTOR_RISK.MAX_SAME_MACRO_POSITIONS
  ) {
    return {
      allowed: false,
      reason: `マクロファクター集中制限: ${macroFactor}に既に${existing.positionCount}ポジション保有中（上限: ${SECTOR_RISK.MAX_SAME_MACRO_POSITIONS}）`,
    };
  }

  return { allowed: true, reason: "OK" };
}

// ========================================
// セクターモメンタム（相対パフォーマンス）
// ========================================

export interface SectorMomentum {
  sectorGroup: string;
  avgWeekChange: number;
  relativeStrength: number; // vs 日経225（正=強、負=弱）
  stockCount: number;
  isStrong: boolean;
  isWeak: boolean;
}

/**
 * StockテーブルのweekChangeRateをセクターグループ別に平均し、
 * 日経225との相対パフォーマンスを算出する。
 *
 * isWeak = relativeStrength < WEAK_SECTOR_THRESHOLD（日経比2%以上アンダーパフォーム）
 */
export async function calculateSectorMomentum(
  nikkeiWeekChange: number,
): Promise<SectorMomentum[]> {
  const stocks = await prisma.stock.findMany({
    where: {
      isDelisted: false,
      isActive: true,
      jpxSectorName: { not: null },
      weekChangeRate: { not: null },
    },
    select: {
      jpxSectorName: true,
      weekChangeRate: true,
    },
  });

  // セクターグループ別に集計
  const sectorData = new Map<string, number[]>();

  for (const stock of stocks) {
    const group = getSectorGroup(stock.jpxSectorName);
    if (!group) continue;

    const changes = sectorData.get(group) ?? [];
    changes.push(Number(stock.weekChangeRate));
    sectorData.set(group, changes);
  }

  return Array.from(sectorData.entries()).map(([sectorGroup, changes]) => {
    const avgWeekChange =
      changes.reduce((sum, c) => sum + c, 0) / changes.length;
    const relativeStrength = avgWeekChange - nikkeiWeekChange;

    return {
      sectorGroup,
      avgWeekChange,
      relativeStrength,
      stockCount: changes.length,
      isStrong: relativeStrength > Math.abs(SECTOR_RISK.WEAK_SECTOR_THRESHOLD),
      isWeak: relativeStrength < SECTOR_RISK.WEAK_SECTOR_THRESHOLD,
    };
  });
}
