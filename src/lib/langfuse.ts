/**
 * Langfuse トレーシング設定
 *
 * OpenAI API呼び出しの自動トレーシングを提供する。
 * 環境変数が未設定の場合は通常のOpenAIクライアントにフォールバックする。
 */

import OpenAI from "openai";
import { observeOpenAI } from "@langfuse/openai";
import { Langfuse } from "langfuse";

/** Langfuseが有効かどうか（環境変数の存在で判定） */
export function isLangfuseEnabled(): boolean {
  return !!(
    process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY
  );
}

/** observeOpenAI に渡すトレース設定 */
export interface TraceConfig {
  /** 生成の識別名（例: "assess-market", "review-trade"） */
  generationName: string;
  /** 追加メタデータ（銘柄コード等） */
  metadata?: Record<string, unknown>;
  /** セッションID（ジョブ実行単位で紐づけたい場合） */
  sessionId?: string;
  /** タグ（例: ["trading", "morning-analysis"]） */
  tags?: string[];
}

/**
 * Langfuseトレーシング付きOpenAIクライアントを取得する
 *
 * Langfuse環境変数が設定されていない場合は通常のOpenAIクライアントを返す。
 * Langfuseラッパーでエラーが発生した場合も通常のOpenAIクライアントにフォールバック。
 */
export function getTracedOpenAIClient(config: TraceConfig): OpenAI {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  if (!isLangfuseEnabled()) {
    return openai;
  }

  try {
    return observeOpenAI(openai, {
      generationName: config.generationName,
      generationMetadata: config.metadata,
      sessionId: config.sessionId,
      tags: config.tags,
    });
  } catch (error) {
    console.error(
      "[langfuse] ラッパー初期化エラー、通常クライアントにフォールバック:",
      error,
    );
    return openai;
  }
}

/**
 * Langfuseのバッファをフラッシュする
 * 短命プロセス（バッチジョブのCLI直接実行）の終了前に呼ぶ
 */
export async function flushLangfuse(): Promise<void> {
  if (!isLangfuseEnabled()) return;

  try {
    const langfuse = new Langfuse();
    await langfuse.flushAsync();
    await langfuse.shutdownAsync();
  } catch (error) {
    console.error("[langfuse] flush エラー:", error);
  }
}
