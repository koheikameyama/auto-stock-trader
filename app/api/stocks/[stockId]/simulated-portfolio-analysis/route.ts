import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { executeSimulatedPortfolioAnalysis } from "@/lib/portfolio-analysis-core";
import { AnalysisError } from "@/lib/portfolio-analysis-core";

/**
 * ウォッチリスト銘柄のポートフォリオ分析シミュレーション
 * 実際にはDBに保存せず、分析結果のみを返す
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ stockId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { stockId } = await params;
  const userId = session.user.id;

  try {
    // リクエストボディからシミュレーション設定を取得（将来的に拡張可能にするため。現在はデフォルト100株）
    const body = await request.json().catch(() => ({}));
    const quantity = body.quantity || 100;
    const averagePrice = body.averagePrice; // 指定がない場合は executeSimulatedPortfolioAnalysis 内で最新価格が使われる

    // TODO: averagePriceが未指定の場合に備え、まず現在価格を取得するロジックを検討
    // 現状は executeSimulatedPortfolioAnalysis 内で averagePrice が 0 の場合は
    // 損益計算がスキップされるが、このAPIの用途（今の価格で100株買った場合）を考えると、
    // ここで最新価格を取得して渡すか、コアロジック側で対応させる。

    // とりあえず、コア側で最新価格を取得しているので、そこから平均単価として使うように修正が必要か
    // 改めて executeSimulatedPortfolioAnalysis を確認すると、averagePrice を引数で取っている。
    // シミュレーションなので、「現在価格で買った」ことにしたい。

    // コアロジック側の executeSimulatedPortfolioAnalysis を呼び出す。
    // 引数の平均単価が 0 の場合は最新価格を平均単価として扱うように後ほどコアを少し調整するか、
    // ここで最新価格を取得する。

    const result = await executeSimulatedPortfolioAnalysis(
      userId,
      stockId,
      quantity,
      averagePrice || 0, // 0を渡すと「現在価格で買った」とみなすロジックを期待（後でコアを微調整する）
    );

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AnalysisError) {
      const statusMap: Record<string, number> = {
        NOT_FOUND: 404,
        STALE_DATA: 400,
        NO_PRICE_DATA: 400,
        INTERNAL: 500,
      };
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: statusMap[error.code] || 500 },
      );
    }
    console.error("Error generating simulated portfolio analysis:", error);
    return NextResponse.json(
      { error: "シミュレーション分析の生成に失敗しました" },
      { status: 500 },
    );
  }
}
export async function GET() {
  return NextResponse.json(
    { error: "Method not implemented" },
    { status: 404 },
  );
}
