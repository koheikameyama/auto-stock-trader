"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

interface IndividualSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  stockId: string;
  stockName: string;
  avgPurchasePrice: number;
  initialTpRate: number | null;
  initialSlRate: number | null;
  onSuccess: (tpRate: number | null, slRate: number | null) => void;
  isNewAddition?: boolean;
}

export default function IndividualSettingsModal({
  isOpen,
  onClose,
  stockId,
  stockName,
  avgPurchasePrice,
  initialTpRate,
  initialSlRate,
  onSuccess,
  isNewAddition = false,
}: IndividualSettingsModalProps) {
  const router = useRouter();
  const t = useTranslations('stocks.detail');

  // ユーザー入力（％）
  const [tpRate, setTpRate] = useState<string>("");
  const [slRate, setSlRate] = useState<string>("");

  // ユーザー入力（金額）
  const [tpPrice, setTpPrice] = useState<string>("");
  const [slPrice, setSlPrice] = useState<string>("");

  const [saving, setSaving] = useState(false);
  const [loadingDefaults, setLoadingDefaults] = useState(false);

  // 率→価格の変換
  const calcPrice = (rate: number): number => {
    return Math.round(avgPurchasePrice * (1 + rate / 100));
  };

  // 価格→率の変換
  const calcRate = (price: number): number => {
    return Math.round(((price - avgPurchasePrice) / avgPurchasePrice) * 1000) / 10;
  };

  // 初期値のセット
  useEffect(() => {
    if (isOpen) {
      setTpRate(initialTpRate != null ? String(initialTpRate) : "");
      setSlRate(initialSlRate != null ? String(initialSlRate) : "");

      if (initialTpRate != null && avgPurchasePrice > 0) {
        setTpPrice(String(calcPrice(initialTpRate)));
      } else {
        setTpPrice("");
      }
      if (initialSlRate != null && avgPurchasePrice > 0) {
        setSlPrice(String(calcPrice(initialSlRate)));
      } else {
        setSlPrice("");
      }
    }
  }, [isOpen, initialTpRate, initialSlRate]);

  // 率入力のハンドラ（%→¥連動）
  const handleTpRateChange = (value: string) => {
    setTpRate(value);
    if (value && !isNaN(Number(value)) && avgPurchasePrice > 0) {
      setTpPrice(String(calcPrice(Number(value))));
    } else {
      setTpPrice("");
    }
  };

  const handleSlRateChange = (value: string) => {
    setSlRate(value);
    if (value && !isNaN(Number(value)) && avgPurchasePrice > 0) {
      setSlPrice(String(calcPrice(Number(value))));
    } else {
      setSlPrice("");
    }
  };

  // 金額入力のハンドラ（¥→%連動）
  const handleTpPriceChange = (value: string) => {
    setTpPrice(value);
    if (value && !isNaN(Number(value)) && avgPurchasePrice > 0) {
      setTpRate(String(calcRate(Number(value))));
    } else {
      setTpRate("");
    }
  };

  const handleSlPriceChange = (value: string) => {
    setSlPrice(value);
    if (value && !isNaN(Number(value)) && avgPurchasePrice > 0) {
      setSlRate(String(calcRate(Number(value))));
    } else {
      setSlRate("");
    }
  };

  if (!isOpen) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      const tpRateValue = tpRate ? Number(tpRate) : null;
      const slRateValue = slRate ? Number(slRate) : null;

      const response = await fetch(`/api/user-stocks/${stockId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          takeProfitRate: tpRateValue,
          stopLossRate: slRateValue,
        }),
      });

      if (!response.ok) {
        throw new Error("保存に失敗しました");
      }

      toast.success("設定を保存しました");
      onSuccess(tpRateValue, slRateValue);
      router.refresh();
      onClose();
    } catch (err) {
      console.error(err);
      toast.error("保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const handleResetToDefault = async () => {
    setLoadingDefaults(true);
    try {
      const response = await fetch("/api/settings");
      if (!response.ok) throw new Error();
      const data = await response.json();
      const settings = data.settings;

      const defaultTp = settings.targetReturnRate;
      const defaultSl = settings.stopLossRate;

      setTpRate(defaultTp != null ? String(defaultTp) : "");
      setSlRate(defaultSl != null ? String(defaultSl) : "");

      if (defaultTp != null && avgPurchasePrice > 0) {
        setTpPrice(String(calcPrice(defaultTp)));
      } else {
        setTpPrice("");
      }
      if (defaultSl != null && avgPurchasePrice > 0) {
        setSlPrice(String(calcPrice(defaultSl)));
      } else {
        setSlPrice("");
      }

      toast.success(t('defaultsLoaded'));
    } catch {
      toast.error(t('defaultsLoadFailed'));
    } finally {
      setLoadingDefaults(false);
    }
  };

  // 差額の計算
  const tpDiff = tpPrice && !isNaN(Number(tpPrice)) ? Number(tpPrice) - avgPurchasePrice : null;
  const slDiff = slPrice && !isNaN(Number(slPrice)) ? Number(slPrice) - avgPurchasePrice : null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6">
        <div className="flex justify-between items-center mb-2">
          <h3 className="text-lg font-bold text-gray-900">
            {isNewAddition ? "🎉 購入完了！" : "🎯 利確・損切り設定"}
          </h3>
          {!isNewAddition && (
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors"
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
          )}
        </div>

        <div className="mb-4">
          <p className="text-sm font-semibold text-blue-600 mb-1">
            {stockName}
          </p>
          <p className="text-xs text-gray-500 mb-2">
            {t('averagePrice')}: ¥{avgPurchasePrice.toLocaleString()}
          </p>
          <p className="text-sm text-gray-600">
            {isNewAddition
              ? t('settingsDescriptionNew')
              : t('settingsDescriptionEdit')}
          </p>
        </div>

        {!isNewAddition && (
          <div className="mb-4 text-right">
            <button
              onClick={handleResetToDefault}
              disabled={loadingDefaults}
              className="text-xs text-gray-500 hover:text-blue-600 underline disabled:text-gray-300 transition-colors"
            >
              {loadingDefaults ? t('loadingDefaults') : t('resetToDefault')}
            </button>
          </div>
        )}

        <div className="space-y-5 mb-6">
          {/* 売却目標 */}
          <div className="p-3 bg-green-50/50 rounded-lg border border-green-100">
            <label className="block text-sm font-bold text-green-800 mb-2">
              {t('sellTargetLine')}
            </label>
            <div className="space-y-2">
              {/* %入力 */}
              <div>
                <label className="block text-[10px] text-gray-500 uppercase font-bold mb-1">
                  {t('rateInput')}
                </label>
                <div className="relative">
                  <input
                    type="number"
                    step="0.1"
                    value={tpRate}
                    onChange={(e) => handleTpRateChange(e.target.value)}
                    placeholder="10"
                    className="w-full pr-7 pl-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-green-500 focus:border-green-500 text-sm"
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">
                    %
                  </span>
                </div>
              </div>
              {/* 金額入力 */}
              <div>
                <label className="block text-[10px] text-gray-500 uppercase font-bold mb-1">
                  {t('priceInput')}
                </label>
                <div className="relative">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">
                    ¥
                  </span>
                  <input
                    type="number"
                    step="1"
                    value={tpPrice}
                    onChange={(e) => handleTpPriceChange(e.target.value)}
                    placeholder={avgPurchasePrice > 0 ? String(Math.round(avgPurchasePrice * 1.1)) : ""}
                    className="w-full pr-3 pl-7 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-green-500 focus:border-green-500 text-sm"
                  />
                </div>
              </div>
              {tpDiff !== null && (
                <p className={`text-[11px] font-medium ${tpDiff >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                  ({tpDiff >= 0 ? t('profitLabel') : t('lossLabel')}: {tpDiff >= 0 ? '+' : ''}{tpDiff.toLocaleString()}{t('yen')})
                </p>
              )}
            </div>
          </div>

          {/* 撤退ライン */}
          <div className="p-3 bg-red-50/50 rounded-lg border border-red-100">
            <label className="block text-sm font-bold text-red-800 mb-2">
              {t('exitLine')}
            </label>
            <div className="space-y-2">
              {/* %入力 */}
              <div>
                <label className="block text-[10px] text-gray-500 uppercase font-bold mb-1">
                  {t('rateInput')}
                </label>
                <div className="relative">
                  <input
                    type="number"
                    step="0.1"
                    value={slRate}
                    onChange={(e) => handleSlRateChange(e.target.value)}
                    placeholder="-5"
                    className="w-full pr-7 pl-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-red-500 focus:border-red-500 text-sm"
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">
                    %
                  </span>
                </div>
              </div>
              {/* 金額入力 */}
              <div>
                <label className="block text-[10px] text-gray-500 uppercase font-bold mb-1">
                  {t('priceInput')}
                </label>
                <div className="relative">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">
                    ¥
                  </span>
                  <input
                    type="number"
                    step="1"
                    value={slPrice}
                    onChange={(e) => handleSlPriceChange(e.target.value)}
                    placeholder={avgPurchasePrice > 0 ? String(Math.round(avgPurchasePrice * 0.95)) : ""}
                    className="w-full pr-3 pl-7 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-red-500 focus:border-red-500 text-sm"
                  />
                </div>
              </div>
              {slDiff !== null && (
                <p className={`text-[11px] font-medium ${slDiff >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                  ({slDiff >= 0 ? t('profitLabel') : t('lossLabel')}: {slDiff >= 0 ? '+' : ''}{slDiff.toLocaleString()}{t('yen')})
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="flex gap-2">
          {!isNewAddition && (
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm"
            >
              {t('cancel')}
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className={`flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-bold text-sm ${isNewAddition ? "w-full" : ""}`}
          >
            {saving
              ? t('saving')
              : isNewAddition
                ? t('saveNewAddition')
                : t('save')}
          </button>
        </div>

        {isNewAddition && (
          <button
            onClick={onClose}
            className="w-full mt-3 text-sm text-gray-500 hover:text-gray-700 text-center"
          >
            {t('skipForNow')}
          </button>
        )}
      </div>
    </div>
  );
}
