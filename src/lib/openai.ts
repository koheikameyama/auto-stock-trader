/**
 * OpenAI API クライアント（gpt-4o-mini）
 *
 * 市場予想の生成に使用する薄いラッパー。
 * response_format: json_object で構造化出力を強制。
 */

import OpenAI from "openai";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not configured");
    }
    client = new OpenAI({ apiKey });
  }
  return client;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export async function chatCompletion(
  messages: ChatMessage[],
  options?: { temperature?: number; maxTokens?: number; model?: string },
): Promise<string> {
  const openai = getClient();
  const model = options?.model ?? "gpt-4o-mini";
  // gpt-5 / o系 は reasoning モデル: max_completion_tokens を使い、temperature は既定(1)固定
  const isReasoning = /^(gpt-5|o1|o3|o4)/.test(model);

  const params: Record<string, unknown> = {
    model,
    messages,
    response_format: { type: "json_object" },
  };
  if (isReasoning) {
    // reasoning トークンで枠を食い切ると本文が空になるため多めに確保
    params.max_completion_tokens = Math.max(options?.maxTokens ?? 0, 3000);
  } else {
    params.temperature = options?.temperature ?? 0.3;
    params.max_tokens = options?.maxTokens ?? 2000;
  }

  const response = await openai.chat.completions.create(
    params as Parameters<typeof openai.chat.completions.create>[0],
  );
  return (response as { choices: { message: { content: string | null } }[] })
    .choices[0]?.message?.content ?? "";
}
