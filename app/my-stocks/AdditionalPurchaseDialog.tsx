"use client"

import { useState, useEffect } from "react"
import { toast } from "sonner"

interface UserStock {
  id: string
  userId: string
  stockId: string
  type: "watchlist" | "portfolio"
  quantity?: number
  averagePurchasePrice?: number
  purchaseDate?: string
  stock: {
    id: string
    tickerCode: string
    name: string
    sector: string | null
    market: string
    currentPrice: number | null
    atr14?: number | null
  }
  createdAt: string
  updatedAt: string
}

interface AdditionalPurchaseDialogProps {
  isOpen: boolean
  onClose: () => void
  stock: UserStock | null
  onSuccess: (updatedStock: UserStock) => void
  transactionType?: "buy" | "sell"
}

export default function AdditionalPurchaseDialog({
  isOpen,
  onClose,
  stock,
  onSuccess,
  transactionType = "buy",
}: AdditionalPurchaseDialogProps) {
  const [quantity, setQuantity] = useState("")
  const [price, setPrice] = useState("")
  const [transactionDate, setTransactionDate] = useState(
    new Date().toISOString().split("T")[0]
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isBuy = transactionType === "buy"

  // Reset form when dialog opens/closes or type changes
  useEffect(() => {
    if (isOpen) {
      setQuantity("100")
      setPrice(stock?.stock.currentPrice?.toString() ?? "")
      setTransactionDate(new Date().toISOString().split("T")[0])
      setError(null)
    }
  }, [isOpen, transactionType, stock])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!stock) {
      setError("銘柄が選択されていません")
      return
    }

    const qty = parseInt(quantity)
    if (!quantity || qty <= 0) {
      setError(isBuy ? "追加購入株数を入力してください" : "売却株数を入力してください")
      return
    }

    // 売却時は保有数を超えないかチェック
    if (!isBuy && qty > (stock.quantity || 0)) {
      setError(`売却可能な株数は${stock.quantity || 0}株までです`)
      return
    }

    if (!price || parseFloat(price) <= 0) {
      setError(isBuy ? "購入単価を入力してください" : "売却単価を入力してください")
      return
    }

    setLoading(true)

    try {
      const body = {
        type: transactionType,
        quantity: qty,
        price: parseFloat(price),
        purchaseDate: transactionDate,
      }

      const response = await fetch(`/api/portfolio-stocks/${stock.id}/additional-purchase`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || (isBuy ? "追加購入の保存に失敗しました" : "売却の保存に失敗しました"))
      }

      const updatedStock = await response.json()
      onSuccess(updatedStock)
    } catch (err: any) {
      const errorMessage = err.message || (isBuy ? "追加購入の保存に失敗しました" : "売却の保存に失敗しました")
      setError(errorMessage)
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  if (!isOpen || !stock) return null

  const currentQuantity = stock.quantity || 0
  const currentAvgPrice = stock.averagePurchasePrice || 0
  const inputQuantity = parseInt(quantity) || 0
  const inputPrice = parseFloat(price) || 0

  // Calculate preview
  let previewQuantity: number
  let previewAvgPrice: number

  if (isBuy) {
    previewQuantity = currentQuantity + inputQuantity
    previewAvgPrice = previewQuantity > 0
      ? (currentQuantity * currentAvgPrice + inputQuantity * inputPrice) / previewQuantity
      : 0
  } else {
    previewQuantity = currentQuantity - inputQuantity
    previewAvgPrice = currentAvgPrice // 売却しても平均単価は変わらない
  }

  // 売却損益計算
  const sellProfit = !isBuy && inputQuantity > 0 && inputPrice > 0
    ? (inputPrice - currentAvgPrice) * inputQuantity
    : 0

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl max-w-md w-full p-6 shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl sm:text-2xl font-bold text-gray-900">
            {isBuy ? "追加購入" : "売却"}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
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
          </button>
        </div>

        {/* Stock Info */}
        <div className="mb-6 p-4 bg-gray-50 rounded-lg">
          <h3 className="font-semibold text-gray-900">{stock.stock.name}</h3>
          <p className="text-sm text-gray-600">{stock.stock.tickerCode}</p>
          <div className="mt-3 space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">現在の保有数</span>
              <span className="font-semibold text-gray-900">{currentQuantity}株</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">現在の平均単価</span>
              <span className="font-semibold text-gray-900">¥{currentAvgPrice.toLocaleString()}</span>
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="quantity"
              className="block text-sm font-semibold text-gray-700 mb-2"
            >
              {isBuy ? "追加購入株数" : "売却株数"} <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              id="quantity"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              min="1"
              max={!isBuy ? currentQuantity : undefined}
              placeholder="例: 100"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
            />
            {!isBuy && (
              <p className="mt-1 text-xs text-gray-500">
                売却可能: {currentQuantity}株
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="price"
              className="block text-sm font-semibold text-gray-700 mb-2"
            >
              {isBuy ? "購入単価" : "売却単価"} <span className="text-red-500">*</span>
              {stock.stock.currentPrice && (
                <span className="ml-2 text-xs font-normal text-gray-500">
                  （現在価格: ¥{stock.stock.currentPrice.toLocaleString()}）
                </span>
              )}
            </label>
            <input
              type="number"
              id="price"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              min="0"
              step="0.01"
              placeholder="例: 2500"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
            />
          </div>

          <div>
            <label
              htmlFor="transactionDate"
              className="block text-sm font-semibold text-gray-700 mb-2"
            >
              {isBuy ? "購入日" : "売却日"} <span className="text-red-500">*</span>
            </label>
            <input
              type="date"
              id="transactionDate"
              value={transactionDate}
              onChange={(e) => setTransactionDate(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
            />
          </div>

          {/* Preview */}
          {quantity && price && (
            <div className={`p-4 rounded-lg ${isBuy ? "bg-blue-50" : "bg-orange-50"}`}>
              <h4 className={`text-sm font-semibold mb-2 ${isBuy ? "text-blue-900" : "text-orange-900"}`}>
                {isBuy ? "購入後の状況" : "売却後の状況"}
              </h4>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className={isBuy ? "text-blue-700" : "text-orange-700"}>
                    {isBuy ? "合計保有数" : "残り保有数"}
                  </span>
                  <span className={`font-semibold ${isBuy ? "text-blue-900" : "text-orange-900"}`}>
                    {previewQuantity}株
                  </span>
                </div>
                {isBuy ? (
                  <div className="flex justify-between">
                    <span className="text-blue-700">新しい平均単価</span>
                    <span className="font-semibold text-blue-900">
                      ¥{previewAvgPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </span>
                  </div>
                ) : (
                  <div className="flex justify-between">
                    <span className="text-orange-700">売却損益</span>
                    <span className={`font-semibold ${sellProfit >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {sellProfit >= 0 ? "+" : ""}¥{sellProfit.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg font-semibold hover:bg-gray-200 transition-colors"
              disabled={loading}
            >
              キャンセル
            </button>
            <button
              type="submit"
              className={`flex-1 px-4 py-2 rounded-lg font-semibold transition-colors text-white disabled:bg-gray-300 disabled:cursor-not-allowed ${
                isBuy ? "bg-blue-600 hover:bg-blue-700" : "bg-orange-600 hover:bg-orange-700"
              }`}
              disabled={loading}
            >
              {loading ? "保存中..." : "保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
