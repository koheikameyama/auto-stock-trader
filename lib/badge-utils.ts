// バッジ用のlocalStorageユーティリティ

const STORAGE_KEY = "stock-buddy-last-seen"

export type BadgeKey =
  | "dashboard"
  | "my-stocks"
  | "news"
  | "ai-report"

interface LastSeenData {
  dashboard?: string
  "my-stocks"?: string
  news?: string
  "ai-report"?: string
}

// 最終閲覧時刻を取得
export function getLastSeen(key: BadgeKey): Date | null {
  if (typeof window === "undefined") return null

  try {
    const data = localStorage.getItem(STORAGE_KEY)
    if (!data) return null

    const parsed: LastSeenData = JSON.parse(data)
    const timestamp = parsed[key]
    return timestamp ? new Date(timestamp) : null
  } catch {
    return null
  }
}

// 最終閲覧時刻を更新
export function markAsSeen(key: BadgeKey): void {
  if (typeof window === "undefined") return

  try {
    const data = localStorage.getItem(STORAGE_KEY)
    const parsed: LastSeenData = data ? JSON.parse(data) : {}

    parsed[key] = new Date().toISOString()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed))
  } catch {
    // localStorage error - ignore
  }
}

// 全ての最終閲覧時刻を取得
export function getAllLastSeen(): LastSeenData {
  if (typeof window === "undefined") return {}

  try {
    const data = localStorage.getItem(STORAGE_KEY)
    return data ? JSON.parse(data) : {}
  } catch {
    return {}
  }
}
