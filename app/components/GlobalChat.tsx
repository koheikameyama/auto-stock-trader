"use client";

import { useRef, useEffect, useState, useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useChatContext } from "@/app/contexts/ChatContext";

interface ParsedSource {
  title: string;
  url: string;
}

interface ParsedMessage {
  mainContent: string;
  sources: ParsedSource[];
}

// メッセージから本文と参考情報を分離
function parseMessage(content: string): ParsedMessage {
  const separator = "\n\n---\n📰 参考にした情報:";
  const separatorIndex = content.indexOf(separator);

  if (separatorIndex === -1) {
    return { mainContent: content, sources: [] };
  }

  const mainContent = content.substring(0, separatorIndex);
  const sourcesText = content.substring(separatorIndex + separator.length);

  // ソースをパース（• タイトル\n  URL の形式）
  const sources: ParsedSource[] = [];
  const lines = sourcesText.trim().split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("•")) {
      const title = line.substring(1).trim();
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        if (nextLine.startsWith("http")) {
          sources.push({ title, url: nextLine });
          i++;
        }
      }
    }
  }

  return { mainContent, sources };
}

// ソースアコーディオンコンポーネント
function SourcesAccordion({ sources }: { sources: ParsedSource[] }) {
  const [isOpen, setIsOpen] = useState(false);

  if (sources.length === 0) return null;

  return (
    <div className="mt-2 border-t border-gray-200 pt-2">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform ${isOpen ? "rotate-90" : ""}`}
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
        📰 参考情報（{sources.length}件）
      </button>
      {isOpen && (
        <ul className="mt-2 space-y-1">
          {sources.map((source, index) => (
            <li key={index} className="text-xs">
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-800 hover:underline break-all"
              >
                {source.title}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const DEFAULT_QUESTIONS = [
  "今日の注目点は？",
  "保有銘柄どう？",
  "何か気をつけることある？",
];

const PORTFOLIO_STOCK_QUESTIONS = [
  "今後の見通しは？",
  "売り時？まだ持つべき？",
  "追加購入すべき？",
];

const WATCHLIST_STOCK_QUESTIONS = [
  "今後の見通しは？",
  "今が買い時？",
  "どんなリスクがある？",
];

// メッセージからテキストコンテンツを抽出
function getMessageText(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<typeof part, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

export default function GlobalChat() {
  const { stockContext } = useChatContext();
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { messages, sendMessage, status, setMessages, error } = useChat({
    id: stockContext?.stockId ?? "global",
    transport: useMemo(
      () =>
        new DefaultChatTransport({
          api: "/api/chat",
          body: { stockContext },
        }),
      [stockContext],
    ),
  });

  const isLoading = status === "submitted" || status === "streaming";

  // 銘柄が変わったら会話をリセット
  const prevStockRef = useRef<string | null>(null);
  useEffect(() => {
    const currentStockKey = stockContext?.tickerCode ?? null;
    if (prevStockRef.current !== currentStockKey) {
      setMessages([]);
      prevStockRef.current = currentStockKey;
    }
  }, [stockContext, setMessages]);

  // 質問候補を決定
  const suggestedQuestions = stockContext
    ? stockContext.type === "portfolio"
      ? PORTFOLIO_STOCK_QUESTIONS
      : WATCHLIST_STOCK_QUESTIONS
    : DEFAULT_QUESTIONS;

  // メッセージが更新されたら自動スクロール
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async (text: string) => {
    if (!text.trim() || isLoading) return;
    setInput("");
    await sendMessage({ text: text.trim() }, { body: { stockContext } });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleSend(input);
  };

  const toggleChat = () => {
    setIsOpen(!isOpen);
  };

  // チャットタイトル
  const chatTitle = stockContext
    ? `${stockContext.name}について相談`
    : "投資について相談";

  // プレースホルダー
  const placeholder = stockContext
    ? `${stockContext.name}について質問...`
    : "投資について相談...";

  return (
    <>
      {/* Floating Button */}
      <button
        onClick={toggleChat}
        className={`fixed bottom-[68px] right-4 w-14 h-14 ${
          stockContext
            ? "bg-green-600 hover:bg-green-700"
            : "bg-blue-600 hover:bg-blue-700"
        } text-white rounded-full shadow-lg flex items-center justify-center transition-all z-40`}
        title={chatTitle}
      >
        {isOpen ? (
          <svg
            className="w-6 h-6"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        ) : (
          <svg
            className="w-6 h-6"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
        )}
      </button>

      {/* Chat Panel */}
      {isOpen && (
        <div className="fixed bottom-32 right-4 w-96 max-w-[calc(100vw-2rem)] h-[500px] max-h-[calc(100vh-12rem)] bg-white rounded-xl shadow-2xl flex flex-col z-40 border border-gray-200">
          {/* Header */}
          <div
            className={`${
              stockContext ? "bg-green-600" : "bg-blue-600"
            } text-white px-4 py-3 rounded-t-xl flex items-center justify-between`}
          >
            <div className="flex items-center gap-2">
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                />
              </svg>
              <div>
                <h3 className="font-semibold text-sm">{chatTitle}</h3>
                {stockContext && (
                  <p className="text-xs opacity-80">
                    {stockContext.tickerCode}
                  </p>
                )}
              </div>
            </div>
            <button
              onClick={toggleChat}
              className="text-white hover:text-gray-200 transition-colors"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          {/* Messages Area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 && (
              <div className="text-center py-8 text-gray-500">
                {stockContext ? (
                  <>
                    <p className="mb-4 font-semibold text-gray-700">
                      {stockContext.name}について質問してください
                    </p>
                    <p className="text-sm">
                      この銘柄に特化したアドバイスをします
                    </p>
                  </>
                ) : (
                  <>
                    <p className="mb-4">投資について何でも質問してください</p>
                    <p className="text-sm">
                      あなたの保有銘柄や気になる銘柄をもとにアドバイスします
                    </p>
                  </>
                )}
              </div>
            )}

            {messages.map((message) => {
              const text = getMessageText(message);
              if (!text) return null;

              const isStreamingMsg =
                status === "streaming" &&
                message === messages[messages.length - 1] &&
                message.role === "assistant";

              const parsed =
                message.role === "assistant" && !isStreamingMsg
                  ? parseMessage(text)
                  : { mainContent: text, sources: [] };

              return (
                <div
                  key={message.id}
                  className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg px-4 py-3 ${
                      message.role === "user"
                        ? stockContext
                          ? "bg-green-600 text-white"
                          : "bg-blue-600 text-white"
                        : "bg-gray-100 text-gray-900"
                    }`}
                  >
                    <p className="text-sm whitespace-pre-wrap">
                      {parsed.mainContent}
                    </p>
                    {message.role === "assistant" && !isStreamingMsg && (
                      <SourcesAccordion sources={parsed.sources} />
                    )}
                  </div>
                </div>
              );
            })}

            {status === "submitted" && (
              <div className="flex justify-start">
                <div className="bg-gray-100 rounded-lg px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="animate-pulse flex gap-1">
                      <div className="w-2 h-2 bg-gray-400 rounded-full"></div>
                      <div className="w-2 h-2 bg-gray-400 rounded-full"></div>
                      <div className="w-2 h-2 bg-gray-400 rounded-full"></div>
                    </div>
                    <span className="text-sm text-gray-600">
                      考えています...
                    </span>
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className="flex justify-start">
                <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 max-w-[80%]">
                  <p className="text-sm text-red-600">
                    エラーが発生しました。もう一度お試しください。
                  </p>
                  <p className="text-xs text-red-400 mt-1">
                    {error.message}
                  </p>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Suggested Questions */}
          {messages.length === 0 && (
            <div className="px-4 pb-3">
              <p className="text-xs text-gray-500 mb-2">💡 よくある質問:</p>
              <div className="flex flex-wrap gap-2">
                {suggestedQuestions.map((question, index) => (
                  <button
                    key={index}
                    onClick={() => handleSend(question)}
                    className={`px-3 py-1.5 text-xs rounded-full transition-colors ${
                      stockContext
                        ? "bg-green-50 text-green-700 hover:bg-green-100"
                        : "bg-blue-50 text-blue-700 hover:bg-blue-100"
                    }`}
                    disabled={isLoading}
                  >
                    {question}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Input Form */}
          <form
            onSubmit={handleSubmit}
            className="p-4 border-t border-gray-200"
          >
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={placeholder}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                disabled={isLoading}
              />
              <button
                type="submit"
                disabled={isLoading || !input.trim()}
                className={`p-2 text-white rounded-lg transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed ${
                  stockContext
                    ? "bg-green-600 hover:bg-green-700"
                    : "bg-blue-600 hover:bg-blue-700"
                }`}
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                  />
                </svg>
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
