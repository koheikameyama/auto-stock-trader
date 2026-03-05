import { NextRequest, NextResponse } from "next/server"
import pLimit from "p-limit"
import { prisma } from "@/lib/prisma"
import webpush from "web-push"

// 通知処理の同時実行数制限
const NOTIFICATION_CONCURRENCY_LIMIT = 10

// VAPID設定を初期化
let vapidInitialized = false
function initVapid() {
  if (!vapidInitialized && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || "mailto:noreply@stock-buddy.net",
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    )
    vapidInitialized = true
  }
}

interface NotificationInput {
  userId: string
  type: "price_alert" | "plunge" | "stop_loss" | "profit_milestone" | "market_alert" | "daily_highlights" | "delisting_warning"
  stockId?: string
  title: string
  body: string
  url?: string
  triggerPrice?: number
  targetPrice?: number
  changeRate?: number
}

/**
 * POST /api/notifications/send
 * 株価アラート通知を送信（GitHub Actions から呼び出し）
 */
export async function POST(request: NextRequest) {
  initVapid()

  try {
    // CRON_SECRETで認証
    const authHeader = request.headers.get("authorization")
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { notifications } = (await request.json()) as { notifications: NotificationInput[] }

    if (!notifications || !Array.isArray(notifications)) {
      return NextResponse.json({ error: "notifications array is required" }, { status: 400 })
    }

    const results = {
      created: 0,
      pushSent: 0,
      skipped: 0,
      errors: [] as string[],
    }

    // 重複チェック用: 今日の0時
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    // 通知処理を並列実行
    const limit = pLimit(NOTIFICATION_CONCURRENCY_LIMIT)

    const tasks = notifications.map((notif) =>
      limit(async () => {
        try {
          // 重複チェック: 同じユーザー・銘柄・タイプの通知は1日1回まで
          const existing = await prisma.notification.findFirst({
            where: {
              userId: notif.userId,
              stockId: notif.stockId || undefined,
              type: notif.type,
              createdAt: { gte: today },
            },
          })

          if (existing) {
            results.skipped++
            return
          }

          // DB保存
          const created = await prisma.notification.create({
            data: {
              userId: notif.userId,
              type: notif.type,
              stockId: notif.stockId || null,
              title: notif.title,
              body: notif.body,
              url: notif.url || null,
              triggerPrice: notif.triggerPrice || null,
              targetPrice: notif.targetPrice || null,
              changeRate: notif.changeRate || null,
            },
          })
          results.created++

          // プッシュ通知送信
          const subscriptions = await prisma.pushSubscription.findMany({
            where: { userId: notif.userId },
          })

          // プッシュ送信も並列化
          const pushTasks = subscriptions.map(async (sub) => {
            try {
              await webpush.sendNotification(
                {
                  endpoint: sub.endpoint,
                  keys: { p256dh: sub.p256dh, auth: sub.auth },
                },
                JSON.stringify({
                  title: notif.title,
                  body: notif.body,
                  url: notif.url || "/notifications",
                })
              )
              results.pushSent++

              // プッシュ送信済みフラグを更新
              await prisma.notification.update({
                where: { id: created.id },
                data: { isPushSent: true },
              })
            } catch (pushError: unknown) {
              const error = pushError as { statusCode?: number; message?: string }
              // 410 Gone: 購読が無効になった場合は削除
              if (error.statusCode === 410) {
                await prisma.pushSubscription.delete({ where: { id: sub.id } })
              }
              results.errors.push(error.message || "Unknown push error")
            }
          })

          await Promise.all(pushTasks)
        } catch (error: unknown) {
          const err = error as { message?: string }
          results.errors.push(err.message || "Unknown error")
        }
      })
    )

    await Promise.all(tasks)

    return NextResponse.json(results)
  } catch (error) {
    console.error("Error sending notifications:", error)
    return NextResponse.json(
      { error: "Failed to send notifications" },
      { status: 500 }
    )
  }
}
