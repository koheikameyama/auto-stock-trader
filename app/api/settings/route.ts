import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";

// GET: ユーザー設定を取得
export async function GET() {
  const { user: authUser, error: getError } = await getAuthUser();
  if (getError) return getError;

  try {
    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      include: {
        settings: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    if (!user.settings) {
      // デフォルト設定を返す
      return NextResponse.json({
        settings: {
          investmentStyle: "CONSERVATIVE",
          investmentBudget: null,
          targetReturnRate: 5,
          stopLossRate: -5,
        },
      });
    }

    return NextResponse.json({ settings: user.settings });
  } catch (error) {
    console.error("Error fetching settings:", error);
    return NextResponse.json(
      { error: "設定の取得に失敗しました" },
      { status: 500 },
    );
  }
}

// PUT: ユーザー設定を更新
export async function PUT(request: NextRequest) {
  const { user: putUser, error: putError } = await getAuthUser();
  if (putError) return putError;

  try {
    const {
      investmentStyle,
      investmentBudget,
      targetReturnRate,
      stopLossRate,
    } = await request.json();

    // バリデーション
    if (!investmentStyle) {
      return NextResponse.json(
        { error: "投資スタイルを選択してください" },
        { status: 400 },
      );
    }

    // 投資スタイルの値チェック
    const validStyles = ["CONSERVATIVE", "BALANCED", "AGGRESSIVE"];
    if (!validStyles.includes(investmentStyle)) {
      return NextResponse.json(
        { error: "無効な投資スタイルです" },
        { status: 400 },
      );
    }

    // 目標利益率のバリデーション（設定されている場合のみ）
    const validReturnRates = [5, 10, 15, 20, 30];
    if (
      targetReturnRate !== undefined &&
      targetReturnRate !== null &&
      !validReturnRates.includes(targetReturnRate)
    ) {
      return NextResponse.json(
        { error: "無効な目標利益率です" },
        { status: 400 },
      );
    }

    // 損切りラインのバリデーション（設定されている場合のみ）
    const validStopLossRates = [-5, -10, -15, -20];
    if (
      stopLossRate !== undefined &&
      stopLossRate !== null &&
      !validStopLossRates.includes(stopLossRate)
    ) {
      return NextResponse.json(
        { error: "無効な損切りラインです" },
        { status: 400 },
      );
    }

    // ユーザー設定を更新
    const updatedSettings = await prisma.userSettings.upsert({
      where: { userId: putUser.id },
      create: {
        userId: putUser.id,
        investmentStyle,
        investmentBudget: investmentBudget ?? null,
        targetReturnRate: targetReturnRate ?? null,
        stopLossRate: stopLossRate ?? null,
      },
      update: {
        investmentStyle,
        investmentBudget: investmentBudget ?? null,
        targetReturnRate: targetReturnRate ?? null,
        stopLossRate: stopLossRate ?? null,
      },
    });

    return NextResponse.json({
      success: true,
      message: "投資スタイルを更新しました",
      settings: updatedSettings,
    });
  } catch (error) {
    console.error("Error updating settings:", error);
    return NextResponse.json(
      { error: "設定の更新に失敗しました" },
      { status: 500 },
    );
  }
}
