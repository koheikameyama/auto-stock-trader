import { auth } from "@/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import Header from "@/app/components/Header";
import BottomNavigation from "@/app/components/BottomNavigation";
import DashboardClient from "./DashboardClient";
import FeaturedStocksByCategory from "./FeaturedStocksByCategory";
import TopStocksByStyle from "./TopStocksByStyle";
import PortfolioSummary from "./PortfolioSummary";
import PortfolioHistoryChart from "./PortfolioHistoryChart";
import PortfolioCompositionChart from "./PortfolioCompositionChart";
import DailyMarketNavigator from "./DailyMarketNavigator";
import NikkeiSummary from "./NikkeiSummary";
import GapPredictionCard from "./GapPredictionCard";
import BudgetSummary from "./BudgetSummary";
import GeopoliticalRiskCard from "./GeopoliticalRiskCard"
import { SectorTrendHeatmap } from "./SectorTrendHeatmap";
import { getRichStyleLabel } from "@/lib/constants";
import { calculatePortfolioFromTransactions } from "@/lib/portfolio-calculator";
import { getTranslations } from 'next-intl/server';

export default async function DashboardPage() {
  const session = await auth();
  const t = await getTranslations('dashboard');

  if (!session?.user?.email) {
    redirect("/login");
  }

  // ユーザー情報を取得
  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: {
      id: true,
      termsAccepted: true,
      privacyPolicyAccepted: true,
      settings: true,
      watchlistStocks: {
        select: { id: true },
      },
      portfolioStocks: {
        select: {
          id: true,
          transactions: {
            select: { type: true, quantity: true, price: true },
          },
        },
      },
    },
  });

  if (!user) {
    redirect("/login");
  }

  // 利用規約・プライバシーポリシー未同意の場合は同意ページへリダイレクト
  if (!user.termsAccepted || !user.privacyPolicyAccepted) {
    redirect("/terms-acceptance");
  }

  const activePortfolioStocks = user.portfolioStocks.filter((ps) => {
    const { quantity } = calculatePortfolioFromTransactions(ps.transactions);
    return quantity > 0;
  });
  const hasHoldings = activePortfolioStocks.length > 0;
  const hasPortfolioStocks = user.portfolioStocks.length > 0;
  const portfolioCount = activePortfolioStocks.length;
  const watchlistCount = user.watchlistStocks.length;

  return (
    <>
      <Header />
      <DashboardClient />
      <main className="min-h-screen bg-gradient-to-b from-blue-50 via-white to-blue-50 pb-20">
        <div className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-8">
          {/* ページタイトル */}
          <div className="mb-4 sm:mb-8">
            <h1 className="text-xl sm:text-3xl font-bold text-gray-900">
              {t('greeting', { name: session.user.name?.split(" ")[0] || "" })}
            </h1>
            <p className="text-xs sm:text-base text-gray-600 mt-1">
              {t('subtitle')}
            </p>
          </div>

          {/* Daily Market Navigator */}
          <DailyMarketNavigator
            portfolioCount={portfolioCount}
            watchlistCount={watchlistCount}
          />

          {/* 寄り付きギャップ予測（morningセッションのみ表示） */}
          <GapPredictionCard />

          {/* 投資スタイル未設定の場合のプロンプト */}
          {!user.settings && (
            <Link
              href="/settings"
              className="block mb-4 sm:mb-6 bg-gradient-to-r from-blue-500 to-blue-600 rounded-xl p-4 sm:p-5 shadow-md hover:shadow-lg transition-shadow"
            >
              <div className="flex items-center gap-3 sm:gap-4">
                <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-white/20 flex items-center justify-center shrink-0">
                  <span className="text-2xl sm:text-3xl">📊</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-white font-bold text-base sm:text-lg mb-1">
                    {t('investmentStyle.setupPrompt.title')}
                  </div>
                  <div className="text-blue-100 text-xs sm:text-sm">
                    {t('investmentStyle.setupPrompt.description')}
                  </div>
                </div>
                <div className="shrink-0">
                  <svg
                    className="w-6 h-6 sm:w-7 sm:h-7 text-white/80"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </div>
              </div>
            </Link>
          )}

          {/* 投資スタイル表示 */}
          {user.settings && (
            <div className="mb-4 sm:mb-6 bg-white rounded-xl p-3 sm:p-4 shadow-sm border border-gray-200">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 sm:gap-3 flex-1 min-w-0">
                  <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                    <span className="text-lg sm:text-xl">📊</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-gray-500 mb-1 sm:mb-1.5">
                      {t('investmentStyle.label')}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                      <span className="inline-flex items-center px-2 sm:px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 w-fit">
                        {getRichStyleLabel(user.settings.investmentStyle)}
                      </span>
                      {user.settings.investmentBudget && (
                        <span className="inline-flex items-center px-2 sm:px-2.5 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-800 w-fit">
                          {t('investmentStyle.budget')}{" "}
                          {(
                            user.settings.investmentBudget / 10000
                          ).toLocaleString()}
                          {t('investmentStyle.budgetUnit')}
                        </span>
                      )}
                      <span
                        className={`inline-flex items-center px-2 sm:px-2.5 py-0.5 rounded-full text-xs font-semibold w-fit ${
                          user.settings.targetReturnRate
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {t('investmentStyle.sellTarget')}{" "}
                        {user.settings.targetReturnRate
                          ? `+${user.settings.targetReturnRate}%`
                          : t('investmentStyle.aiManaged')}
                      </span>
                      <span
                        className={`inline-flex items-center px-2 sm:px-2.5 py-0.5 rounded-full text-xs font-semibold w-fit ${
                          user.settings.stopLossRate
                            ? "bg-red-100 text-red-800"
                            : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {t('investmentStyle.exitLine')}{" "}
                        {user.settings.stopLossRate
                          ? `${user.settings.stopLossRate}%`
                          : t('investmentStyle.aiManaged')}
                      </span>
                    </div>
                  </div>
                </div>
                <Link
                  href="/settings"
                  className="p-1.5 sm:p-2 text-gray-400 hover:text-blue-600 transition-colors shrink-0"
                  title={t('investmentStyle.edit')}
                >
                  <svg
                    className="w-4 h-4 sm:w-5 sm:h-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                    />
                  </svg>
                </Link>
              </div>
            </div>
          )}

          {/* 投資資金サマリー */}
          {user.settings?.investmentBudget && <BudgetSummary />}

          {/* 日経平均株価 */}
          <NikkeiSummary />

          {/* 損益サマリー（クリックでマイ銘柄へ） */}
          <PortfolioSummary hasHoldings={hasHoldings} hasPortfolioStocks={hasPortfolioStocks} />

          {/* 資産推移グラフ */}
          {hasPortfolioStocks && (
            <div className="mt-4 sm:mt-6">
              <PortfolioHistoryChart />
            </div>
          )}

          {/* ポートフォリオ構成グラフ */}
          {hasHoldings && (
            <div className="mt-4 sm:mt-6">
              <PortfolioCompositionChart />
            </div>
          )}

          {/* 地政学・マクロリスクカード */}
          <GeopoliticalRiskCard />

          {/* セクタートレンドヒートマップ */}
          <SectorTrendHeatmap />

          {/* 今日の注目銘柄（カテゴリ別） */}
          <div className="mt-4 sm:mt-6">
            <FeaturedStocksByCategory />
          </div>

          {/* 注目の高評価銘柄（投資スタイル別） */}
          {user.settings && (
            <div className="mt-4 sm:mt-6">
              <TopStocksByStyle />
            </div>
          )}
        </div>
      </main>
      <BottomNavigation />
    </>
  );
}
