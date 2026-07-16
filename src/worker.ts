/**
 * Railway Worker - 常駐プロセス
 *
 * position-monitor のみ node-cron でスケジュール実行し、
 * Hono HTTP サーバーでダッシュボードを提供する。
 * バッチジョブは /api/cron/* エンドポイント経由で cron-job.org からトリガー。
 * Railway 上で `npm start` で起動。
 */

import cron, { type ScheduledTask } from "node-cron";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import { serve } from "@hono/node-server";

dayjs.extend(utc);
dayjs.extend(timezone);

import { main as runMonitor } from "./jobs/position-monitor";
import { main as runGapupMonitor } from "./jobs/gapup-monitor";
import { main as runPSCMonitor } from "./jobs/post-surge-consolidation-monitor";
import { main as runUsEtfMonitor } from "./jobs/us-etf-monitor";
import { main as runPanicMonitor } from "./jobs/panic-monitor";
// buyback-monitor は KOH-556 で cron 停止（下の schedules 参照）。ジョブ本体は残置。
// import { main as runBuybackMonitor } from "./jobs/buyback-monitor";
import { main as runBrokerReconciliation } from "./jobs/broker-reconciliation";
import { main as runSessionHealthCheck } from "./jobs/session-health-check";
import { main as runEnsureBrokerSL } from "./jobs/ensure-broker-sl";
import { app } from "./web/app";
import { setJobState } from "./web/routes/dashboard";
import { prisma } from "./lib/prisma";
import { notifySlack } from "./lib/slack";
import { isMarketDay } from "./lib/market-date";
import { TIMEZONE } from "./lib/constants";
import { cronControl } from "./lib/cron-control";
import { getTachibanaClient, resetTachibanaClient, type TachibanaSession } from "./core/broker-client";
import { getBrokerEventStream, resetBrokerEventStream, isBrokerConnectionWindow } from "./core/broker-event-stream";
import { handleBrokerFill } from "./core/broker-fill-handler";

// ジョブ状態（ダッシュボード・cronルートから参照可能）
const jobState = {
  running: new Set<string>(),
  lastRun: new Map<
    string,
    { startedAt: Date; completedAt?: Date; error?: string }
  >(),
  startedAt: new Date(),
};

// cron タスク参照（動的停止/再開用）
const cronTasks: ScheduledTask[] = [];

// ダッシュボードに状態を共有
setJobState(jobState);

// 休場日スキップのログ重複防止（position-monitor の複数回実行対策）
const holidaySkipLogged = new Set<string>();

// ジョブの最大実行時間。これを超えたらハング扱いで reject し、finally でロックを解放する。
// （broker-reconciliation 等が外部API/イベントストリームの応答待ちで永久にハングし、
//  jobState.running に居座って以降の実行が全てスキップされる事故を防ぐ安全弁。intraday
//  ジョブはいずれも通常数秒〜数十秒で完了するため、5分は正常系を巻き込まない十分な余裕。）
const JOB_TIMEOUT_MS = 5 * 60 * 1000;

/** promise がタイムアウトしたら reject する。成否どちらでもタイマーは解放する。 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms（ハング疑い: ロック解放）`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runJob(
  name: string,
  job: () => Promise<void>,
  requiresMarketDay = false,
) {
  // 休場日チェック
  if (requiresMarketDay && !isMarketDay()) {
    if (!holidaySkipLogged.has(name)) {
      console.log(`[${nowJST()}] ${name} スキップ（休場日）`);
      holidaySkipLogged.add(name);
    }
    return;
  }

  // システム停止チェック
  if (requiresMarketDay) {
    const config = await prisma.tradingConfig.findFirst({
      orderBy: { createdAt: "desc" },
    });
    if (config && !config.isActive) {
      if (!holidaySkipLogged.has(`${name}:inactive`)) {
        console.log(`[${nowJST()}] ${name} スキップ（システム停止中）`);
        holidaySkipLogged.add(`${name}:inactive`);
      }
      return;
    }
  }

  if (jobState.running.has(name)) {
    console.log(
      `[${nowJST()}] ${name} スキップ（前回の実行がまだ完了していません）`,
    );
    return;
  }

  jobState.running.add(name);
  jobState.lastRun.set(name, { startedAt: new Date() });
  console.log(`[${nowJST()}] ${name} 開始`);

  try {
    await withTimeout(job(), JOB_TIMEOUT_MS, name);
    const entry = jobState.lastRun.get(name);
    if (entry) entry.completedAt = new Date();
    console.log(`[${nowJST()}] ${name} 完了`);
  } catch (err) {
    const entry = jobState.lastRun.get(name);
    if (entry) entry.error = String(err);
    console.error(`[${nowJST()}] ${name} エラー:`, err);

    const errorDetail =
      err instanceof Error
        ? `${err.message}\n\n\`\`\`\n${err.stack?.split("\n").slice(1, 6).join("\n") ?? ""}\n\`\`\``
        : String(err);

    await notifySlack({
      title: `❌ ${name} でエラーが発生しました`,
      message: errorDetail,
      color: "danger",
    }).catch(() => {});
  } finally {
    jobState.running.delete(name);
  }
}

function nowJST(): string {
  return dayjs().tz(TIMEZONE).format("YYYY-MM-DD HH:mm:ss");
}

// 市場時間の定時tick（1日5回）: position-monitor 単体で実行
// （立花のAPI高負荷警告を受け毎分→5回に削減。broker-reconciliation も1日6回の独立スケジュール）
async function runPositionMonitorTick() {
  await runJob("position-monitor", runMonitor, true);
}

// 15:24 エントリー監視: combined BT の資金配分順 (GapUp → PSC → US-ETF → panic) で逐次実行する。
// 各 monitor は executeEntry 内で cash/openPositions を読み直すため、逐次化するだけで
// 「GU が先に資金・枠を確保し、PSC は残りから入る」という combined BT の優先順位が再現される
// （並列 cron だと共有資金のレースで優先順位が非決定的だった）。
// 加えて、重複銘柄（GU watchlist ⊆ PSC watchlist）の時価が tachibana-price-client の
// 短TTLキャッシュで1回の立花アクセスに集約され、15:24 のピーク負荷も下がる。
async function runEntryMonitors() {
  const monitors: [string, () => Promise<void>][] = [
    ["gapup-monitor", runGapupMonitor],
    ["psc-monitor", runPSCMonitor],
    ["us-etf-monitor", runUsEtfMonitor],
    // panic は最後。GU/PSC が資金・枠を確保した残りから入る = combined BT の優先順位と同じ。
    // 発火は年2回未満（VIX>25 × breadth<40% × N225連続下落≥3日）なので通常は即 return する。
    ["panic-monitor", runPanicMonitor],
  ];
  for (const [name, fn] of monitors) {
    try {
      await fn();
    } catch (err) {
      // 1戦略の失敗が後続戦略のエントリーを止めないよう隔離する
      console.error(`[${nowJST()}] entry-monitors: ${name} エラー:`, err);
      await notifySlack({
        title: `❌ ${name} でエラーが発生しました`,
        message: err instanceof Error ? err.message : String(err),
        color: "danger",
      }).catch(() => {});
    }
  }
}

// ※ schedules の job は raw の main 関数を渡すこと。cron 登録側が runJob(s.name, ...) で
//   ラップするため、job 内で同名の runJob を呼ぶと二重ネストになり、内側が
//   「前回の実行がまだ完了していません」で100%自己スキップする（KOH-528: この事故で
//   broker-reconciliation と buyback-monitor が 2026-04-22 以降一度も実行されていなかった）。

// スケジュール定義（全て JST）
// ※ position-monitor のみ Worker cron で実行
// ※ バッチジョブ（end-of-day, jpx-delisting-sync）は cron-job.org → /api/cron/* に移行
// ※ news-collector, weekly-review は GitHub Actions cron に移行済み
const schedules = [
  // ポジション監視（平日・市場時間、1日5回）
  // 立花のAPI高負荷警告（2026-03-10 / 2026-07-02 再警告）対応: 毎分(約330回/日) → 5回/日 で ~98% 削減。
  // position-monitor の毎分・銘柄ごとの時価取得（CLMMfdsGetMarketPrice）が全立花API呼び出しの約8割を占め、
  // 立花が名指しで禁止する「場中(8:00-15:30)ポーリング」の主因だった。頻度を下げても機能劣化が限定的な根拠:
  //   1. 下落保護(SL)は ensure-broker-sl が発注済みのブローカー逆指値が担保 → 場中の価格ポーリング不要
  //   2. GU/PSC/ETF は日足バックテストで検証された戦略。トレーリング引き上げ・タイムストップ決済は
  //      「引け基準」で判定するのがBTに忠実で、分足ポーリングは検証外の過剰忠実度だった
  //   3. WebSocket EVENT I/F が約定同期を主系として担う
  // 実行時刻は broker-reconciliation（9:05/10:30/12:35/14:00/15:22/15:30）と同じ分を避けてピーク負荷を分散。
  // 引け前(15:20)の実行が BT の close 基準決済に相当し最重要。他は日中のトレーリング更新・保険。
  { cron: "35 9 * * 1-5",  job: runPositionMonitorTick, name: "position-monitor-tick", requiresMarketDay: false }, // 9:35 前場寄り後（寄付ボラ通過後）
  { cron: "20 11 * * 1-5", job: runPositionMonitorTick, name: "position-monitor-tick", requiresMarketDay: false }, // 11:20 前場引け前
  { cron: "0 13 * * 1-5",  job: runPositionMonitorTick, name: "position-monitor-tick", requiresMarketDay: false }, // 13:00 後場寄り後
  { cron: "30 14 * * 1-5", job: runPositionMonitorTick, name: "position-monitor-tick", requiresMarketDay: false }, // 14:30 後場中盤
  { cron: "20 15 * * 1-5", job: runPositionMonitorTick, name: "position-monitor-tick", requiresMarketDay: false }, // 15:20 引け前（BT close 基準決済に相当・最重要）
  // broker-reconciliation（1日6回の独立スケジュール。position-monitor の :00 実行と競合回避のため :30 秒にオフセット）
  // 立花のAPI高負荷警告（2026-03-10）対応: 毎分 → 6回/日 で ~98% 削減。
  // WebSocket EVENT I/F がリアルタイム約定同期を主系として担うため、照合頻度を下げても機能劣化は限定的。
  { cron: "30 5 9 * * 1-5",   job: runBrokerReconciliation,    name: "broker-reconciliation", requiresMarketDay: true }, // 9:05:30 前場開始直後の初期化
  { cron: "30 30 10 * * 1-5", job: runBrokerReconciliation,    name: "broker-reconciliation", requiresMarketDay: true }, // 10:30:30 前場中の回復チェック
  { cron: "30 35 12 * * 1-5", job: runBrokerReconciliation,    name: "broker-reconciliation", requiresMarketDay: true }, // 12:35:30 後場開始直後
  { cron: "30 0 14 * * 1-5",  job: runBrokerReconciliation,    name: "broker-reconciliation", requiresMarketDay: true }, // 14:00:30 後場中の回復チェック
  { cron: "30 22 15 * * 1-5", job: runBrokerReconciliation,    name: "broker-reconciliation", requiresMarketDay: true }, // 15:22:30 gapup/PSC 発注（15:24）直前スナップショット
  { cron: "30 30 15 * * 1-5", job: runBrokerReconciliation,    name: "broker-reconciliation", requiresMarketDay: true }, // 15:30:30 引け直後の最終同期
  { cron: "30 45 15 * * 1-5", job: runBrokerReconciliation,    name: "broker-reconciliation", requiresMarketDay: true }, // 15:45:30 引け後の冗長リカバリ（デプロイ等で15:30:30を取りこぼした場合の保険）
  // 15:24:00/20/40 エントリー監視（東証クロージングオークション15:25〜直前に発注）
  // GapUp → PSC → US-ETF を1ジョブ内で逐次実行（combined BT の資金配分順を再現＋時価キャッシュ共有）。
  // 接続エラー等のretryableな失敗時に20秒間隔で最大3回試行。成功後は各monitorのlastScanDateで以降をスキップ。
  // PSC: ENTRY_ENABLED=false の間は内部でスキップ / US-ETF: idle帯のみ引け成行買い + 5営業日タイムストップ引け成行売り
  { cron: "0 24 15 * * 1-5", job: runEntryMonitors, name: "entry-monitors", requiresMarketDay: true },
  { cron: "20 24 15 * * 1-5", job: runEntryMonitors, name: "entry-monitors", requiresMarketDay: true },
  { cron: "40 24 15 * * 1-5", job: runEntryMonitors, name: "entry-monitors", requiresMarketDay: true },
  // 自社株買いカタリスト観察（KOH-504 Phase A）は **2026-07-15 に停止**（KOH-556）。
  //
  // Phase A の目的は「実弾の前に live パイプラインを検証する」ことだったが、その先の Phase B が
  // 却下されたため観察を続ける意味が無くなった。却下理由: 却下 #39 でイントラバー先読みを直した
  // 現エンジンで測り直すと、buyback は fullcycle Calmar を **73.2 → 59.7 (-18%)** と悪化させる。
  // live 再現可能な定義（breadth を前営業日終値で判定 = `--breadth-lag 1`）でも 66.8 (-9%) で、
  // baseline を超える構成が1つも無い。`.claude/rules/backtest.md` 却下リスト #41 参照。
  //
  // ⚠️ 再開する前に必ず #41 を読むこと。採用根拠だった「fullcycle +157%」は**旧エンジンの
  //    先読みが作った数字**で、現エンジンでは符号ごと反転する。
  // ジョブ本体 (`jobs/buyback-monitor.ts`) と BT (`--enable-buyback`) は再現用に残置。
  // { cron: "0 20 * * 1-5", job: runBuybackMonitor,    name: "buyback-monitor", requiresMarketDay: true },
  // 8:50 プレマーケット セッション確認（電話番号認証の早期検出）
  { cron: "50 8 * * 1-5", job: runSessionHealthCheck, name: "session-health-check", requiresMarketDay: true },
  // 15:15 プレクローズ セッション確認（15:24のエントリー発注前に最終確認。9分の再ログイン・電話認証対応余裕）
  { cron: "15 15 * * 1-5", job: runSessionHealthCheck, name: "session-health-check", requiresMarketDay: true },
  // 取引時間外のSL未発注ポジションへの発注（broker-reconciliation は getOrders/getHoldings が
  // 0件を返す場外では誤判定リスクがあるため走らせない。場外は発注のみの ensure-broker-sl で安全）
  // 17:00〜 は翌日注文受付開始（16時台は 11102 受付時間外エラーが出るため除外）
  // 7:00-8:55 は前場開始前のバックアップ
  { cron: "*/5 17 * * 1-5", job: runEnsureBrokerSL, name: "ensure-broker-sl", requiresMarketDay: false },
  { cron: "*/5 7-8 * * 1-5", job: runEnsureBrokerSL, name: "ensure-broker-sl", requiresMarketDay: false },
  // ※ daily-social-post（Bluesky/Threads日次投稿）は cron-job.org に移行済み
  //    （.github/workflows/cronjob_daily-social-post.yml、平日 17:30 JST に workflow_dispatch）
];

// cron 登録
for (const s of schedules) {
  const task = cron.schedule(
    s.cron,
    () => runJob(s.name, s.job, s.requiresMarketDay),
    { timezone: TIMEZONE },
  );
  cronTasks.push(task);
  console.log(`  スケジュール登録: ${s.name} → ${s.cron} (JST)`);
}

// cron 制御関数を登録（api.ts から cronControl.stop()/start() で呼べる）
cronControl.register(
  () => {
    for (const task of cronTasks) task.stop();
    console.log(`[${nowJST()}] cron タスク停止（${cronTasks.length}件）`);
  },
  () => {
    for (const task of cronTasks) task.start();
    holidaySkipLogged.delete("position-monitor:inactive");
    holidaySkipLogged.delete("broker-reconciliation:inactive");
    console.log(`[${nowJST()}] cron タスク再開（${cronTasks.length}件）`);
  },
);

// 起動時に isActive=false なら cron を停止した状態で開始
prisma.tradingConfig.findFirst({ orderBy: { createdAt: "desc" } }).then((config) => {
  if (config && !config.isActive) {
    cronControl.stop();
    console.log("  起動時 isActive=false → cron タスク停止状態で開始");
  }
}).catch(() => {});

// 日次リセット: 休場日スキップログをクリア
cron.schedule("0 0 * * *", () => {
  holidaySkipLogged.clear();
}, { timezone: TIMEZONE });

// HTTP サーバー起動（ダッシュボード）
const port = parseInt(process.env.PORT || "3000", 10);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`  Dashboard: http://localhost:${info.port}`);
});

// ブローカーセッション初期化（APIログインは行わない — 初回API呼び出し時に遅延ログイン）
(async () => {
  try {
    console.log("  ブローカーセッション初期化中...");
    const client = getTachibanaClient();

    // WebSocket + auto-refresh セットアップ（セッション確立後に実行）
    const setupBrokerConnection = (session: TachibanaSession) => {
      const stream = getBrokerEventStream();
      stream.on("execution", (event) => {
        handleBrokerFill(event).catch((err) => {
          console.error("[worker] broker-fill error:", err);
        });
      });
      stream.on("error", (err) => {
        console.error("[worker] EventStream error:", err);
      });
      if (!isBrokerConnectionWindow()) {
        console.log("  WebSocket: 営業時間外 — 次の営業時間に自動接続します");
      }
      stream.connect(session.urlEventWebSocket);

      client.startAutoRefresh((newSession) => {
        stream.reconnect(newSession.urlEventWebSocket);
      });

      console.log("  ブローカーセッション確立");
    };

    // DBからセッション復元を試みる（APIログインはしない）
    const session = await client.restoreFromDB();

    if (session) {
      setupBrokerConnection(session);
    } else {
      console.log("  セッションなし — 初回API呼び出し時にログインします");
      client.onSessionReady(setupBrokerConnection);
    }
  } catch (e) {
    console.error("  ブローカーセッション復元失敗:", e);
  }
})();

// シャットダウン
async function shutdown(signal: string) {
  console.log(`\n[${nowJST()}] ${signal} 受信、シャットダウン中...`);
  for (const task of cronTasks) task.stop();

  // WebSocket 切断
  resetBrokerEventStream();

  try {
    const client = getTachibanaClient();
    if (client.isLoggedIn()) {
      await client.logout();
    }
    resetTachibanaClient();
  } catch (e) {
    console.warn("  ブローカーログアウトエラー:", e);
  }

  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

console.log(`\n=== Worker 起動完了 ===`);
console.log(`  JST時刻: [${nowJST()}]`);
console.log(`  System時刻 (UTC): [${new Date().toISOString()}]`);
console.log(`============================\n`);
