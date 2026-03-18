/**
 * 市場スキャナー（8:30 JST / 平日）
 *
 * 「ロジックが主役、AIが最終審判」フロー:
 * 1. 市場指標データ取得
 * 2. AI市場評価 → shouldTrade判定
 * 3. shouldTrade = false → Slack通知して終了
 * 4. shouldTrade = true → 銘柄選定
 *    a. 対象銘柄のヒストリカルデータ取得
 *    b. テクニカル分析
 *    c. 4カテゴリスコアリング（0-100）→ 上位10-20銘柄に絞り込み
 *    d. AIレビュー（Go/No-Go）
 *    e. MarketAssessment に結果を保存
 *    f. Slackに候補銘柄通知
 */

import { prisma } from "../lib/prisma";
import { getTodayForDB } from "../lib/date-utils";
import {
  SCREENING,
  YAHOO_FINANCE,
  JOB_CONCURRENCY,
  TECHNICAL_MIN_DATA,
  SCORING,
  SCORING_ACCURACY,
  UNIT_SHARES,
  TRADING_DEFAULTS,
  MARKET_INDEX,
  SECTOR_RISK,
  STRATEGY_SWITCHING,
  getSectorGroup,
} from "../lib/constants";
import { SECTOR_MOMENTUM_SCORING } from "../lib/constants/scoring";
import {
  fetchMarketData,
  fetchHistoricalData,
} from "../core/market-data";
import { analyzeTechnicals } from "../core/technical-analysis";
import type { TechnicalSummary } from "../core/technical-analysis";
import { scoreStock, getRank, formatScoreForAI } from "../core/scoring";
import type { NewLogicScore } from "../core/scoring";
import {
  getContrarianHistoryBatch,
  calculateContrarianBonus,
} from "../core/contrarian-analyzer";
import { assessMarket, reviewStocks } from "../core/ai-decision";
import type { MarketDataInput, StockReviewCandidateInput } from "../core/ai-decision";
import {
  notifyMarketAssessment,
  notifyStockCandidates,
  notifyRiskAlert,
} from "../lib/slack";
import pLimit from "p-limit";
import {
  determineMarketRegime,
  determinePreMarketRegime,
  calculateCmeDivergence,
  determineTradingStrategy,
} from "../core/market-regime";
import type { MarketRegime, StrategyDecision } from "../core/market-regime";
import { calculateDrawdownStatus } from "../core/drawdown-manager";
import type { DrawdownStatus } from "../core/drawdown-manager";
import { getEffectiveCapital } from "../core/position-manager";
import {
  calculateSectorMomentum,
  getNewsSectorSentiment,
} from "../core/sector-analyzer";
import type {
  SectorMomentum,
  NewsSectorSentiment,
} from "../core/sector-analyzer";
import { main as runHoldingScore } from "./holding-score";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** スコアリング済み候補 */
interface ScoredCandidate {
  tickerCode: string;
  name: string;
  summary: TechnicalSummary;
  score: NewLogicScore;
  newsContext?: string;
}

/** MarketAssessment保存用の市場指標フィールドを構築する */
function buildMarketFields(marketData: Awaited<ReturnType<typeof fetchMarketData>>) {
  return {
    nikkeiPrice: marketData.nikkei!.price,
    nikkeiChange: marketData.nikkei!.changePercent,
    sp500Change: marketData.sp500?.changePercent,
    nasdaqChange: marketData.nasdaq?.changePercent,
    dowChange: marketData.dow?.changePercent,
    soxChange: marketData.sox?.changePercent,
    vix: marketData.vix?.price,
    nikkeiVi: null as null,
    usdjpy: marketData.usdjpy?.price,
    cmeFuturesPrice: marketData.cmeFutures?.price,
  };
}

export async function main() {
  console.log("=== Market Scanner 開始 ===");
  let isShadowMode = false;

  // 1. 市場指標データ取得
  console.log("[1/5] 市場指標データ取得中...");
  const marketData = await fetchMarketData();

  if (!marketData.nikkei) {
    console.error("市場データの取得に失敗しました");
    await notifyRiskAlert({
      type: "データ取得エラー",
      message: "日経平均データの取得に失敗しました。手動確認してください。",
    });
    throw new Error("市場データの取得に失敗しました（nikkei が null）");
  }

  if (!marketData.vix) {
    console.error("VIXの取得に失敗しました");
    await notifyRiskAlert({
      type: "データ取得エラー",
      message: "VIXが取得できませんでした。手動確認してください。",
    });
    throw new Error("市場データの取得に失敗しました（vix が null）");
  }

  // 米国市場オーバーナイトデータログ
  const usLog = [
    marketData.nasdaq ? `NASDAQ ${marketData.nasdaq.changePercent >= 0 ? "+" : ""}${marketData.nasdaq.changePercent.toFixed(2)}%` : null,
    marketData.dow ? `ダウ ${marketData.dow.changePercent >= 0 ? "+" : ""}${marketData.dow.changePercent.toFixed(2)}%` : null,
    marketData.sox ? `SOX ${marketData.sox.changePercent >= 0 ? "+" : ""}${marketData.sox.changePercent.toFixed(2)}%` : null,
  ].filter(Boolean);
  if (usLog.length > 0) {
    console.log(`  米国市場（前日）: ${usLog.join(", ")}`);
  }

  // 1.5. ニュース分析データ取得
  console.log("[1.5/5] ニュース分析データ取得中...");
  const newsAnalysis = await prisma.newsAnalysis.findUnique({
    where: { date: getTodayForDB() },
  });

  let newsSummary: string | undefined;
  if (newsAnalysis) {
    const sectorText = (
      newsAnalysis.sectorImpacts as Array<{
        sector: string;
        impact: string;
        summary: string;
      }>
    )
      .map((s) => `  - ${s.sector}: ${s.impact} — ${s.summary}`)
      .join("\n");

    newsSummary = `【ニュース分析】
- 地政学リスクレベル: ${newsAnalysis.geopoliticalRiskLevel}/5
- ${newsAnalysis.geopoliticalSummary}
- 市場インパクト: ${newsAnalysis.marketImpact}
- ${newsAnalysis.marketImpactSummary}
- 主要イベント: ${newsAnalysis.keyEvents}
【セクター別影響】
${sectorText || "  特になし"}`;

    console.log(
      `  ニュース分析あり（地政学リスク: ${newsAnalysis.geopoliticalRiskLevel}/5, 市場: ${newsAnalysis.marketImpact}）`,
    );
  } else {
    console.log("  ニュース分析なし（news-collector未実行）");
  }

  // 1.7. CME先物ナイトセッション乖離率チェック（機械的 — レジーム判定の前に実行）
  let cmeDivergencePct: number | null = null;
  if (marketData.cmeFutures && marketData.usdjpy && marketData.nikkei.previousClose > 0) {
    cmeDivergencePct = calculateCmeDivergence(
      marketData.cmeFutures.price,
      marketData.usdjpy.price,
      marketData.nikkei.previousClose,
    );
    console.log(`[1.7/5] CME先物乖離率: ${cmeDivergencePct.toFixed(2)}%`);

    const preMarket = determinePreMarketRegime(cmeDivergencePct);
    if (preMarket.minLevel === "crisis") {
      console.log(`  → ${preMarket.reason}`);
      await notifyRiskAlert({
        type: "CME先物乖離率キルスイッチ",
        message: preMarket.reason!,
      });
      const assessmentData = {
        ...buildMarketFields(marketData),
        sentiment: "crisis" as const,
        shouldTrade: false,
        reasoning: `[CME先物乖離率キルスイッチ] ${preMarket.reason}`,
        selectedStocks: [],
        tradingStrategy: "day_trade",
      };
      await prisma.marketAssessment.upsert({
        where: { date: getTodayForDB() },
        update: assessmentData,
        create: { date: getTodayForDB(), ...assessmentData },
      });
      isShadowMode = true;
    } else if (preMarket.minLevel) {
      console.log(`  → ${preMarket.reason}（レジーム下限を${preMarket.minLevel}に引き上げ）`);
    }
  } else {
    console.log("[1.7/5] CME先物乖離率: データ不足のためスキップ");
  }

  // 1.8. VIXレジーム判定（機械的 — AI判断の前に実行）
  console.log("[1.8/5] VIXレジーム判定...");
  let regime: MarketRegime = determineMarketRegime(marketData.vix.price);

  // CME乖離率によるレジーム引き上げ
  if (cmeDivergencePct != null) {
    const preMarket = determinePreMarketRegime(cmeDivergencePct);
    if (preMarket.minLevel && !regime.shouldHaltTrading) {
      const levelOrder: Record<string, number> = { normal: 0, elevated: 1, high: 2, crisis: 3 };
      if (levelOrder[preMarket.minLevel] > levelOrder[regime.level]) {
        console.log(`  → CME乖離率によりレジームを ${regime.level} → ${preMarket.minLevel} に引き上げ`);
        if (preMarket.minLevel === "crisis") {
          regime = { ...regime, level: "crisis", maxPositions: 0, minRank: null, shouldHaltTrading: true, reason: `${regime.reason} + ${preMarket.reason}` };
        } else if (preMarket.minLevel === "elevated" && regime.level === "normal") {
          regime = { ...regime, level: "elevated", maxPositions: 2, minRank: "A", reason: `${regime.reason} + ${preMarket.reason}` };
        }
      }
    }
  }

  console.log(`  → レジーム: ${regime.level}（${regime.reason}）`);

  // 1.8.1. 戦略決定（市場環境ベース — 全銘柄共通）
  const strategyDecision: StrategyDecision = determineTradingStrategy(
    marketData.vix.price,
    cmeDivergencePct,
  );
  console.log(`[1.8.1/5] 戦略決定: ${strategyDecision.strategy}（${strategyDecision.reason}）`);

  // VIX ≥ 30: 既存スイングポジションの戦略をday_tradeに切替
  if (marketData.vix.price >= STRATEGY_SWITCHING.VIX_SWING_FORCE_CLOSE_THRESHOLD) {
    const updated = await prisma.tradingPosition.updateMany({
      where: { status: "open", strategy: "swing" },
      data: { strategy: "day_trade" },
    });
    if (updated.count > 0) {
      console.log(`  → VIX ${marketData.vix.price.toFixed(1)} ≥ ${STRATEGY_SWITCHING.VIX_SWING_FORCE_CLOSE_THRESHOLD}: ${updated.count}件のスイングポジションをday_tradeに切替`);
    }
  }

  if (regime.shouldHaltTrading && !isShadowMode) {
    console.log("レジームにより取引停止。MarketAssessment を保存してシャドウスコアリングへ");
    await notifyRiskAlert({
      type: "VIXレジーム停止",
      message: regime.reason,
    });
    const assessmentData = {
      ...buildMarketFields(marketData),
      sentiment: "crisis" as const,
      shouldTrade: false,
      reasoning: `[VIXレジーム自動停止] ${regime.reason}`,
      selectedStocks: [],
      tradingStrategy: strategyDecision.strategy,
    };
    await prisma.marketAssessment.upsert({
      where: { date: getTodayForDB() },
      update: assessmentData,
      create: { date: getTodayForDB(), ...assessmentData },
    });
    isShadowMode = true;
  }

  // 1.8.5. 日経平均キルスイッチ（機械的 — VIXレジームとは独立）
  if (
    !isShadowMode &&
    marketData.nikkei.changePercent <= MARKET_INDEX.NIKKEI_CRISIS_THRESHOLD
  ) {
    const reason = `日経平均 ${marketData.nikkei.changePercent.toFixed(2)}% ≤ ${MARKET_INDEX.NIKKEI_CRISIS_THRESHOLD}%: 急落キルスイッチ発動。全取引停止`;
    console.log(`[1.8.5/5] ${reason}`);
    await notifyRiskAlert({
      type: "日経平均キルスイッチ",
      message: reason,
    });
    const assessmentData = {
      ...buildMarketFields(marketData),
      sentiment: "crisis" as const,
      shouldTrade: false,
      reasoning: `[日経平均キルスイッチ] ${reason}`,
      selectedStocks: [],
      tradingStrategy: strategyDecision.strategy,
    };
    await prisma.marketAssessment.upsert({
      where: { date: getTodayForDB() },
      update: assessmentData,
      create: { date: getTodayForDB(), ...assessmentData },
    });
    isShadowMode = true;
  }

  // 1.9. ドローダウンチェック（機械的 — AI判断の前に実行）
  console.log("[1.9/5] ドローダウンチェック...");
  const drawdown = await calculateDrawdownStatus();
  console.log(
    `  → 週次損益: ¥${drawdown.weeklyPnl.toLocaleString()}, 月次損益: ¥${drawdown.monthlyPnl.toLocaleString()}, 連敗: ${drawdown.consecutiveLosses}`,
  );

  if (drawdown.shouldHaltTrading) {
    console.log(`ドローダウンにより取引停止: ${drawdown.reason}`);
    await notifyRiskAlert({
      type: "ドローダウン停止",
      message: drawdown.reason,
    });
    // ドローダウンは自分の成績の問題であり市場環境とは無関係
    // sentimentはAI市場評価を維持し、shouldTrade: falseのみで新規注文を停止する
    const latestAssessment = await prisma.marketAssessment.findFirst({
      orderBy: { createdAt: "desc" },
      select: { sentiment: true },
    });
    const drawdownSentiment = (latestAssessment?.sentiment ?? "neutral") as
      | "bullish"
      | "neutral"
      | "cautious"
      | "bearish"
      | "crisis";
    console.log(
      `  → ドローダウン停止時のsentiment: ${drawdownSentiment}（AI市場評価を維持）`,
    );
    const drawdownAssessmentData = {
      ...buildMarketFields(marketData),
      sentiment: drawdownSentiment,
      shouldTrade: false,
      reasoning: `[ドローダウン自動停止] ${drawdown.reason}（sentiment=${drawdownSentiment}はAI市場評価を維持）`,
      selectedStocks: [],
      tradingStrategy: strategyDecision.strategy,
    };
    await prisma.marketAssessment.upsert({
      where: { date: getTodayForDB() },
      update: drawdownAssessmentData,
      create: { date: getTodayForDB(), ...drawdownAssessmentData },
    });
    isShadowMode = true;
  }

  // 1.95. 保有継続スコアリング（レジーム判定後に実行 → レジーム対応TS引き締め）
  try {
    await runHoldingScore(regime);
  } catch (error) {
    console.error("保有スコアリングエラー（スキャン続行）:", error);
  }

  // 2. AI市場評価（VIX/ドローダウンでshadow modeの場合はスキップ）
  let assessment: Awaited<ReturnType<typeof assessMarket>> | null = null;

  if (!isShadowMode) {
    console.log("[2/5] AI市場評価中...");
    const marketInput: MarketDataInput = {
      nikkeiPrice: marketData.nikkei.price,
      nikkeiChange: marketData.nikkei.changePercent,
      sp500Change: marketData.sp500?.changePercent ?? 0,
      nasdaqChange: marketData.nasdaq?.changePercent ?? 0,
      dowChange: marketData.dow?.changePercent ?? 0,
      soxChange: marketData.sox?.changePercent ?? 0,
      vix: marketData.vix.price,
      usdJpy: marketData.usdjpy?.price ?? 0,
      cmeFuturesPrice: marketData.cmeFutures?.price ?? 0,
      cmeFuturesChange: marketData.cmeFutures?.changePercent ?? 0,
      newsSummary,
    };

    assessment = await assessMarket(marketInput);
    console.log(
      `  → shouldTrade: ${assessment.shouldTrade}, sentiment: ${assessment.sentiment}`,
    );

    // Slack通知
    await notifyMarketAssessment({
      shouldTrade: assessment.shouldTrade,
      sentiment: assessment.sentiment,
      reasoning: assessment.reasoning,
      nikkeiChange: marketData.nikkei.changePercent,
      vix: marketData.vix.price,
    });

    // 3. shouldTrade = false → 保存してシャドウスコアリングへ
    if (!assessment.shouldTrade) {
      console.log("取引見送り。MarketAssessment を保存してシャドウスコアリングへ");
      const noTradeData = {
        ...buildMarketFields(marketData),
        sentiment: assessment.sentiment,
        shouldTrade: false,
        reasoning: assessment.reasoning,
        selectedStocks: [],
        tradingStrategy: strategyDecision.strategy,
      };
      await prisma.marketAssessment.upsert({
        where: { date: getTodayForDB() },
        update: noTradeData,
        create: { date: getTodayForDB(), ...noTradeData },
      });
      isShadowMode = true;
    }
  } else {
    console.log("[2/5] AI市場評価: スキップ（シャドウモード）");
  }

  // 4. テクニカル分析 + スコアリング
  // shadow modeの場合、スコアリング失敗がhalt判定に影響しないようtry-catchで囲む
  try {
  console.log("[3/5] テクニカル分析 + スコアリング中...");

  // 利用可能資金から購入可能な上限株価を計算
  const config = await prisma.tradingConfig.findFirst({
    orderBy: { createdAt: "desc" },
  });
  const effectiveCap = config
    ? await getEffectiveCapital(config)
    : TRADING_DEFAULTS.TOTAL_BUDGET;
  const maxPositionPct = config
    ? Number(config.maxPositionPct)
    : TRADING_DEFAULTS.MAX_POSITION_PCT;

  const openPositions = await prisma.tradingPosition.findMany({
    where: { status: "open" },
  });
  const investedAmount = openPositions.reduce(
    (sum, pos) => sum + Number(pos.entryPrice) * pos.quantity,
    0,
  );
  const cashBalance = effectiveCap - investedAmount;
  const maxPositionAmount = effectiveCap * (maxPositionPct / 100);
  const maxAffordablePrice = Math.floor(
    Math.min(cashBalance, maxPositionAmount) / UNIT_SHARES,
  );

  console.log(
    `  資金状況: 実質資金=${effectiveCap}円, 投資中=${investedAmount}円, 残高=${cashBalance}円 → 上限株価=${maxAffordablePrice}円`,
  );

  // pending swing銘柄のticker取得（強制スキャン用）
  const pendingSwingForScan = await prisma.tradingOrder.findMany({
    where: { side: "buy", status: "pending", strategy: "swing" },
    select: { stock: { select: { tickerCode: true } } },
  });
  const swingTickerSet = new Set(
    pendingSwingForScan.map((o) => o.stock.tickerCode),
  );

  // スクリーニング条件に合う銘柄を取得（資金で買えない銘柄・非アクティブ・制限銘柄はDB段階で除外）
  const candidates = await prisma.stock.findMany({
    where: {
      isDelisted: false,
      isActive: true,
      isRestricted: false,
      tradingHaltFlag: false,
      latestPrice: {
        not: null,
        gte: SCREENING.MIN_PRICE,
        lte: maxAffordablePrice,
      },
      latestVolume: { not: null, gte: SCREENING.MIN_DAILY_VOLUME },
    },
  });

  // swing銘柄がスクリーニングで漏れた場合、強制追加
  if (swingTickerSet.size > 0) {
    const existingTickerSet = new Set(candidates.map((c) => c.tickerCode));
    const missingSwingTickers = [...swingTickerSet].filter(
      (t) => !existingTickerSet.has(t),
    );
    if (missingSwingTickers.length > 0) {
      const swingStocks = await prisma.stock.findMany({
        where: { tickerCode: { in: missingSwingTickers }, isDelisted: false },
      });
      candidates.push(...swingStocks);
      console.log(`  swing強制追加: ${swingStocks.length}銘柄`);
    }
  }

  console.log(`  スクリーニング通過: ${candidates.length}銘柄`);

  // セクターモメンタムを事前計算（スコアリングで使用）
  const nikkeiWeekChange = marketData.nikkei.changePercent;
  const sectorMomentum = await calculateSectorMomentum(nikkeiWeekChange);
  const sectorMomentumMap = new Map(
    sectorMomentum.map((s) => [s.sectorGroup, s]),
  );
  // sectorMomentum 配列はAI審判コンテキスト（.find()）で引き続き使用

  // テクニカル分析 + スコアリング（並列、バッチ制御）
  const limit = pLimit(JOB_CONCURRENCY.MARKET_SCANNER);
  const scoredCandidates: ScoredCandidate[] = [];

  for (let i = 0; i < candidates.length; i += YAHOO_FINANCE.BATCH_SIZE) {
    const batch = candidates.slice(i, i + YAHOO_FINANCE.BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map((stock) =>
        limit(async () => {
          try {
            const historical = await fetchHistoricalData(stock.tickerCode);
            if (
              !historical ||
              historical.length < TECHNICAL_MIN_DATA.SCANNER_MIN_BARS
            )
              return null;

            // テクニカル分析
            const summary = analyzeTechnicals(historical);

            // セクター相対強度を取得
            const sectorGroup = getSectorGroup(stock.jpxSectorName);
            const sectorInfo = sectorGroup ? sectorMomentumMap.get(sectorGroup) : null;
            const sectorRelativeStrength =
              sectorInfo && sectorInfo.stockCount >= SECTOR_MOMENTUM_SCORING.MIN_SECTOR_STOCK_COUNT
                ? sectorInfo.relativeStrength
                : null;

            // スコアリング（4カテゴリ: トレンド品質+エントリータイミング+リスク品質+セクターモメンタム）
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

            return {
              tickerCode: stock.tickerCode,
              name: stock.name,
              summary,
              score,
            } as ScoredCandidate;
          } catch (error) {
            console.error(
              `  テクニカル分析エラー: ${stock.tickerCode}`,
              error,
            );
            return null;
          }
        }),
      ),
    );

    scoredCandidates.push(
      ...batchResults.filter((r): r is ScoredCandidate => r !== null),
    );

    if (i + YAHOO_FINANCE.BATCH_SIZE < candidates.length) {
      await sleep(YAHOO_FINANCE.RATE_LIMIT_DELAY_MS);
    }
  }

  console.log(`  テクニカル分析完了: ${scoredCandidates.length}銘柄`);

  // 逆行ボーナス適用
  console.log("[3.5/5] 逆行ボーナス適用中...");
  const allTickerCodes = scoredCandidates.map((c) => c.tickerCode);
  const contrarianHistoryMap = await getContrarianHistoryBatch(allTickerCodes);

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
      c.score.rank = getRank(c.score.totalScore);
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

  // フィルタリング: S+Aランク（不足時はBランクも追加）
  let filtered = qualified.filter(
    (c) => c.score.rank === "S" || c.score.rank === "A",
  );
  if (filtered.length < SCORING.MIN_CANDIDATES_FOR_AI) {
    const bRankCandidates = qualified.filter(
      (c) => c.score.rank === "B",
    );
    filtered = [...filtered, ...bRankCandidates];
  }
  filtered = filtered.slice(0, SCORING.MAX_CANDIDATES_FOR_AI);

  // レジームによるランク制限
  if (regime.minRank) {
    const rankOrder: Record<string, number> = { S: 0, A: 1, B: 2, C: 3, D: 4 };
    const minRankOrder = rankOrder[regime.minRank];
    const beforeCount = filtered.length;
    filtered = filtered.filter((c) => rankOrder[c.score.rank] <= minRankOrder);
    if (filtered.length < beforeCount) {
      console.log(
        `  レジーム制限: ${regime.minRank}ランク以上に絞り込み（${beforeCount} → ${filtered.length}銘柄）`,
      );
    }
  }

  // レジーム制限で候補が不足した場合、Bランク上位を補充（最低パイプライン保証）
  if (filtered.length < SCORING.MIN_CANDIDATES_FOR_AI) {
    const filteredSet = new Set(filtered.map((c) => c.tickerCode));
    const bRankBackfill = qualified
      .filter((c) => c.score.rank === "B" && !filteredSet.has(c.tickerCode))
      .slice(0, SCORING.MIN_CANDIDATES_FOR_AI - filtered.length);
    if (bRankBackfill.length > 0) {
      filtered = [...filtered, ...bRankBackfill];
      console.log(
        `  レジーム緩和: 候補不足のためBランク上位${bRankBackfill.length}銘柄を補充（→ ${filtered.length}銘柄）`,
      );
    }
  }

  // swing銘柄をAI審査に強制追加（ランクに関係なく）
  if (swingTickerSet.size > 0) {
    const filteredSwingSet = new Set(filtered.map((c) => c.tickerCode));
    const missingSwing = scoredCandidates.filter(
      (c) => swingTickerSet.has(c.tickerCode) && !filteredSwingSet.has(c.tickerCode),
    );
    if (missingSwing.length > 0) {
      filtered = [...filtered, ...missingSwing];
      console.log(`  swing銘柄をAI審査に追加: ${missingSwing.length}銘柄`);
    }
  }

  // 精度追跡: filteredに入らなかったスコア60+の銘柄
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
  const rankCounts: Record<string, number> = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  for (const c of qualified) {
    rankCounts[c.score.rank]++;
  }
  console.log(
    `  ランク分布: S=${rankCounts.S} A=${rankCounts.A} B=${rankCounts.B} C=${rankCounts.C} D=${rankCounts.D}`,
  );

  // 銘柄別ニュースコンテキストを添付
  const stockCatalysts = newsAnalysis?.stockCatalysts as
    | Array<{ tickerCode: string; type: string; summary: string }>
    | undefined;

  if (stockCatalysts && stockCatalysts.length > 0) {
    for (const candidate of filtered) {
      const catalysts = stockCatalysts.filter(
        (c) => c.tickerCode === candidate.tickerCode,
      );
      if (catalysts.length > 0) {
        candidate.newsContext = catalysts
          .map((c) => `[${c.type}] ${c.summary}`)
          .join("\n");
      }
    }
  }

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
    rank: c.score.rank,
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
    // === シャドウモード: AIレビューをスキップし、全候補をmarket_haltedで記録 ===
    console.log("[4/5] AIレビュー: スキップ（シャドウモード）");
    console.log("[5/5] シャドウスコアリング結果保存中...");

    // filtered + accuracyTrackingCandidates を全てmarket_haltedで記録
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
      // 再実行時のデータ矛盾を防ぐため、同日の既存レコードを削除してから保存
      await prisma.scoringRecord.deleteMany({ where: { date: today } });
      await prisma.scoringRecord.createMany({
        data: shadowRecords,
      });
      console.log(`  シャドウScoringRecord 保存: ${shadowRecords.length}件`);
    } else {
      console.log("  シャドウ対象銘柄なし");
    }
  } else {
    // === 通常モード: AIレビュー + 結果保存 ===
    console.log("[4/5] AIレビュー中...");
    // AI審判コンテキスト用（フィルタとしては使わない）
    const newsSentiment = await getNewsSectorSentiment();

    const reviewCandidates: StockReviewCandidateInput[] = filtered.map((c) => {
      const stock = candidates.find((s) => s.tickerCode === c.tickerCode);
      const sectorGroup = getSectorGroup(stock?.jpxSectorName ?? null);
      const sectorInfo = sectorGroup
        ? sectorMomentum.find((s) => s.sectorGroup === sectorGroup)
        : null;

      const riskParts: string[] = [];
      riskParts.push(`レジーム: ${regime.level}（VIX ${regime.vix.toFixed(1)}）`);
      if (drawdown.consecutiveLosses > 0) {
        riskParts.push(`連敗: ${drawdown.consecutiveLosses}`);
      }
      if (sectorInfo) {
        riskParts.push(
          `セクター(${sectorGroup}): 相対強度 ${sectorInfo.relativeStrength >= 0 ? "+" : ""}${sectorInfo.relativeStrength.toFixed(1)}%`,
        );
      }
      const newsInfo = sectorGroup
        ? newsSentiment.find((s) => s.sectorGroup === sectorGroup)
        : null;
      if (newsInfo && newsInfo.score !== 0) {
        riskParts.push(
          `ニュース傾向(${sectorGroup}): ${newsInfo.score > 0 ? "ポジティブ" : "ネガティブ"}（直近${SECTOR_RISK.NEWS_SENTIMENT_DAYS}日: +${newsInfo.positiveCount}/-${newsInfo.negativeCount}）`,
        );
      }
      const contrarianInfo = contrarianBonusMap.get(c.tickerCode);
      if (contrarianInfo) {
        riskParts.push(
          `逆行実績: ${contrarianInfo.wins}回/90日（+${contrarianInfo.bonus}点ボーナス）`,
        );
      }

      return {
        tickerCode: c.tickerCode,
        name: c.name,
        scoreFormatted: formatScoreForAI(c.score, c.summary),
        newsContext: c.newsContext,
        riskContext: riskParts.join(" / "),
      };
    });

    const reviews = await reviewStocks(assessment!, reviewCandidates, strategyDecision.strategy);
    let goStocks = reviews.filter((r) => r.decision === "go");
    console.log(
      `  → AIレビュー: ${reviews.length}銘柄中 ${goStocks.length}銘柄承認`,
    );

    // cautiousモード: TS引き締め（TRAILING_TIGHTEN_MULTIPLIER）で対応
    // 銘柄数の制限は機会損失になるため廃止（リスクはポジションサイズとストップで管理）

    // 6. MarketAssessment + ScoringRecord に結果を保存
    console.log("[5/5] 結果保存中...");
    const selectedStocksData = goStocks.map((g) => {
      const scored = filtered.find((c) => c.tickerCode === g.tickerCode);
      return {
        tickerCode: g.tickerCode,
        strategy: g.strategy,
        reasoning: g.reasoning,
        riskFlags: g.riskFlags,
        technicalScore: scored?.score.totalScore ?? 0,
        technicalRank: scored?.score.rank ?? "C",
      };
    });

    const tradeAssessmentData = {
      ...buildMarketFields(marketData),
      sentiment: assessment!.sentiment,
      shouldTrade: true,
      reasoning: assessment!.reasoning,
      selectedStocks: JSON.parse(JSON.stringify(selectedStocksData)),
      tradingStrategy: strategyDecision.strategy,
    };
    await prisma.marketAssessment.upsert({
      where: { date: today },
      update: tradeAssessmentData,
      create: { date: today, ...tradeAssessmentData },
    });

    // ScoringRecord 保存（候補 + Ghost追跡）
    const scoringRecords = [
      // AIレビュー対象（S/A/Bランク）
      ...filtered.map((c) => {
        const review = reviews.find((r) => r.tickerCode === c.tickerCode);
        return {
          ...buildScoringFields(c),
          aiDecision: review?.decision ?? null,
          aiReasoning: review?.reasoning ?? null,
          rejectionReason: review?.decision === "no_go" ? "ai_no_go" : null,
          newsContext: c.newsContext ?? null,
        };
      }),
      // 精度追跡候補（スコア60+だがAI審査に送られなかった）
      ...accuracyTrackingCandidates.map((c) => ({
        ...buildScoringFields(c),
        aiDecision: null,
        aiReasoning: null,
        rejectionReason: "below_threshold",
      })),
    ];

    if (scoringRecords.length > 0) {
      // 再実行時のデータ矛盾を防ぐため、同日の既存レコードを削除してから保存
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
          const scored = filtered.find((c) => c.tickerCode === g.tickerCode);
          return {
            tickerCode: g.tickerCode,
            name: candidates.find((c) => c.tickerCode === g.tickerCode)?.name,
            strategy: g.strategy,
            score: scored?.score.totalScore ?? 0,
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

  console.log("=== Market Scanner 終了 ===");
}

const isDirectRun = process.argv[1]?.includes("market-scanner");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("Market Scanner エラー:", error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
