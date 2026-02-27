"use client"

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
} from "react"
import { getAllLastSeen, markAsSeen, BadgeKey } from "@/lib/badge-utils"

interface BadgeState {
  dashboard: boolean
  "my-stocks": boolean
  news: boolean
  "ai-report": boolean
  menu: boolean
}

interface BadgeContextType {
  badges: BadgeState
  markPageSeen: (key: BadgeKey) => void
  refreshBadges: () => void
}

const defaultBadges: BadgeState = {
  dashboard: false,
  "my-stocks": false,
  news: false,
  "ai-report": false,
  menu: false,
}

const BadgeContext = createContext<BadgeContextType>({
  badges: defaultBadges,
  markPageSeen: () => {},
  refreshBadges: () => {},
})

export function BadgeProvider({ children }: { children: ReactNode }) {
  const [badges, setBadges] = useState<BadgeState>(defaultBadges)

  const fetchBadges = useCallback(async () => {
    try {
      const lastSeen = getAllLastSeen()

      // クエリパラメータを構築
      const params = new URLSearchParams()
      if (lastSeen.dashboard) params.set("dashboard", lastSeen.dashboard)
      if (lastSeen["my-stocks"]) params.set("my-stocks", lastSeen["my-stocks"])
      if (lastSeen.news) params.set("news", lastSeen.news)
      if (lastSeen["ai-report"]) params.set("ai-report", lastSeen["ai-report"])

      const response = await fetch(`/api/badges?${params.toString()}`)
      if (!response.ok) return

      const data = await response.json()
      setBadges(data)
    } catch (error) {
      console.error("Failed to fetch badges:", error)
    }
  }, [])

  // 初回マウント時とフォーカス時にバッジを取得
  useEffect(() => {
    fetchBadges()

    // ウィンドウがフォーカスされたときに更新
    const handleFocus = () => fetchBadges()
    window.addEventListener("focus", handleFocus)

    // 1分ごとに更新
    const interval = setInterval(fetchBadges, 60000)

    return () => {
      window.removeEventListener("focus", handleFocus)
      clearInterval(interval)
    }
  }, [fetchBadges])

  const markPageSeen = useCallback(
    (key: BadgeKey) => {
      markAsSeen(key)
      // バッジを即座に更新
      setBadges((prev) => {
        const newBadges = { ...prev, [key]: false }
        // menuは ai-report の状態
        if (key === "ai-report") {
          newBadges.menu = newBadges["ai-report"]
        }
        return newBadges
      })
    },
    []
  )

  const refreshBadges = useCallback(() => {
    fetchBadges()
  }, [fetchBadges])

  return (
    <BadgeContext.Provider value={{ badges, markPageSeen, refreshBadges }}>
      {children}
    </BadgeContext.Provider>
  )
}

export function useBadges() {
  return useContext(BadgeContext)
}
