"use client"

import { useEffect, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import Footer from "@/app/components/Footer"
import BottomNavigation from "@/app/components/BottomNavigation"

type Notification = {
  id: string
  type: "ideal_entry_price" | "buy_recommendation" | "surge" | "plunge" | "sell_target" | "stop_loss"
  stockId: string | null
  stock: {
    id: string
    name: string
    tickerCode: string
  } | null
  title: string
  body: string
  url: string | null
  triggerPrice: number | null
  targetPrice: number | null
  changeRate: number | null
  isRead: boolean
  createdAt: string
  readAt: string | null
}

export default function NotificationsPage() {
  const t = useTranslations('notifications')
  const tTypes = useTranslations('notifications.notificationTypes')
  const tBadges = useTranslations('notifications.sourceBadges')
  const tFilters = useTranslations('notifications.filters')
  const tToast = useTranslations('notifications.toast')
  const tTime = useTranslations('notifications.timeFormat')
  const router = useRouter()

  const typeConfig: Record<string, { icon: string; color: string; label: string }> = {
    ideal_entry_price: { icon: tTypes('ideal_entry_price.icon'), color: "bg-green-100 text-green-800", label: tTypes('ideal_entry_price.label') },
    buy_recommendation: { icon: tTypes('buy_recommendation.icon'), color: "bg-green-100 text-green-800", label: tTypes('buy_recommendation.label') },
    surge: { icon: tTypes('surge.icon'), color: "bg-blue-100 text-blue-800", label: tTypes('surge.label') },
    plunge: { icon: tTypes('plunge.icon'), color: "bg-red-100 text-red-800", label: tTypes('plunge.label') },
    sell_target: { icon: tTypes('sell_target.icon'), color: "bg-purple-100 text-purple-800", label: tTypes('sell_target.label') },
    stop_loss: { icon: tTypes('stop_loss.icon'), color: "bg-orange-100 text-orange-800", label: tTypes('stop_loss.label') },
    buy_target: { icon: tTypes('buy_target.icon'), color: "bg-green-100 text-green-800", label: tTypes('buy_target.label') },
    profit_milestone: { icon: tTypes('profit_milestone.icon'), color: "bg-emerald-100 text-emerald-800", label: tTypes('profit_milestone.label') },
  }

  // タイトルから銘柄の所属（保有/気になる）を判断
  const getSourceBadge = (title: string, type: string) => {
    if (type === "sell_target" || type === "stop_loss" || type === "profit_milestone") {
      return { label: tBadges('portfolio'), color: "bg-gray-100 text-gray-600" }
    }
    if (title.includes("保有銘柄")) {
      return { label: tBadges('portfolio'), color: "bg-gray-100 text-gray-600" }
    }
    if (title.includes("注目銘柄")) {
      return { label: tBadges('watchlist'), color: "bg-yellow-100 text-yellow-700" }
    }
    return null
  }
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [cursor, setCursor] = useState<string | null>(null)
  const [unreadCount, setUnreadCount] = useState(0)

  const fetchNotifications = useCallback(async (reset = false) => {
    try {
      const params = new URLSearchParams()
      if (unreadOnly) params.set("unreadOnly", "true")
      if (!reset && cursor) params.set("cursor", cursor)
      params.set("limit", "20")

      const response = await fetch(`/api/notifications?${params}`)
      if (!response.ok) throw new Error("Failed to fetch")

      const data = await response.json()

      if (reset) {
        setNotifications(data.notifications)
      } else {
        setNotifications((prev) => [...prev, ...data.notifications])
      }

      setHasMore(data.hasMore)
      setCursor(data.cursor)
      setUnreadCount(data.unreadCount)
    } catch (error) {
      console.error("Error fetching notifications:", error)
      toast.error(tToast('fetchError'))
    } finally {
      setLoading(false)
    }
  }, [unreadOnly, cursor, tToast])

  useEffect(() => {
    setLoading(true)
    setCursor(null)
    fetchNotifications(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadOnly])

  const handleMarkAsRead = async (id: string) => {
    try {
      const response = await fetch(`/api/notifications/${id}/read`, {
        method: "PATCH",
      })
      if (!response.ok) throw new Error("Failed to mark as read")

      setNotifications((prev) =>
        prev.map((n) =>
          n.id === id ? { ...n, isRead: true, readAt: new Date().toISOString() } : n
        )
      )
      setUnreadCount((prev) => Math.max(0, prev - 1))
    } catch (error) {
      console.error("Error marking as read:", error)
    }
  }

  const handleMarkAllAsRead = async () => {
    try {
      const response = await fetch("/api/notifications/read-all", {
        method: "POST",
      })
      if (!response.ok) throw new Error("Failed to mark all as read")

      setNotifications((prev) =>
        prev.map((n) => ({ ...n, isRead: true, readAt: new Date().toISOString() }))
      )
      setUnreadCount(0)
      toast.success(tToast('markAllSuccess'))
    } catch (error) {
      console.error("Error marking all as read:", error)
      toast.error(tToast('markAllError'))
    }
  }

  const handleNotificationClick = (notification: Notification) => {
    if (!notification.isRead) {
      handleMarkAsRead(notification.id)
    }
    if (notification.url) {
      router.push(notification.url)
    }
  }

  const formatTime = (dateString: string) => {
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMinutes = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMinutes < 1) return tTime('justNow')
    if (diffMinutes < 60) return tTime('minutesAgo', { minutes: diffMinutes })
    if (diffHours < 24) return tTime('hoursAgo', { hours: diffHours })
    if (diffDays < 7) return tTime('daysAgo', { days: diffDays })
    return date.toLocaleDateString("ja-JP", { month: "short", day: "numeric" })
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      {/* ヘッダー */}
      <div className="bg-white border-b sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold">{t('title')}</h1>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllAsRead}
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                {t('markAllAsRead')}
              </button>
            )}
          </div>

          {/* フィルター */}
          <div className="flex gap-2 mt-3">
            <button
              onClick={() => setUnreadOnly(false)}
              className={`px-3 py-1 rounded-full text-sm ${
                !unreadOnly
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-600"
              }`}
            >
              {tFilters('all')}
            </button>
            <button
              onClick={() => setUnreadOnly(true)}
              className={`px-3 py-1 rounded-full text-sm ${
                unreadOnly
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-600"
              }`}
            >
              {tFilters('unread')} {unreadCount > 0 && `(${unreadCount})`}
            </button>
          </div>
        </div>
      </div>

      {/* 通知一覧 */}
      <div className="max-w-2xl mx-auto px-4 py-4">
        {loading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <div
                key={i}
                className="bg-white rounded-lg p-4 animate-pulse"
              >
                <div className="flex gap-3">
                  <div className="w-10 h-10 bg-gray-200 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-gray-200 rounded w-3/4" />
                    <div className="h-3 bg-gray-200 rounded w-full" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : notifications.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-4xl mb-4">🔔</div>
            <p className="text-gray-500">
              {unreadOnly ? t('noUnreadNotifications') : t('noNotifications')}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {notifications.map((notification) => {
              const config = typeConfig[notification.type] || { icon: tTypes('default.icon'), color: "bg-gray-100 text-gray-800", label: tTypes('default.label') }
              const sourceBadge = getSourceBadge(notification.title, notification.type)

              return (
                <button
                  key={notification.id}
                  onClick={() => handleNotificationClick(notification)}
                  className={`w-full text-left bg-white rounded-lg p-4 shadow-sm border transition-colors ${
                    notification.isRead
                      ? "border-gray-100"
                      : "border-blue-200 bg-blue-50/30"
                  } hover:bg-gray-50`}
                >
                  <div className="flex gap-3">
                    {/* アイコン */}
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center text-lg ${config.color}`}
                    >
                      {config.icon}
                    </div>

                    {/* 内容 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-1">
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${config.color}`}
                          >
                            {config.label}
                          </span>
                          {sourceBadge && (
                            <span
                              className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${sourceBadge.color}`}
                            >
                              {sourceBadge.label}
                            </span>
                          )}
                          {!notification.isRead && (
                            <span className="ml-1 inline-block w-2 h-2 bg-blue-500 rounded-full" />
                          )}
                        </div>
                        <span className="text-xs text-gray-400 whitespace-nowrap">
                          {formatTime(notification.createdAt)}
                        </span>
                      </div>

                      <h3 className="font-medium text-gray-900 mt-1">
                        {notification.title}
                      </h3>
                      <p className="text-sm text-gray-600 mt-0.5 line-clamp-2">
                        {notification.body}
                      </p>

                      {notification.stock && (
                        <p className="text-xs text-gray-400 mt-1">
                          {notification.stock.tickerCode} - {notification.stock.name}
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}

            {/* もっと読み込む */}
            {hasMore && (
              <button
                onClick={() => fetchNotifications()}
                className="w-full py-3 text-blue-600 hover:text-blue-800 text-sm"
              >
                {t('loadMore')}
              </button>
            )}
          </div>
        )}
      </div>

      <Footer />
      <BottomNavigation />
    </div>
  )
}
