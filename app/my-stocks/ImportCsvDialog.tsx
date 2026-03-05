"use client";

import { useState, useRef } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

interface ParsedTransaction {
  date: string; // "2026-02-05"
  tickerCode: string; // "4005"
  stockName: string;
  type: "buy" | "sell";
  quantity: number;
  price: number;
}

interface ImportResult {
  imported: number;
  replaced: number;
  failed: { tickerCode: string; reason: string }[];
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function parseRakutenCsv(text: string): ParsedTransaction[] {
  const lines = text.trim().split(/\r?\n/);
  const results: ParsedTransaction[] = [];

  // 1行目はヘッダー、2行目以降がデータ
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCSVLine(line);
    if (cols.length < 12) continue;

    // 取引区分（col[6]）が「現物」で始まるもののみ対象（現物、現物(単元未満)等）
    const tradeCategory = cols[6]?.trim();
    if (!tradeCategory?.startsWith("現物")) continue;

    // 売買区分（col[7]）: 買付 or 売付
    const buySell = cols[7]?.trim();
    const type: "buy" | "sell" | null =
      buySell === "買付" ? "buy" : buySell === "売付" ? "sell" : null;
    if (!type) continue;

    // 約定日（col[0]）: "2026/2/5" → "2026-02-05"
    const rawDate = cols[0]?.trim();
    const dateParts = rawDate.split("/");
    if (dateParts.length !== 3) continue;
    const date = `${dateParts[0]}-${dateParts[1].padStart(2, "0")}-${dateParts[2].padStart(2, "0")}`;

    const tickerCode = cols[2]?.trim();
    const stockName = cols[3]?.trim();
    const quantity = parseInt(cols[10]?.replace(/,/g, "").trim(), 10);
    const price = parseFloat(cols[11]?.replace(/,/g, "").trim());

    if (!tickerCode || !date || isNaN(quantity) || isNaN(price) || quantity <= 0 || price <= 0) continue;

    results.push({ date, tickerCode, stockName, type, quantity, price });
  }

  // 約定日の昇順でソート
  results.sort((a, b) => a.date.localeCompare(b.date));
  return results;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onImportComplete: () => void;
}

export default function ImportCsvDialog({ isOpen, onClose, onImportComplete }: Props) {
  const t = useTranslations("portfolio.importCsv");
  const [transactions, setTransactions] = useState<ParsedTransaction[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const buffer = ev.target?.result as ArrayBuffer;
      // 楽天証券CSVはShift-JIS形式
      const text = new TextDecoder("shift-jis").decode(buffer);
      const parsed = parseRakutenCsv(text);
      setTransactions(parsed);
      setResult(null);

      if (parsed.length === 0) {
        toast.error(t("noTransactionsFound"));
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleImport = async () => {
    if (transactions.length === 0) return;
    setImporting(true);
    try {
      const res = await fetch("/api/import/rakuten-csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactions }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t("importFailed"));
        return;
      }
      setResult(data);
      if (data.imported > 0) {
        onImportComplete();
      }
    } catch {
      toast.error(t("importFailed"));
    } finally {
      setImporting(false);
    }
  };

  const handleClose = () => {
    setTransactions([]);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    onClose();
  };

  const uniqueTickers = new Set(transactions.map((t) => t.tickerCode)).size;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b flex-shrink-0">
          <h2 className="text-lg font-bold text-gray-900">{t("dialogTitle")}</h2>
          <button onClick={handleClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {result ? (
            /* 完了画面 */
            <div className="text-center py-8">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-xl font-bold text-gray-900 mb-1">
                {t("successTitle", { count: result.imported })}
              </p>
              {result.replaced > 0 && (
                <p className="text-sm text-gray-500 mb-1">
                  {t("replaced", { count: result.replaced })}
                </p>
              )}
              {result.failed.length > 0 && (
                <div className="mt-4 text-left bg-red-50 rounded-lg p-4">
                  <p className="text-sm font-medium text-red-700 mb-2">
                    {t("failedTitle")}
                  </p>
                  {result.failed.map((f) => (
                    <p key={f.tickerCode} className="text-sm text-red-600">
                      {f.tickerCode}: {f.reason}
                    </p>
                  ))}
                </div>
              )}
            </div>
          ) : transactions.length === 0 ? (
            /* ファイル選択画面 */
            <div>
              <p className="text-sm text-gray-600 mb-4">
                {t("description")}
              </p>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full border-2 border-dashed border-gray-300 rounded-lg p-10 text-center hover:border-blue-400 hover:bg-blue-50 transition-colors"
              >
                <svg
                  className="w-10 h-10 text-gray-400 mx-auto mb-3"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
                <p className="text-sm font-medium text-gray-700">{t("selectFile")}</p>
                <p className="text-xs text-gray-400 mt-1">{t("fileHint")}</p>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>
          ) : (
            /* プレビュー画面 */
            <div>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-3 gap-1">
                <p className="text-sm text-gray-700">
                  {t("foundTransactions", { count: transactions.length, tickers: uniqueTickers })}
                </p>
                <button
                  onClick={() => {
                    setTransactions([]);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                  className="text-xs text-gray-400 hover:text-gray-600 underline self-start sm:self-auto"
                >
                  {t("changeFile")}
                </button>
              </div>
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">{t("tableDate")}</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">{t("tableStock")}</th>
                      <th className="px-3 py-2 text-center font-medium text-gray-600">{t("tableBuySell")}</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-600">{t("tableQuantity")}</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-600">{t("tablePrice")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {transactions.slice(0, 20).map((tx, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-3 py-1.5 text-gray-700">{tx.date}</td>
                        <td className="px-3 py-1.5 text-gray-700">
                          <span className="font-medium">{tx.tickerCode}</span>
                          <span className="text-gray-400 ml-1.5 hidden sm:inline">{tx.stockName}</span>
                        </td>
                        <td className="px-3 py-1.5 text-center">
                          <span
                            className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                              tx.type === "buy"
                                ? "bg-blue-100 text-blue-700"
                                : "bg-red-100 text-red-700"
                            }`}
                          >
                            {tx.type === "buy" ? t("buy") : t("sell")}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right text-gray-700">
                          {tx.quantity.toLocaleString()}
                        </td>
                        <td className="px-3 py-1.5 text-right text-gray-700">
                          ¥{tx.price.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {transactions.length > 20 && (
                  <div className="text-center py-2 text-xs text-gray-400 bg-gray-50 border-t">
                    {t("moreItems", { count: transactions.length - 20 })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-5 border-t flex-shrink-0">
          {result ? (
            <button
              onClick={handleClose}
              className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors"
            >
              {t("close")}
            </button>
          ) : (
            <>
              <button
                onClick={handleClose}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 transition-colors"
              >
                {t("cancel")}
              </button>
              {transactions.length > 0 && (
                <button
                  onClick={handleImport}
                  disabled={importing}
                  className="px-5 py2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                >
                  {importing ? t("importing") : t("importButton", { count: transactions.length })}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
