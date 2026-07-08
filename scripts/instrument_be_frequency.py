"""
BE(建値)発動の頻度ギャップ計装ジョブ

目的: position-monitor が 1日5回ポール(9:35/11:20/13:00/14:30/15:20)でしか
BE/トレール水準を更新しないため、「BE発動価格まで日中に一度到達したのに、ポール間で
反落してSLに刈られた負け」が発生し得る。continuous/event-driven trailing なら
建値で救えたはずのこの損失を、実トレードで定量化するための計装。

日足BTのブラケット実験(--compare-detection-granularity)では検知粒度が一次ドライバーと
判明したが、下限モデルは実5回/日より悲観的。本ジョブは「実際の日中足(5分)」で
各決済済みトレードの真の日中高値を取り、BE発動価格に到達していたかを記録する。

【判定】
  wouldHaveBeenSaved = 負け決済 かつ 真の日中高値 >= BE発動価格
    → 我々の5回/日ではBEを発動できず負けたが、真の日中値ではBE水準に到達していた
    → continuous/event-driven trailing なら建値(トントン)で終われた損失

【データ源】yfinance 5分足(直近~60日のみ取得可)。決済直後に走らせる前提。
【書き込み】TradingPosition.exitSnapshot(jsonb) に beFreqInstrument キーを追記(既存キー保持)。
           スキーマ変更なし。additive・非破壊。
【運用】次のD期(高ボラ)まで蓄積し、wouldHaveBeenSaved 件数/損失額が有意なら
        event-driven trailing を作る判断材料にする(それまでは作らない = KOH方針C)。

環境変数: DATABASE_URL(必須), SLACK_WEBHOOK_URL(任意, would-be-saved検出時に通知)
"""

import os
import sys
import json
from datetime import datetime, timedelta, timezone

import psycopg2
import psycopg2.extras

try:
    import yfinance as yf
except ImportError:
    print("ERROR: yfinance 未インストール")
    sys.exit(1)

try:
    import requests
except ImportError:
    requests = None

JST = timezone(timedelta(hours=9))

# BE発動ATR倍率 (src/lib/constants/jobs.ts BREAK_EVEN_STOP.ACTIVATION_ATR_MULTIPLIER と一致)
BE_ACTIVATION_ATR_MULT = {
    "breakout": 1.0,
    "gapup": 0.3,
    "post-surge-consolidation": 0.3,
    "momentum": 1.0,
    "weekly-break": 0.5,
}
# ATR未取得時の%フォールバック (同ファイル ACTIVATION_PCT と一致)
BE_ACTIVATION_PCT = {
    "breakout": 0.02,
    "gapup": 0.005,
    "post-surge-consolidation": 0.01,
    "momentum": 0.02,
    "weekly-break": 0.015,
}

# 5分足を取得できる最大遡及(yfinance仕様 ~60日)。安全側に55日。
INTRADAY_LOOKBACK_DAYS = 55


def get_database_url() -> str:
    url = os.getenv("DATABASE_URL")
    if url:
        return url
    # .env フォールバック(既存スクリプトと同パターン)
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                if line.startswith("DATABASE_URL="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    print("ERROR: DATABASE_URL が見つかりません")
    sys.exit(1)


def is_loss_sl_exit(exit_reason: str, net_pnl, entry: float, exit_price) -> bool:
    """SL/損切り系の負け決済かどうか"""
    if exit_price is None:
        return False
    reason = exit_reason or ""
    sl_like = ("SL" in reason) or ("損切" in reason) or ("stop_loss" in reason)
    is_loss = (net_pnl is not None and net_pnl < 0) or (exit_price < entry)
    return sl_like and is_loss


def compute_be_activation_price(strategy: str, entry: float, atr) -> float:
    """exit-checker / trailing-stop.ts と同一ロジックで BE発動価格を算出"""
    if atr and atr > 0:
        mult = BE_ACTIVATION_ATR_MULT.get(strategy, 1.0)
        return entry + atr * mult
    pct = BE_ACTIVATION_PCT.get(strategy, 0.02)
    return entry * (1 + pct)


def fetch_intraday_max_high(ticker: str, start_dt: datetime, end_dt: datetime):
    """
    [start_dt, end_dt] の 5分足の真の日中高値を返す。
    start_dt はエントリー約定時刻(それ以前の値動きは除外)、end_dt は決済時刻。
    取得不能なら None。
    """
    try:
        df = yf.Ticker(ticker).history(period="60d", interval="5m")
    except Exception as e:
        print(f"    yfinance取得失敗 {ticker}: {e}")
        return None, 0
    if df is None or len(df) == 0:
        return None, 0
    # index は tz-aware (Asia/Tokyo 相当)。JST に揃える。
    idx = df.index.tz_convert(JST) if df.index.tz is not None else df.index.tz_localize(JST)
    df = df.copy()
    df.index = idx
    mask = (df.index > start_dt) & (df.index <= end_dt)
    sub = df[mask]
    if len(sub) == 0:
        return None, 0
    return float(sub["High"].max()), len(sub)


def notify_slack(text: str):
    webhook = os.getenv("SLACK_WEBHOOK_URL")
    if not webhook or requests is None:
        return
    try:
        requests.post(webhook, json={"text": text}, timeout=10)
    except Exception as e:
        print(f"    Slack通知失敗: {e}")


def main():
    dry_run = "--dry-run" in sys.argv
    if dry_run:
        print("=== DRY-RUN: DB書き込みをスキップ ===")
    db_url = get_database_url()
    conn = psycopg2.connect(db_url, connect_timeout=30)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cutoff = datetime.now(JST) - timedelta(days=INTRADAY_LOOKBACK_DAYS)

    # 未計装(exitSnapshot に beFreqInstrument が無い)の決済済みポジションを対象
    cur.execute(
        """
        SELECT p.id, p.strategy, p."entryPrice", p."stopLossPrice", p."exitPrice",
               p."entryAtr", p."maxHighDuringHold", p."exitedAt", p."createdAt",
               p.quantity, p."entrySnapshot", p."exitSnapshot",
               s."tickerCode" AS ticker,
               (p."exitSnapshot"->>'exitReason') AS exit_reason,
               bo."filledAt" AS entry_filled_at
        FROM "TradingPosition" p
        JOIN "Stock" s ON s.id = p."stockId"
        LEFT JOIN LATERAL (
            SELECT "filledAt" FROM "TradingOrder"
            WHERE "positionId" = p.id AND side = 'buy' AND "filledAt" IS NOT NULL
            ORDER BY "filledAt" ASC LIMIT 1
        ) bo ON true
        WHERE p.status = 'closed'
          AND p."exitedAt" IS NOT NULL
          AND p."exitedAt" >= %s
          AND (p."exitSnapshot" IS NULL OR NOT (p."exitSnapshot" ? 'beFreqInstrument'))
        ORDER BY p."exitedAt" ASC
        """,
        (cutoff,),
    )
    rows = cur.fetchall()
    print(f"対象: {len(rows)}件 (直近{INTRADAY_LOOKBACK_DAYS}日の未計装決済ポジション)")

    saved_cases = []
    processed = 0

    for r in rows:
        ticker = r["ticker"]
        strategy = r["strategy"]
        entry = float(r["entryPrice"])
        exit_price = float(r["exitPrice"]) if r["exitPrice"] is not None else None
        # netPnl は TradingPosition に無いため、損失は exitPrice<entry で判定(コスト込みでないが
        # SL負けの識別には十分。厳密な損益は別途 exit-entry で近似可)
        net_pnl = None
        if exit_price is not None:
            net_pnl = (exit_price - entry) * int(r["quantity"] or 0)
        poll_max_high = float(r["maxHighDuringHold"]) if r["maxHighDuringHold"] is not None else entry

        # ATR: entryAtr 優先、無ければ entrySnapshot.trigger.atr14
        atr = float(r["entryAtr"]) if r["entryAtr"] is not None else None
        if atr is None and r["entrySnapshot"]:
            snap = r["entrySnapshot"]
            if isinstance(snap, dict):
                trig = snap.get("trigger") or {}
                if trig.get("atr14"):
                    atr = float(trig["atr14"])

        be_act = compute_be_activation_price(strategy, entry, atr)

        # ホールド区間: エントリー約定時刻(無ければ createdAt) 〜 決済時刻
        entry_dt = r["entry_filled_at"] or r["createdAt"]
        if entry_dt.tzinfo is None:
            entry_dt = entry_dt.replace(tzinfo=timezone.utc)
        entry_dt = entry_dt.astimezone(JST)
        exit_dt = r["exitedAt"]
        if exit_dt.tzinfo is None:
            exit_dt = exit_dt.replace(tzinfo=timezone.utc)
        exit_dt = exit_dt.astimezone(JST)

        intraday_max, bars = fetch_intraday_max_high(ticker, entry_dt, exit_dt)

        reached_be = intraday_max is not None and intraday_max >= be_act
        poll_reached_be = poll_max_high >= be_act
        is_loss = is_loss_sl_exit(r["exit_reason"], net_pnl, entry, exit_price)
        # 負けSL決済 かつ 真の日中高値がBE発動価格に到達 = continuous なら建値で救えた損失
        would_have_been_saved = bool(is_loss and reached_be)

        instrument = {
            "intradayMaxHigh": intraday_max,
            "intradayBars": bars,
            "beActivationPrice": round(be_act, 2),
            "reachedBe": reached_be,
            "pollMaxHigh": poll_max_high,
            "pollReachedBe": poll_reached_be,
            "isLossSl": is_loss,
            "wouldHaveBeenSaved": would_have_been_saved,
            "computedAt": datetime.now(JST).isoformat(),
            "note": "intraday=5m yfinance. saved=負けSLかつ真の日中高値>=BE発動価格(5回/日で取り逃し)",
        }

        if not dry_run:
            cur.execute(
                """
                UPDATE "TradingPosition"
                SET "exitSnapshot" = COALESCE("exitSnapshot", '{}'::jsonb)
                                     || jsonb_build_object('beFreqInstrument', %s::jsonb)
                WHERE id = %s
                """,
                (json.dumps(instrument), r["id"]),
            )
        processed += 1

        flag = " ★SAVED候補" if would_have_been_saved else ""
        imh = f"{intraday_max:.1f}" if intraday_max is not None else "N/A"
        print(
            f"  {ticker} {strategy} entry={entry:.0f} BE発動={be_act:.1f} "
            f"日中高値={imh} loss={is_loss} reachedBE={reached_be}{flag}"
        )
        if would_have_been_saved:
            saved_cases.append(
                f"{ticker}({strategy}): entry¥{entry:.0f} 日中高値¥{intraday_max:.0f} "
                f"≥ BE発動¥{be_act:.0f} だが SL負け(exit¥{exit_price:.0f}) "
                f"→ event-drivenなら建値で救済可能"
            )

    if not dry_run:
        conn.commit()
    cur.close()
    conn.close()

    print(f"\n計装完了: {processed}件処理{'(DRY-RUN・未書込)' if dry_run else ''}, would-be-saved {len(saved_cases)}件")

    if saved_cases:
        msg = (
            f"📊 BE頻度ギャップ計装: event-drivenで救えた可能性のある負け {len(saved_cases)}件検出\n"
            + "\n".join(f"・{c}" for c in saved_cases)
            + "\n(蓄積用。D期でこれが有意に増えたら event-driven trailing を検討)"
        )
        print(msg)
        notify_slack(msg)


if __name__ == "__main__":
    main()
