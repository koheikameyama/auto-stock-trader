"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import Footer from "@/app/components/Footer";
import BottomNavigation from "@/app/components/BottomNavigation";
import BackButton from "@/app/components/BackButton";
import { UPDATE_SCHEDULES } from "@/lib/constants";
import TermTooltip from "@/app/components/TermTooltip";

type PushSubscriptionState = {
  supported: boolean;
  subscribed: boolean;
  loading: boolean;
};

type UserSettings = {
  investmentStyle: string | null;
  investmentBudget: number | null;
  targetReturnRate: number | null;
  stopLossRate: number | null;
};

export default function SettingsPage() {
  const tPage = useTranslations('settings.page');
  const tPush = useTranslations('settings.pushNotifications');
  const tSchedule = useTranslations('settings.notificationSchedule');
  const tStyle = useTranslations('settings.investmentStyleSection');
  const tBudget = useTranslations('settings.investmentBudget');
  const tSales = useTranslations('settings.salesTargets');
  const tTarget = useTranslations('settings.targetReturn');
  const tStopLoss = useTranslations('settings.stopLoss');
  const tToast = useTranslations('settings.toast');
  const tTooltip = useTranslations('settings.tooltips');

  const TARGET_RETURN_OPTIONS = [
    { value: 5, label: tTarget('5.label'), description: tTarget('5.description') },
    { value: 10, label: tTarget('10.label'), description: tTarget('10.description') },
    { value: 15, label: tTarget('15.label'), description: tTarget('15.description') },
    { value: 20, label: tTarget('20.label'), description: tTarget('20.description') },
    { value: 30, label: tTarget('30.label'), description: tTarget('30.description') },
  ];

  const STOP_LOSS_OPTIONS = [
    { value: -5, label: tStopLoss('-5.label'), description: tStopLoss('-5.description') },
    { value: -10, label: tStopLoss('-10.label'), description: tStopLoss('-10.description') },
    { value: -15, label: tStopLoss('-15.label'), description: tStopLoss('-15.description') },
    { value: -20, label: tStopLoss('-20.label'), description: tStopLoss('-20.description') },
  ];

  const INVESTMENT_STYLE_OPTIONS = [
    {
      value: "CONSERVATIVE",
      label: tStyle('conservative.label'),
      description: tStyle('conservative.description'),
      icon: tStyle('conservative.icon'),
    },
    {
      value: "BALANCED",
      label: tStyle('balanced.label'),
      description: tStyle('balanced.description'),
      icon: tStyle('balanced.icon'),
    },
    {
      value: "AGGRESSIVE",
      label: tStyle('aggressive.label'),
      description: tStyle('aggressive.description'),
      icon: tStyle('aggressive.icon'),
    },
  ];

  const INVESTMENT_STYLE_DEFAULTS: Record<string, { stopLossRate: number; targetReturnRate: number }> = {
    CONSERVATIVE: { stopLossRate: -5, targetReturnRate: 5 },
    BALANCED: { stopLossRate: -10, targetReturnRate: 10 },
    AGGRESSIVE: { stopLossRate: -20, targetReturnRate: 20 },
  };

  const BUDGET_OPTIONS = [
    { value: 100000, label: tBudget('100k.label'), description: tBudget('100k.description') },
    { value: 300000, label: tBudget('300k.label'), description: tBudget('300k.description') },
    { value: 500000, label: tBudget('500k.label'), description: tBudget('500k.description') },
    { value: 1000000, label: tBudget('1m.label'), description: tBudget('1m.description') },
  ];

  const [pushState, setPushState] = useState<PushSubscriptionState>({
    supported: false,
    subscribed: false,
    loading: true,
  });
  const [settings, setSettings] = useState<UserSettings>({
    investmentStyle: null,
    investmentBudget: null,
    targetReturnRate: null,
    stopLossRate: null,
  });
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [showCustomBudget, setShowCustomBudget] = useState(false);
  const [customBudgetText, setCustomBudgetText] = useState("");
  const [showCustomTargetReturn, setShowCustomTargetReturn] = useState(false);
  const [customTargetReturnText, setCustomTargetReturnText] = useState("");
  const [showCustomStopLoss, setShowCustomStopLoss] = useState(false);
  const [customStopLossText, setCustomStopLossText] = useState("");

  useEffect(() => {
    checkPushNotificationStatus();
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const response = await fetch("/api/settings");
      if (response.ok) {
        const data = await response.json();
        if (data.settings) {
          setSettings({
            investmentStyle: data.settings.investmentStyle,
            investmentBudget: data.settings.investmentBudget,
            targetReturnRate: data.settings.targetReturnRate,
            stopLossRate: data.settings.stopLossRate,
          });
          // プリセット以外の金額が設定されていればカスタム入力を表示
          const budget = data.settings.investmentBudget;
          if (
            budget !== null &&
            !BUDGET_OPTIONS.some((o) => o.value === budget)
          ) {
            setShowCustomBudget(true);
            setCustomBudgetText(String(Math.round(budget / 10000)));
          }
          // プリセット以外の利確ラインが設定されていればカスタム入力を表示
          const targetReturn = data.settings.targetReturnRate;
          if (
            targetReturn !== null &&
            !TARGET_RETURN_OPTIONS.some((o) => o.value === targetReturn)
          ) {
            setShowCustomTargetReturn(true);
            setCustomTargetReturnText(String(targetReturn));
          }
          // プリセット以外の損切りラインが設定されていればカスタム入力を表示
          const stopLoss = data.settings.stopLossRate;
          if (
            stopLoss !== null &&
            !STOP_LOSS_OPTIONS.some((o) => o.value === stopLoss)
          ) {
            setShowCustomStopLoss(true);
            setCustomStopLossText(String(stopLoss));
          }
        }
      }
    } catch (error) {
      console.error("Error fetching settings:", error);
    } finally {
      setSettingsLoading(false);
    }
  };

  const handleCustomBudgetSave = () => {
    const 万円 = parseInt(customBudgetText, 10);
    if (!isNaN(万円) && 万円 > 0) {
      saveSettings({ investmentBudget: 万円 * 10000 });
    }
  };

  const handleCustomTargetReturnSave = () => {
    const val = parseFloat(customTargetReturnText);
    if (!isNaN(val) && val !== 0) {
      saveSettings({ targetReturnRate: val });
    }
  };

  const handleCustomStopLossSave = () => {
    const val = parseFloat(customStopLossText);
    if (!isNaN(val) && val !== 0) {
      saveSettings({ stopLossRate: val });
    }
  };

  const saveSettings = async (updates: Partial<UserSettings>) => {
    setSavingSettings(true);
    try {
      const newSettings = { ...settings, ...updates };

      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          investmentStyle: newSettings.investmentStyle || "BALANCED",
          investmentBudget: newSettings.investmentBudget,
          targetReturnRate: newSettings.targetReturnRate,
          stopLossRate: newSettings.stopLossRate,
        }),
      });

      if (response.ok) {
        setSettings(newSettings);
        toast.success(tToast('saveSuccess'));
      } else {
        toast.error(tToast('saveError'));
      }
    } catch (error) {
      console.error("Error saving settings:", error);
      toast.error(tToast('saveError'));
    } finally {
      setSavingSettings(false);
    }
  };

  const checkPushNotificationStatus = async () => {
    try {
      // Check if push notifications are supported
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setPushState({ supported: false, subscribed: false, loading: false });
        return;
      }

      // Register service worker
      const registration = await navigator.serviceWorker.register("/sw.js");

      // Check if already subscribed
      const subscription = await registration.pushManager.getSubscription();

      setPushState({
        supported: true,
        subscribed: !!subscription,
        loading: false,
      });
    } catch (error) {
      console.error("Error checking push notification status:", error);
      setPushState({ supported: false, subscribed: false, loading: false });
    }
  };

  const togglePushNotifications = async () => {
    try {
      setPushState({ ...pushState, loading: true });

      const registration = await navigator.serviceWorker.ready;

      if (pushState.subscribed) {
        // Unsubscribe
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          await subscription.unsubscribe();
          await fetch("/api/push/subscribe", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: subscription.endpoint }),
          });
        }
        setPushState({ ...pushState, subscribed: false, loading: false });
        toast.success(tPush('successOff'));
      } else {
        // Subscribe
        const response = await fetch("/api/push/subscribe");
        const { publicKey } = await response.json();

        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: publicKey,
        });

        await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(subscription.toJSON()),
        });

        setPushState({ ...pushState, subscribed: true, loading: false });
        toast.success(tPush('successOn'));
      }
    } catch (error) {
      console.error("Error toggling push notifications:", error);
      toast.error(tPush('error'));
      setPushState({ ...pushState, loading: false });
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white">
      {/* シンプルなヘッダー */}
      <header className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4">
          <div className="flex items-center gap-2">
            <Link href="/dashboard" className="flex items-center gap-2">
              <span className="text-2xl">📊</span>
              <span className="text-xl font-bold text-gray-900">
                {tPage('appName')}
              </span>
            </Link>
          </div>
        </div>
      </header>

      <div className="py-8 sm:py-12 px-4">
        <div className="max-w-3xl mx-auto">
          <BackButton href="/dashboard" label={tPage('backButton')} />
          <div className="mb-6 sm:mb-8">
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-2">
              {tPage('title')}
            </h1>
            <p className="text-sm sm:text-base text-gray-600">
              {tPage('description')}
            </p>
          </div>

          <div className="bg-white rounded-2xl shadow-md p-6 sm:p-8 space-y-6">
            {/* プッシュ通知設定 */}
            <div>
              <h2 className="text-lg sm:text-xl font-bold text-gray-900 mb-2">
                {tPush('title')}
              </h2>
              <p className="text-sm text-gray-600 mb-4">
                {tPush('description')}
              </p>
              {!pushState.supported ? (
                <div className="p-4 rounded-xl border-2 border-gray-200 bg-gray-50">
                  <p className="text-gray-600 text-sm sm:text-base">
                    {tPush('notSupported')}
                  </p>
                </div>
              ) : (
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-4 sm:p-5 rounded-xl border-2 border-gray-200 bg-gray-50">
                  <div>
                    <div className="font-semibold text-gray-900 text-base sm:text-lg">
                      {pushState.subscribed ? tPush('statusOn') : tPush('statusOff')}
                    </div>
                    <div className="text-sm text-gray-600 mt-1">
                      {pushState.subscribed
                        ? tPush('statusOnDescription')
                        : tPush('statusOffDescription')}
                    </div>
                  </div>
                  <button
                    onClick={togglePushNotifications}
                    disabled={pushState.loading}
                    className={`w-full sm:w-auto px-6 py-3 rounded-lg font-semibold transition-colors text-sm sm:text-base ${
                      pushState.subscribed
                        ? "bg-gray-200 text-gray-700 hover:bg-gray-300"
                        : "bg-blue-600 text-white hover:bg-blue-700"
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    {pushState.loading
                      ? tPage('saving')
                      : pushState.subscribed
                        ? tPush('turnOff')
                        : tPush('turnOn')}
                  </button>
                </div>
              )}
            </div>

            {/* 通知スケジュール */}
            <div className="bg-blue-50 rounded-xl p-4 sm:p-5">
              <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                <span className="text-lg sm:text-xl">📅</span>
                <span className="text-sm sm:text-base">{tSchedule('title')}</span>
              </h3>
              <ul className="space-y-2 text-sm sm:text-base text-gray-700">
                <li className="flex items-start gap-2">
                  <span>•</span>
                  <span>
                    <strong>{UPDATE_SCHEDULES.STOCK_ANALYSIS}</strong> -
                    {tSchedule('stockAnalysis')}
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span>•</span>
                  <span>
                    <strong>{UPDATE_SCHEDULES.PERSONAL_RECOMMENDATIONS}</strong>{" "}
                    - {tSchedule('personalRecommendations')}
                  </span>
                </li>
              </ul>
            </div>

            {/* 区切り線 */}
            <hr className="border-gray-200" />

            {/* 投資スタイル設定 */}
            <div>
              <h2 className="text-lg sm:text-xl font-bold text-gray-900 mb-2">
                {tStyle('title')}
              </h2>
              <p className="text-sm text-gray-600 mb-4">
                {tStyle('description')}
              </p>

              {settingsLoading ? (
                <div className="p-4 rounded-xl border-2 border-gray-200 bg-gray-50 text-center">
                  <p className="text-gray-600">{tPage('loading')}</p>
                </div>
              ) : (
                <div className="space-y-6">
                  {/* 投資スタイル */}
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                      <span className="text-lg">🎯</span>
                      <span className="flex items-center">
                        {tStyle('sectionTitle')}
                        <TermTooltip id="investment-style" text={tTooltip('investmentStyle')} />
                      </span>
                    </h3>
                    <div className="grid grid-cols-1 gap-3">
                      {INVESTMENT_STYLE_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          onClick={() => {
                            const defaults = INVESTMENT_STYLE_DEFAULTS[option.value];
                            setShowCustomTargetReturn(false);
                            setShowCustomStopLoss(false);
                            saveSettings({ investmentStyle: option.value, ...defaults });
                          }}
                          disabled={savingSettings}
                          className={`p-4 rounded-lg border-2 text-left transition-all ${
                            settings.investmentStyle === option.value
                              ? "border-blue-500 bg-blue-50"
                              : "border-gray-200 hover:border-gray-300 bg-white"
                          } disabled:opacity-50`}
                        >
                          <div className="flex items-center gap-3">
                            <div className="text-2xl">{option.icon}</div>
                            <div className="flex-1">
                              <div
                                className={`font-bold text-sm ${
                                  settings.investmentStyle === option.value
                                    ? "text-blue-600"
                                    : "text-gray-900"
                                }`}
                              >
                                {option.label}
                              </div>
                              <div className="text-xs text-gray-600 mt-1 flex items-center flex-wrap">
                                {option.description}
                                {option.value === "BALANCED" && (
                                  <TermTooltip id="risk-reward" text={tTooltip('riskAndReward')} />
                                )}
                              </div>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 投資資金 */}
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                      <span className="text-lg">💰</span>
                      <span>{tBudget('title')}</span>
                    </h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {BUDGET_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          onClick={() => {
                            setShowCustomBudget(false);
                            saveSettings({ investmentBudget: option.value });
                          }}
                          disabled={savingSettings}
                          className={`p-3 rounded-lg border-2 text-center transition-all ${
                            settings.investmentBudget === option.value &&
                            !showCustomBudget
                              ? "border-blue-500 bg-blue-50"
                              : "border-gray-200 hover:border-gray-300 bg-white"
                          } disabled:opacity-50`}
                        >
                          <div
                            className={`font-bold text-sm ${
                              settings.investmentBudget === option.value &&
                              !showCustomBudget
                                ? "text-blue-600"
                                : "text-gray-900"
                            }`}
                          >
                            {option.label}
                          </div>
                          <div className="text-xs text-gray-500">
                            {option.description}
                          </div>
                        </button>
                      ))}
                      <button
                        onClick={() => {
                          setShowCustomBudget(true);
                          setCustomBudgetText(
                            settings.investmentBudget &&
                              !BUDGET_OPTIONS.some(
                                (o) => o.value === settings.investmentBudget,
                              )
                              ? String(
                                  Math.round(settings.investmentBudget / 10000),
                                )
                              : "",
                          );
                        }}
                        disabled={savingSettings}
                        className={`p-3 rounded-lg border-2 text-center transition-all ${
                          showCustomBudget
                            ? "border-blue-500 bg-blue-50"
                            : "border-gray-200 hover:border-gray-300 bg-white"
                        } disabled:opacity-50`}
                      >
                        <div
                          className={`font-bold text-sm ${showCustomBudget ? "text-blue-600" : "text-gray-900"}`}
                        >
                          {tBudget('custom.label')}
                        </div>
                        <div className="text-xs text-gray-500">{tBudget('custom.description')}</div>
                      </button>
                      <button
                        onClick={() => {
                          setShowCustomBudget(false);
                          saveSettings({ investmentBudget: null });
                        }}
                        disabled={savingSettings}
                        className={`p-3 rounded-lg border-2 text-center transition-all ${
                          settings.investmentBudget === null &&
                          !showCustomBudget
                            ? "border-gray-500 bg-gray-100"
                            : "border-gray-200 hover:border-gray-300 bg-white"
                        } disabled:opacity-50`}
                      >
                        <div className="font-bold text-sm text-gray-600">
                          {tBudget('undecided.label')}
                        </div>
                        <div className="text-xs text-gray-500">
                          {tBudget('undecided.description')}
                        </div>
                      </button>
                    </div>

                    {/* カスタム金額入力欄 */}
                    {showCustomBudget && (
                      <div className="mt-3 flex items-center gap-2">
                        <div className="flex items-center gap-1 flex-1 bg-white border-2 border-blue-300 rounded-lg px-3 py-2 focus-within:border-blue-500 transition-colors">
                          <input
                            type="number"
                            min="1"
                            value={customBudgetText}
                            onChange={(e) =>
                              setCustomBudgetText(e.target.value)
                            }
                            onKeyDown={(e) =>
                              e.key === "Enter" && handleCustomBudgetSave()
                            }
                            placeholder={tBudget('customInput.placeholder')}
                            className="flex-1 outline-none text-sm font-semibold text-gray-900 bg-transparent min-w-0"
                          />
                          <span className="text-sm text-gray-500 shrink-0">
                            {tBudget('customInput.unit')}
                          </span>
                        </div>
                        <button
                          onClick={handleCustomBudgetSave}
                          disabled={
                            savingSettings ||
                            !customBudgetText ||
                            parseInt(customBudgetText) <= 0
                          }
                          className="px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
                        >
                          {tBudget('customInput.button')}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 区切り線 */}
            <hr className="border-gray-200" />

            {/* 売却目標設定 */}
            <div>
              <h2 className="text-lg sm:text-xl font-bold text-gray-900 mb-2">
                {tSales('title')}
              </h2>
              <p className="text-sm text-gray-600 mb-4">
                {tSales('description')}
              </p>

              {settingsLoading ? (
                <div className="p-4 rounded-xl border-2 border-gray-200 bg-gray-50 text-center">
                  <p className="text-gray-600">{tPage('loading')}</p>
                </div>
              ) : (
                <div className="space-y-6">
                  {/* 目標利益率 */}
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                      <span className="text-lg">📈</span>
                      <span className="flex items-center">
                        {tTarget('title')}
                        <TermTooltip id="target-return" text={tTooltip('targetReturn')} />
                      </span>
                    </h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {TARGET_RETURN_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          onClick={() => {
                            setShowCustomTargetReturn(false);
                            saveSettings({ targetReturnRate: option.value });
                          }}
                          disabled={savingSettings}
                          className={`p-3 rounded-lg border-2 text-left transition-all ${
                            settings.targetReturnRate === option.value &&
                            !showCustomTargetReturn
                              ? "border-green-500 bg-green-50"
                              : "border-gray-200 hover:border-gray-300 bg-white"
                          } disabled:opacity-50`}
                        >
                          <div
                            className={`font-bold ${
                              settings.targetReturnRate === option.value &&
                              !showCustomTargetReturn
                                ? "text-green-600"
                                : "text-gray-900"
                            }`}
                          >
                            {option.label}
                          </div>
                          <div className="text-xs text-gray-500">
                            {option.description}
                          </div>
                        </button>
                      ))}
                      <button
                        onClick={() => {
                          setShowCustomTargetReturn(true);
                          setCustomTargetReturnText(
                            settings.targetReturnRate !== null &&
                              !TARGET_RETURN_OPTIONS.some(
                                (o) => o.value === settings.targetReturnRate,
                              )
                              ? String(settings.targetReturnRate)
                              : "",
                          );
                        }}
                        disabled={savingSettings}
                        className={`p-3 rounded-lg border-2 text-left transition-all ${
                          showCustomTargetReturn
                            ? "border-green-500 bg-green-50"
                            : "border-gray-200 hover:border-gray-300 bg-white"
                        } disabled:opacity-50`}
                      >
                        <div
                          className={`font-bold text-sm ${
                            showCustomTargetReturn
                              ? "text-green-600"
                              : "text-gray-900"
                          }`}
                        >
                          {tTarget('custom.label')}
                        </div>
                        <div className="text-xs text-gray-500">{tTarget('custom.description')}</div>
                      </button>
                      <button
                        onClick={() => {
                          setShowCustomTargetReturn(false);
                          saveSettings({ targetReturnRate: null });
                        }}
                        disabled={savingSettings}
                        className={`p-3 rounded-lg border-2 text-left transition-all ${
                          settings.targetReturnRate === null &&
                          !showCustomTargetReturn
                            ? "border-gray-500 bg-gray-100"
                            : "border-gray-200 hover:border-gray-300 bg-white"
                        } disabled:opacity-50`}
                      >
                        <div className="font-bold text-gray-600">{tTarget('none.label')}</div>
                        <div className="text-xs text-gray-500">{tTarget('none.description')}</div>
                      </button>
                    </div>
                    {/* カスタム利確ライン入力欄 */}
                    {showCustomTargetReturn && (
                      <div className="mt-3 flex items-center gap-2">
                        <div className="flex items-center gap-1 flex-1 bg-white border-2 border-green-300 rounded-lg px-3 py-2 focus-within:border-green-500 transition-colors">
                          <input
                            type="number"
                            step="0.1"
                            value={customTargetReturnText}
                            onChange={(e) =>
                              setCustomTargetReturnText(e.target.value)
                            }
                            onKeyDown={(e) =>
                              e.key === "Enter" &&
                              handleCustomTargetReturnSave()
                            }
                            placeholder={tTarget('customInput.placeholder')}
                            className="flex-1 outline-none text-sm font-semibold text-gray-900 bg-transparent min-w-0"
                          />
                          <span className="text-sm text-gray-500 shrink-0">
                            {tTarget('customInput.unit')}
                          </span>
                        </div>
                        <button
                          onClick={handleCustomTargetReturnSave}
                          disabled={
                            savingSettings ||
                            !customTargetReturnText ||
                            parseFloat(customTargetReturnText) === 0 ||
                            isNaN(parseFloat(customTargetReturnText))
                          }
                          className="px-4 py-2 bg-green-600 text-white text-sm font-semibold rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
                        >
                          {tTarget('customInput.button')}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* 損切りライン */}
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                      <span className="text-lg">📉</span>
                      <span className="flex items-center">
                        {tStopLoss('title')}
                        <TermTooltip id="stop-loss" text={tTooltip('stopLossLine')} />
                        <TermTooltip id="reverse-stop" text={tTooltip('reverseStopOrder')} />
                      </span>
                    </h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {STOP_LOSS_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          onClick={() => {
                            setShowCustomStopLoss(false);
                            saveSettings({ stopLossRate: option.value });
                          }}
                          disabled={savingSettings}
                          className={`p-3 rounded-lg border-2 text-left transition-all ${
                            settings.stopLossRate === option.value &&
                            !showCustomStopLoss
                              ? "border-red-500 bg-red-50"
                              : "border-gray-200 hover:border-gray-300 bg-white"
                          } disabled:opacity-50`}
                        >
                          <div
                            className={`font-bold ${
                              settings.stopLossRate === option.value &&
                              !showCustomStopLoss
                                ? "text-red-600"
                                : "text-gray-900"
                            }`}
                          >
                            {option.label}
                          </div>
                          <div className="text-xs text-gray-500">
                            {option.description}
                          </div>
                        </button>
                      ))}
                      <button
                        onClick={() => {
                          setShowCustomStopLoss(true);
                          setCustomStopLossText(
                            settings.stopLossRate !== null &&
                              !STOP_LOSS_OPTIONS.some(
                                (o) => o.value === settings.stopLossRate,
                              )
                              ? String(settings.stopLossRate!)
                              : "",
                          );
                        }}
                        disabled={savingSettings}
                        className={`p-3 rounded-lg border-2 text-left transition-all ${
                          showCustomStopLoss
                            ? "border-red-500 bg-red-50"
                            : "border-gray-200 hover:border-gray-300 bg-white"
                        } disabled:opacity-50`}
                      >
                        <div
                          className={`font-bold text-sm ${
                            showCustomStopLoss
                              ? "text-red-600"
                              : "text-gray-900"
                          }`}
                        >
                          {tStopLoss('custom.label')}
                        </div>
                        <div className="text-xs text-gray-500">{tStopLoss('custom.description')}</div>
                      </button>
                      <button
                        onClick={() => {
                          setShowCustomStopLoss(false);
                          saveSettings({ stopLossRate: null });
                        }}
                        disabled={savingSettings}
                        className={`p-3 rounded-lg border-2 text-left transition-all ${
                          settings.stopLossRate === null && !showCustomStopLoss
                            ? "border-gray-500 bg-gray-100"
                            : "border-gray-200 hover:border-gray-300 bg-white"
                        } disabled:opacity-50`}
                      >
                        <div className="font-bold text-gray-600">{tStopLoss('none.label')}</div>
                        <div className="text-xs text-gray-500">{tStopLoss('none.description')}</div>
                      </button>
                    </div>
                    {/* カスタム損切りライン入力欄 */}
                    {showCustomStopLoss && (
                      <div className="mt-3 flex items-center gap-2">
                        <div className="flex items-center gap-1 flex-1 bg-white border-2 border-red-300 rounded-lg px-3 py-2 focus-within:border-red-500 transition-colors">
                          <input
                            type="number"
                            step="0.1"
                            value={customStopLossText}
                            onChange={(e) =>
                              setCustomStopLossText(e.target.value)
                            }
                            onKeyDown={(e) =>
                              e.key === "Enter" && handleCustomStopLossSave()
                            }
                            placeholder={tStopLoss('customInput.placeholder')}
                            className="flex-1 outline-none text-sm font-semibold text-gray-900 bg-transparent min-w-0"
                          />
                          <span className="text-sm text-gray-500 shrink-0">
                            {tStopLoss('customInput.unit')}
                          </span>
                        </div>
                        <button
                          onClick={handleCustomStopLossSave}
                          disabled={
                            savingSettings ||
                            !customStopLossText ||
                            parseFloat(customStopLossText) === 0 ||
                            isNaN(parseFloat(customStopLossText))
                          }
                          className="px-4 py-2 bg-red-600 text-white text-sm font-semibold rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
                        >
                          {tStopLoss('customInput.button')}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* 説明 */}
                  <div className="bg-amber-50 rounded-xl p-4">
                    <p className="text-sm text-amber-800">
                      {tSales('notice')}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <Footer />
      <BottomNavigation />
    </div>
  );
}
