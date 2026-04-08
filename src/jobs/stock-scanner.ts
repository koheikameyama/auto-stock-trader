/**
 * 銘柄スキャンジョブ
 *
 * テクニカル分析 → スコアリング → 結果保存。
 * market-scanner オーケストレーターからコンテキスト付きで呼ばれるほか、
 * 単独実行時は MarketAssessment DB から復元して動作する。
 */

import { prisma } from "../lib/prisma";
import { getTodayForDB, countNonTradingDaysAhead } from "../lib/market-date";
import {
  SCREENING,
  TECHNICAL_MIN_DATA,
  SCORING,
  SCORING_ACCURACY,
  UNIT_SHARES,
  TRADING_DEFAULTS,
  getSectorGroup,
  WEEKEND_RISK,
  MARKET_REGIME,
} from "../lib/constants";
import { SECTOR_MOMENTUM_SCORING } from "../lib/constants/scoring";
import {
  readHistoricalFromDB,
  fetchHistoricalDataBatch,
} from "../core/market-data";
import { analyzeTechnicals } from "../core/technical-analysis";
import type { TechnicalSummary } from "../core/technical-analysis";
import { getMaxBuyablePrice } from "../core/risk-manager";
// scoring は無効化済み（breakout 戦略に移行）
 
const scoreStock = (_params: unknown): { totalScore: number } => ({ totalScore: 0 });
 
const getScoreRank = (_score: number): "S" | "A" | "B" => "B";
import {
  getContrarianHistoryBatch,
  calculateContrarianBonus,
} from "../core/contrarian-analyzer";
import {
  notifyStockCandidates,
} from "../lib/slack";
import {
  determineMarketRegime,
  determinePreMarketRegime,
  calculateCmeDivergence,
  determineNikkeiTrend,
  applyNikkeiFilter,
} from "../core/market-regime";
import type { MarketRegime, Sentiment, TradingStrategy } from "../core/market-regime";
import { calculateDrawdownStatus } from "../core/drawdown-manager";
import { getEffectiveCapital } from "../core/position-manager";
import {
  calculateSectorMomentum,
} from "../core/sector-analyzer";
import type { MarketAssessmentContext } from "./market-assessment";

/** スコアリング済み候補 */
interface ScoredCandidate {
  tickerCode: string;
  name: string;
  summary: TechnicalSummary;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  score: any;
}

/** 単独実行時: MarketAssessment DB から stock-scanner 用コンテキストを復元 */
async function restoreContextFromDB(): Promise<MarketAssessmentContext> {
  const today = getTodayForDB();
  const record = await prisma.marketAssessment.findUnique({
    where: { date: today },
  });

  if (!record) {
    throw new Error("MarketAssessment が見つかりません。先に market-assessment を実行してください。");
  }

  // VIX からレジームを再構築
  const vix = record.vix ? Number(record.vix) : 20;
  let regime: MarketRegime = determineMarketRegime(vix);

  // CME乖離率を再計算してレジーム引き上げ
  let cmeDivergencePct: number | null = null;
  if (record.cmeFuturesPrice && record.usdjpy && record.nikkeiPrice && record.nikkeiChange) {
    const nikkeiPrice = Number(record.nikkeiPrice);
    const nikkeiChange = Number(record.nikkeiChange);
    const previousClose = nikkeiPrice / (1 + nikkeiChange / 100);
    cmeDivergencePct = calculateCmeDivergence(
      Number(record.cmeFuturesPrice),
      Number(record.usdjpy),
      previousClose,
    );

    const preMarket = determinePreMarketRegime(cmeDivergencePct);
    if (preMarket.minLevel && !regime.shouldHaltTrading) {
      const levelOrder: Record<string, number> = { normal: 0, elevated: 1, high: 2, crisis: 3 };
      if (levelOrder[preMarket.minLevel] > levelOrder[regime.level]) {
        if (preMarket.minLevel === "crisis") {
          regime = { ...regime, level: "crisis", maxPositions: MARKET_REGIME.CRISIS.maxPositions, minScore: MARKET_REGIME.CRISIS.minScore, shouldHaltTrading: false, reason: `${regime.reason} + ${preMarket.reason}` };
        } else if (preMarket.minLevel === "elevated" && regime.level === "normal") {
          regime = { ...regime, level: "elevated", maxPositions: 2, minScore: 60, reason: `${regime.reason} + ${preMarket.reason}` };
        }
      }
    }
  }

  // drawdown 再計算
  const drawdown = await calculateDrawdownStatus();

  return {
    regime,
    isShadowMode: !record.shouldTrade,
    marketData: null as unknown as MarketAssessmentContext["marketData"], // 単独実行時は不使用
    drawdown,
    strategyDecision: { strategy: (record.tradingStrategy ?? "breakout") as TradingStrategy, reason: "DB復元" },
    cmeDivergencePct,
    assessment: {
      shouldTrade: record.shouldTrade,
      sentiment: record.sentiment as Sentiment,
      reasoning: record.reasoning,
    },
  };
}

export async function main(context?: MarketAssessmentContext) {
  console.log("=== Stock Scanner 開始 ===");

  // コンテキストがなければDBから復元
  const ctx = context ?? await restoreContextFromDB();
  let { regime } = ctx;
  const { isShadowMode, strategyDecision } = ctx;

  // 日経225 SMA(25)フィルター適用（本番: より制限的な方を採用）
  try {
    const nikkeiDataMap = await fetchHistoricalDataBatch(["^N225"]);
    const nikkeiOhlcv = nikkeiDataMap.get("^N225");
    if (nikkeiOhlcv && nikkeiOhlcv.length > 0) {
      const nikkeiTrend = determineNikkeiTrend(nikkeiOhlcv);
      regime = applyNikkeiFilter(regime, nikkeiTrend);
      if (!nikkeiTrend.isUptrend) {
        console.log(`  日経SMAフィルター適用: ${nikkeiTrend.reason}`);
      }
    }
  } catch (err) {
    console.warn("  日経225データ取得失敗（フィルターなしで続行）:", err);
  }

  // shadow modeの場合、スコアリング失敗がhalt判定に影響しないようtry-catchで囲む
  try {
  console.log("[1/3] テクニカル分析 + スコアリング中...");

  // 利用可能資金から購入可能な上限株価を計算
  const config = await prisma.tradingConfig.findFirst({
    orderBy: { createdAt: "desc" },
  });
  const effectiveCap = config
    ? await getEffectiveCapital(config)
    : TRADING_DEFAULTS.TOTAL_BUDGET;

  const openPositions = await prisma.tradingPosition.findMany({
    where: { status: "open" },
    select: { stockId: true, entryPrice: true, quantity: true },
  });
  const investedAmount = openPositions.reduce(
    (sum, pos) => sum + Number(pos.entryPrice) * pos.quantity,
    0,
  );
  const openPositionStockIds = openPositions.map((p) => p.stockId);
  const cashBalance = effectiveCap - investedAmount;

  // 週末・連休リスクによる予算縮小を反映
  const nonTradingDays = countNonTradingDaysAhead();
  const isWeekendRisk = nonTradingDays >= WEEKEND_RISK.SIZE_REDUCTION_THRESHOLD;
  const effectiveCash = isWeekendRisk
    ? cashBalance * WEEKEND_RISK.POSITION_SIZE_MULTIPLIER
    : cashBalance;

  // 資金連動の上限株価と残高ベースの上限株価のうち小さい方を採用
  const capitalBasedMaxPrice = getMaxBuyablePrice(effectiveCap);
  const cashBasedMaxPrice = Math.floor(effectiveCash / UNIT_SHARES);
  const maxAffordablePrice = Math.min(capitalBasedMaxPrice, cashBasedMaxPrice);

  console.log(
    `  資金状況: 実質資金=${effectiveCap}円, 投資中=${investedAmount}円, 残高=${cashBalance}円${isWeekendRisk ? ` → 週末リスク適用(×${WEEKEND_RISK.POSITION_SIZE_MULTIPLIER}): ${effectiveCash}円` : ""} → 上限株価=${maxAffordablePrice}円`,
  );
  if (openPositionStockIds.length > 0) {
    console.log(`  既存ポジション除外: ${openPositionStockIds.length}銘柄`);
  }

  // スクリーニング条件に合う銘柄を取得（既存ポジション・廃止予定銘柄は除外）
  const candidates = await prisma.stock.findMany({
    where: {
      isDelisted: false,
      isActive: true,
      isRestricted: false,
      tradingHaltFlag: false,
      delistingDate: null,
      latestPrice: {
        not: null,
        gte: SCREENING.MIN_PRICE,
        lte: maxAffordablePrice,
      },
      latestVolume: { not: null, gte: SCREENING.MIN_DAILY_VOLUME },
      ...(openPositionStockIds.length > 0
        ? { id: { notIn: openPositionStockIds } }
        : {}),
    },
  });

  console.log(`  スクリーニング通過: ${candidates.length}銘柄`);

  // セクターモメンタムを事前計算
  const nikkeiWeekChange = ctx.marketData?.nikkei?.changePercent ?? 0;
  const sectorMomentum = await calculateSectorMomentum(nikkeiWeekChange);
  const sectorMomentumMap = new Map(
    sectorMomentum.map((s) => [s.sectorGroup, s]),
  );

  // テクニカル分析 + スコアリング（バッチ一括取得）
  const scoredCandidates: ScoredCandidate[] = [];

  const allTickerCodes = candidates.map((c) => c.tickerCode);

  // DBからOHLCV日足を読み取り（backfill-pricesで事前保存済み）
  const historicalMap = await readHistoricalFromDB(allTickerCodes);

  // DBにデータがない銘柄はyfinanceからフォールバック取得
  const missingTickers = allTickerCodes.filter(
    (t) => !historicalMap.has(t) || (historicalMap.get(t)?.length ?? 0) < TECHNICAL_MIN_DATA.SCANNER_MIN_BARS,
  );
  if (missingTickers.length > 0) {
    console.log(`  DB未保存${missingTickers.length}銘柄 → yfinanceフォールバック`);
    const fallbackMap = await fetchHistoricalDataBatch(missingTickers);
    for (const ticker of missingTickers) {
      const bars = fallbackMap.get(ticker);
      if (bars) historicalMap.set(ticker, bars);
    }
  }

  for (const stock of candidates) {
    try {
      const historical = historicalMap.get(stock.tickerCode);
      if (!historical || historical.length < TECHNICAL_MIN_DATA.SCANNER_MIN_BARS)
        continue;

      const summary = analyzeTechnicals(historical);

      const sectorGroup = getSectorGroup(stock.jpxSectorName);
      const sectorInfo = sectorGroup ? sectorMomentumMap.get(sectorGroup) : null;
      const sectorRelativeStrength =
        sectorInfo && sectorInfo.stockCount >= SECTOR_MOMENTUM_SCORING.MIN_SECTOR_STOCK_COUNT
          ? sectorInfo.relativeStrength
          : null;

      const score = scoreStock({
        historicalData: historical,
        latestPrice: Number(stock.latestPrice),
        latestVolume: Number(stock.latestVolume),
        weeklyVolatility: stock.volatility ? Number(stock.volatility) : null,
        nextEarningsDate: stock.nextEarningsDate,
        exDividendDate: stock.exDividendDate,
        avgVolume25: summary.volumeAnalysis.avgVolume20,
        summary,
        sectorRelativeStrength,
      });

      scoredCandidates.push({
        tickerCode: stock.tickerCode,
        name: stock.name,
        summary,
        score,
      });
    } catch (error) {
      console.error(`  テクニカル分析エラー: ${stock.tickerCode}`, error);
    }
  }

  console.log(`  テクニカル分析完了: ${scoredCandidates.length}銘柄`);

  // 逆行ボーナス適用
  console.log("[1.5/3] 逆行ボーナス適用中...");
  const scoredTickerCodes = scoredCandidates.map((c) => c.tickerCode);
  const contrarianHistoryMap = await getContrarianHistoryBatch(scoredTickerCodes);

  const contrarianBonusMap = new Map<string, { bonus: number; wins: number }>();
  for (const [ticker, history] of contrarianHistoryMap) {
    const bonus = calculateContrarianBonus(
      history.wins,
      history.totalNoTradeDays,
    );
    if (bonus > 0) {
      contrarianBonusMap.set(ticker, { bonus, wins: history.wins });
    }
  }

  for (const c of scoredCandidates) {
    const cb = contrarianBonusMap.get(c.tickerCode);
    if (cb && !c.score.isDisqualified) {
      c.score.totalScore = Math.min(100, c.score.totalScore + cb.bonus);
    }
  }

  if (contrarianBonusMap.size > 0) {
    console.log(`  逆行ボーナス適用: ${contrarianBonusMap.size}銘柄`);
    for (const [ticker, { bonus, wins }] of contrarianBonusMap) {
      console.log(`    ${ticker}: +${bonus}点 (${wins}勝/90日)`);
    }
  } else {
    console.log("  逆行ボーナス対象なし");
  }

  // スコア降順ソート
  scoredCandidates.sort((a, b) => b.score.totalScore - a.score.totalScore);

  // 即死ルールで棄却された銘柄を分離
  const disqualified = scoredCandidates.filter((c) => c.score.isDisqualified);
  const qualified = scoredCandidates.filter((c) => !c.score.isDisqualified);

  // スコア上位から候補を選出
  let filtered = qualified.slice(0, SCORING.MAX_CANDIDATES_FOR_AI);

  // レジームによるスコア制限
  if (regime.minScore != null) {
    const beforeCount = filtered.length;
    filtered = filtered.filter((c) => c.score.totalScore >= regime.minScore!);
    if (filtered.length < beforeCount) {
      console.log(
        `  レジーム制限: スコア${regime.minScore}点以上に絞り込み（${beforeCount} → ${filtered.length}銘柄）`,
      );
    }
  }

  // 精度追跡
  const filteredTickerSet = new Set(filtered.map((c) => c.tickerCode));
  const accuracyTrackingCandidates = qualified.filter(
    (c) =>
      c.score.totalScore >= SCORING_ACCURACY.MIN_SCORE_FOR_TRACKING &&
      !filteredTickerSet.has(c.tickerCode),
  );

  console.log(
    `  スコアリング完了: ${scoredCandidates.length}銘柄 → ${filtered.length}銘柄に絞り込み（即死棄却: ${disqualified.length}銘柄）`,
  );

  // スコア分布ログ
  const scoreDist = { S: 0, A: 0, B: 0 };
  for (const c of qualified) {
    scoreDist[getScoreRank(c.score.totalScore)]++;
  }
  console.log(
    `  スコア分布: S=${scoreDist.S} A=${scoreDist.A} B=${scoreDist.B}`,
  );

  const today = getTodayForDB();

  const findEntryPrice = (tickerCode: string) => {
    const stock = candidates.find((s) => s.tickerCode === tickerCode);
    return stock?.latestPrice ? Number(stock.latestPrice) : null;
  };

  // スコアリングレコードの共通フィールド生成
  const buildScoringFields = (c: ScoredCandidate) => ({
    date: today,
    tickerCode: c.tickerCode,
    totalScore: c.score.totalScore,
    trendQualityScore: c.score.trendQuality.total,
    entryTimingScore: c.score.entryTiming.total,
    riskQualityScore: c.score.riskQuality.total,
    sectorMomentumScore: c.score.sectorMomentumScore,
    trendQualityBreakdown: {
      maAlignment: c.score.trendQuality.maAlignment,
      weeklyTrend: c.score.trendQuality.weeklyTrend,
      trendContinuity: c.score.trendQuality.trendContinuity,
    },
    entryTimingBreakdown: {
      pullbackDepth: c.score.entryTiming.pullbackDepth,
      priorBreakout: c.score.entryTiming.priorBreakout,
      candlestickSignal: c.score.entryTiming.candlestickSignal,
    },
    riskQualityBreakdown: {
      atrStability: c.score.riskQuality.atrStability,
      rangeContraction: c.score.riskQuality.rangeContraction,
      volumeStability: c.score.riskQuality.volumeStability,
    },
    isDisqualified: false,
    contrarianBonus: contrarianBonusMap.get(c.tickerCode)?.bonus ?? 0,
    contrarianWins: contrarianBonusMap.get(c.tickerCode)?.wins ?? 0,
    entryPrice: findEntryPrice(c.tickerCode),
  });

  if (isShadowMode) {
    // === シャドウモード ===
    console.log("[2/3] スキップ（シャドウモード）");
    console.log("[3/3] シャドウスコアリング結果保存中...");

    const shadowCandidates = [
      ...filtered,
      ...accuracyTrackingCandidates,
    ];

    const shadowRecords = shadowCandidates.map((c) => ({
      ...buildScoringFields(c),
      aiDecision: null,
      aiReasoning: null,
      rejectionReason: "market_halted",
    }));

    if (shadowRecords.length > 0) {
      await prisma.scoringRecord.deleteMany({ where: { date: today } });
      await prisma.scoringRecord.createMany({
        data: shadowRecords,
      });
      console.log(`  シャドウScoringRecord 保存: ${shadowRecords.length}件`);
    } else {
      console.log("  シャドウ対象銘柄なし");
    }
  } else {
    // === 通常モード ===
    if (!filtered.length) {
      console.log("[2/3] スキップ（候補0銘柄）");
      console.log("[3/3] 結果保存中...");

      const scoringRecords = accuracyTrackingCandidates.map((c) => ({
        ...buildScoringFields(c),
        aiDecision: null,
        aiReasoning: null,
        rejectionReason: "below_threshold",
      }));

      if (scoringRecords.length > 0) {
        await prisma.scoringRecord.deleteMany({ where: { date: today } });
        await prisma.scoringRecord.createMany({ data: scoringRecords });
        console.log(`  ScoringRecord 保存: ${scoringRecords.length}件`);
      }

      return;
    }

    console.log("[2/3] テクニカル条件通過銘柄を自動承認...");

    // 全候補を自動承認（AI審査なし）
    const goStocks = filtered.map((c) => ({
      tickerCode: c.tickerCode,
      strategy: strategyDecision.strategy,
      reasoning: `テクニカルスコア${c.score.totalScore}点 自動承認`,
      riskFlags: [] as string[],
      technicalScore: c.score.totalScore,
    }));
    console.log(`  → ${filtered.length}銘柄承認`);

    // MarketAssessment + ScoringRecord に結果を保存
    console.log("[3/3] 結果保存中...");
    await prisma.marketAssessment.update({
      where: { date: today },
      data: {
        selectedStocks: JSON.parse(JSON.stringify(goStocks)),
      },
    });

    // ScoringRecord 保存
    const scoringRecords = [
      ...filtered.map((c) => ({
        ...buildScoringFields(c),
        aiDecision: null,
        aiReasoning: null,
        rejectionReason: null,
        newsContext: null,
      })),
      ...accuracyTrackingCandidates.map((c) => ({
        ...buildScoringFields(c),
        aiDecision: null,
        aiReasoning: null,
        rejectionReason: "below_threshold",
      })),
    ];

    if (scoringRecords.length > 0) {
      await prisma.scoringRecord.deleteMany({ where: { date: today } });
      await prisma.scoringRecord.createMany({
        data: scoringRecords,
      });
      console.log(`  ScoringRecord 保存: ${scoringRecords.length}件`);
    }

    // Slack通知
    if (goStocks.length > 0) {
      await notifyStockCandidates(
        goStocks.map((g) => {
          return {
            tickerCode: g.tickerCode,
            name: candidates.find((c) => c.tickerCode === g.tickerCode)?.name,
            strategy: g.strategy,
            score: g.technicalScore,
            reasoning: g.reasoning,
          };
        }),
      );
    }
  }

  } catch (error) {
    if (isShadowMode) {
      console.error("シャドウスコアリングエラー（無視）:", error);
    } else {
      throw error;
    }
  }

  console.log("=== Stock Scanner 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("stock-scanner");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Stock Scanner エラー:", error);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
