/**
 * 銘柄詳細モーダル用コンポーネント
 *
 * layout.ts のクライアントJS文字列連結をサーバーサイドテンプレートに移行。
 * openStockModal() → fetch('/api/stock/:tickerCode/modal') → innerHTML
 */

import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { Stock } from "@prisma/client";
import type { TechnicalSummary, OHLCVData } from "../../core/technical-analysis";
import type { PatternsResponse } from "../../lib/candlestick-patterns";
import { tt } from "./components";

type HtmlContent = HtmlEscapedString | Promise<HtmlEscapedString>;

/** 分析データ型 */
export interface ModalAnalysis {
  ohlcv: OHLCVData[];
  technical: TechnicalSummary | null;
  patterns: PatternsResponse | null;
  scoring: {
    totalScore: number;
    rank: string;
    trendQualityScore: number;
    entryTimingScore: number;
    riskQualityScore: number;
    sectorMomentumScore: number;
    isDisqualified: boolean;
    disqualifyReason: string | null;
    aiDecision: string | null;
  } | null;
}

/** ポジション情報（モーダル表示用） */
export interface ModalPositionInfo {
  entryPrice: number;
  quantity: number;
  strategy: string;
  currentPrice: number | null;
  unrealizedPnl: number | null;
  pnlRate: number | null;
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
}

// ========================================
// メインコンポーネント
// ========================================

/** モーダル全体（overlay + content） */
export function stockModal(
  stock: Stock,
  analysis: ModalAnalysis | null,
  position?: ModalPositionInfo | null,
): HtmlContent {
  return html`<div
    class="modal-overlay"
    onclick="if(event.target===this)closeStockModal()"
  >
    <div class="modal-content">
      <div class="modal-header">
        <div>
          <h2>${stock.tickerCode}</h2>
          <div class="modal-sub">${stock.name}</div>
        </div>
        <button class="modal-close" onclick="closeStockModal()">✕</button>
      </div>
      ${position ? positionBanner(position) : ""}
      <div class="modal-tabs">
        <button
          class="modal-tab active"
          onclick="switchModalTab(this,'chart')"
        >
          チャート
        </button>
        <button class="modal-tab" onclick="switchModalTab(this,'info')">
          情報
        </button>
        <button class="modal-tab" onclick="switchModalTab(this,'finance')">
          財務
        </button>
      </div>
      <div class="modal-body">
        ${chartTab(analysis)} ${infoTab(stock)} ${financeTab(stock)}
      </div>
    </div>
  </div>`;
}

/** ポジション情報バナー（モーダル上部に表示） */
function positionBanner(pos: ModalPositionInfo): HtmlContent {
  const strategyLabels: Record<string, string> = {
    day_trade: "デイ",
    swing: "スイング",
  };
  const pnlColor = (pos.unrealizedPnl ?? 0) >= 0 ? "#22c55e" : "#ef4444";
  const pnlSign = (pos.unrealizedPnl ?? 0) >= 0 ? "+" : "";
  const fmtPrice = (v: number) => "¥" + v.toLocaleString("ja-JP");

  return html`<div style="background:${pnlColor}10;border:1px solid ${pnlColor}30;border-radius:8px;padding:10px 14px;margin:0 0 8px">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
      <div style="font-size:12px;color:#94a3b8">
        保有中 · ${strategyLabels[pos.strategy] ?? pos.strategy} · ${pos.quantity}株 · 建値 ${fmtPrice(pos.entryPrice)}
      </div>
      <div style="display:flex;align-items:baseline;gap:8px">
        ${pos.currentPrice != null
          ? html`<span style="font-size:16px;font-weight:700">${fmtPrice(pos.currentPrice)}</span>`
          : ""}
        ${pos.unrealizedPnl != null
          ? html`<span style="font-size:14px;font-weight:600;color:${pnlColor}">${pnlSign}${fmtPrice(Math.abs(pos.unrealizedPnl))}</span>`
          : ""}
        ${pos.pnlRate != null
          ? html`<span style="font-size:12px;color:${pnlColor}">(${pnlSign}${pos.pnlRate.toFixed(2)}%)</span>`
          : ""}
      </div>
    </div>
    ${pos.takeProfitPrice != null || pos.stopLossPrice != null
      ? html`<div style="display:flex;gap:12px;margin-top:6px;font-size:11px">
          ${pos.takeProfitPrice != null
            ? html`<span style="color:#22c55e">利確: ${fmtPrice(pos.takeProfitPrice)}</span>`
            : ""}
          ${pos.stopLossPrice != null
            ? html`<span style="color:#ef4444">損切: ${fmtPrice(pos.stopLossPrice)}</span>`
            : ""}
        </div>`
      : ""}
  </div>`;
}

// ========================================
// タブコンポーネント
// ========================================

/** チャートタブ */
function chartTab(analysis: ModalAnalysis | null): HtmlContent {
  return html`<div class="modal-pane" data-tab="chart" style="display:block">
    <div class="modal-chart">
      ${analysis?.ohlcv && analysis.ohlcv.length >= 2 && analysis.technical
        ? candlestickChart(analysis.ohlcv, analysis.technical)
        : html`<div
            style="text-align:center;padding:24px;color:#64748b;font-size:12px"
          >
            チャートデータなし
          </div>`}
    </div>
    ${analysis?.patterns
      ? html`${combinedSignal(analysis.patterns)}
          ${chartPatterns(analysis.patterns)}
          ${latestCandle(analysis.patterns)}`
      : ""}
    ${analysis?.technical
      ? html`${technicalGrid(analysis.technical)}
          ${trendInfo(analysis.technical)}
          ${supportResistanceInfo(analysis.technical)}`
      : ""}
    ${analysis ? scoringSection(analysis.scoring) : ""}
  </div>`;
}

/** 情報タブ */
function infoTab(s: Stock): HtmlContent {
  const statusText = s.isDelisted
    ? html`<span style="color:#ef4444">上場廃止</span>`
    : s.isActive
      ? html`<span style="color:#22c55e">アクティブ</span>`
      : html`<span style="color:#f59e0b">非アクティブ</span>`;

  return html`<div class="modal-pane" data-tab="info" style="display:none">
    <div class="modal-section">基本情報</div>
    ${modalRow("市場", s.market || "-")}
    ${modalRow("セクター", s.jpxSectorName || s.sector || "-")}

    <div class="modal-section">株価データ</div>
    ${modalRow("現在価格", fmtYen(s.latestPrice))}
    ${modalRow("日次変動", fmtPctHtml(s.dailyChangeRate))}
    ${modalRow("週次変動", fmtPctHtml(s.weekChangeRate))}
    ${modalRow(tt("出来高", "1日の売買された株数"), s.latestVolume != null ? Number(s.latestVolume).toLocaleString("ja-JP") : "-")}
    ${modalRow(tt("ATR(14)", "14日間の平均的な値幅。損切り幅の基準に使用"), fmt(s.atr14))}
    ${modalRow(tt("ボラティリティ", "価格変動の大きさ。高いほどリスク・リターンが大きい"), fmt(s.volatility, "%"))}
    ${modalRow("更新日", fmtDate(s.latestPriceDate))}

    <div class="modal-section">ステータス</div>
    ${modalRow("上場状態", statusText)}
    ${s.isRestricted ? modalRow("取引制限", html`<span style="color:#ef4444">あり</span>`) : ""}
    ${s.supervisionFlag ? modalRow("監理区分", html`<span style="color:#f59e0b">${s.supervisionFlag}</span>`) : ""}
    ${s.tradingHaltFlag ? modalRow("売買停止", html`<span style="color:#ef4444">停止中</span>`) : ""}
    ${s.delistingDate ? modalRow("廃止予定日", html`<span style="color:#ef4444">${fmtDate(s.delistingDate)}</span>`) : ""}
    ${modalRow("次回決算", fmtDate(s.nextEarningsDate))}
  </div>`;
}

/** 財務タブ */
function financeTab(s: Stock): HtmlContent {
  const profitText =
    s.isProfitable == null
      ? "-"
      : s.isProfitable
        ? html`<span style="color:#22c55e">黒字</span>`
        : html`<span style="color:#ef4444">赤字</span>`;

  return html`<div
    class="modal-pane"
    data-tab="finance"
    style="display:none"
  >
    <div class="modal-section">財務指標</div>
    ${modalRow(tt("PER", "株価収益率。株価÷EPS。低いほど割安"), fmt(s.per))}
    ${modalRow(tt("PBR", "株価純資産倍率。1倍未満は資産対比で割安"), fmt(s.pbr))}
    ${modalRow(tt("ROE", "自己資本利益率。高いほど効率的に利益を出している"), fmt(s.roe, "%"))}
    ${modalRow(tt("EPS", "1株当たり利益。高いほど収益力が高い"), fmt(s.eps))}
    ${modalRow(tt("配当利回り", "年間配当÷株価。インカムゲインの指標"), fmt(s.dividendYield, "%"))}
    ${modalRow(tt("時価総額", "企業の市場評価額。株価×発行済株式数"), s.marketCap != null ? Number(s.marketCap).toLocaleString("ja-JP") + "億円" : "-")}
    ${modalRow("収益性", profitText)}
  </div>`;
}

// ========================================
// チャートタブ内セクション
// ========================================

/** 総合シグナル */
function combinedSignal(patterns: PatternsResponse): HtmlContent {
  if (!patterns.combined) return html``;
  const cs = patterns.combined;
  const sigCls =
    cs.signal === "buy"
      ? "signal-buy"
      : cs.signal === "sell"
        ? "signal-sell"
        : "signal-neutral";
  const sigLabel =
    cs.signal === "buy" ? "買い" : cs.signal === "sell" ? "売り" : "様子見";

  return html`<div
    style="display:flex;align-items:center;gap:8px;margin-bottom:12px"
  >
    <span class="signal-badge ${sigCls}">${sigLabel} ${cs.strength}%</span>
    ${cs.reasons.length > 0
      ? html`<span style="font-size:11px;color:#94a3b8"
          >${cs.reasons.join("、")}</span
        >`
      : ""}
  </div>`;
}

/** テクニカル指標グリッド */
function technicalGrid(t: TechnicalSummary): HtmlContent {
  return html`<div class="modal-section">テクニカル指標</div>
    <div class="indicator-grid">
      ${indicatorItem(tt("RSI(14)", "相対力指数。70以上で買われすぎ、30以下で売られすぎ"), t.rsi != null ? t.rsi.toFixed(1) : "-", rsiColor(t.rsi))}
      ${indicatorItem(tt("MACD", "移動平均の収束・拡散。ヒストグラムが+なら上昇圧力"), t.macd.histogram != null ? (t.macd.histogram >= 0 ? "+" : "") + t.macd.histogram.toFixed(2) : "-", t.macd.histogram != null ? (t.macd.histogram >= 0 ? "#22c55e" : "#ef4444") : null)}
      ${indicatorItem(tt("SMA5", "5日単純移動平均線。短期トレンドの目安"), t.sma5 != null ? "¥" + Math.round(t.sma5).toLocaleString() : "-", null)}
      ${indicatorItem(tt("SMA25", "25日単純移動平均線。中期トレンドの目安"), t.sma25 != null ? "¥" + Math.round(t.sma25).toLocaleString() : "-", null)}
      ${indicatorItem(tt("BB上", "ボリンジャーバンド上限。ここを超えると過熱感"), t.bollingerBands.upper != null ? "¥" + Math.round(t.bollingerBands.upper).toLocaleString() : "-", null)}
      ${indicatorItem(tt("BB下", "ボリンジャーバンド下限。ここを割ると売られすぎ"), t.bollingerBands.lower != null ? "¥" + Math.round(t.bollingerBands.lower).toLocaleString() : "-", null)}
      ${indicatorItem(tt("ATR(14)", "14日間の平均的な値幅。ボラティリティの指標"), t.atr14 != null ? "¥" + t.atr14.toLocaleString() : "-", null)}
      ${indicatorItem(tt("乖離率", "25日移動平均線からの乖離。±5%超で反転の兆候"), t.deviationRate25 != null ? t.deviationRate25 + "%" : "-", t.deviationRate25 != null && Math.abs(t.deviationRate25) > 5 ? "#f59e0b" : null)}
    </div>`;
}

/** MA トレンド情報 */
function trendInfo(t: TechnicalSummary): HtmlContent {
  const trend = t.maAlignment;
  if (!trend) return html``;
  const trendLabel =
    trend.trend === "uptrend"
      ? "上昇"
      : trend.trend === "downtrend"
        ? "下降"
        : "横ばい";
  const trendColor =
    trend.trend === "uptrend"
      ? "#22c55e"
      : trend.trend === "downtrend"
        ? "#ef4444"
        : "#94a3b8";

  return html`<div style="margin-top:8px;font-size:12px;color:#94a3b8">
    ${tt("MA方向", "移動平均線のトレンド方向")}:
    <span style="color:${trendColor}">${trendLabel}</span>
    ${trend.orderAligned
      ? html`${tt("整列", "短期・中期・長期MAが順序通りに並んでいる状態")}`
      : ""}
  </div>`;
}

/** サポート・レジスタンス情報 */
function supportResistanceInfo(t: TechnicalSummary): HtmlContent {
  if (
    (!t.supports || t.supports.length === 0) &&
    (!t.resistances || t.resistances.length === 0)
  )
    return html``;

  return html`<div style="margin-top:8px;font-size:12px">
    ${t.supports.length > 0
      ? html`<span style="color:#22c55e"
          >${tt("支持", "サポートライン。この価格帯で下げ止まりやすい")}: ¥${t.supports
            .map((v) => v.toLocaleString())
            .join(", ¥")}</span
        > `
      : ""}
    ${t.resistances.length > 0
      ? html`<span style="color:#ef4444"
          >${tt("抵抗", "レジスタンスライン。この価格帯で上値が重くなりやすい")}: ¥${t.resistances
            .map((v) => v.toLocaleString())
            .join(", ¥")}</span
        >`
      : ""}
  </div>`;
}

/** チャートパターン一覧 */
function chartPatterns(patterns: PatternsResponse): HtmlContent {
  if (!patterns.chartPatterns || patterns.chartPatterns.length === 0)
    return html``;

  const rankColors: Record<string, string> = {
    S: "#f59e0b",
    A: "#3b82f6",
    B: "#22c55e",
    C: "#94a3b8",
    D: "#64748b",
  };

  return html`<div class="modal-section">チャートパターン</div>
    ${patterns.chartPatterns.map((p) => {
      const rc = rankColors[p.rank] || "#64748b";
      const sigCls =
        p.signal === "buy"
          ? "signal-buy"
          : p.signal === "sell"
            ? "signal-sell"
            : "signal-neutral";
      const sigLabel =
        p.signal === "buy" ? "買い" : p.signal === "sell" ? "売り" : "中立";
      return html`<div class="pattern-card">
        <div class="pattern-card-header">
          <span class="pattern-card-name">${p.patternName}</span>
          <span>
            <span
              class="badge"
              style="background:${rc}20;color:${rc}"
              >${p.rank}級</span
            >
            <span
              class="signal-badge ${sigCls}"
              style="font-size:11px;padding:2px 8px"
              >${sigLabel}</span
            >
          </span>
        </div>
        <div class="pattern-card-meta">
          勝率 ${p.winRate}% / 強度 ${p.strength}% — ${p.description}
        </div>
      </div>`;
    })}`;
}

/** 直近ローソク足パターン */
function latestCandle(patterns: PatternsResponse): HtmlContent {
  if (!patterns.latest) return html``;
  const lp = patterns.latest;
  const sigCls =
    lp.signal === "buy"
      ? "signal-buy"
      : lp.signal === "sell"
        ? "signal-sell"
        : "signal-neutral";

  return html`<div class="modal-section">直近ローソク足</div>
    <div style="display:flex;align-items:center;gap:8px;font-size:13px">
      <span
        class="signal-badge ${sigCls}"
        style="font-size:11px;padding:2px 8px"
        >${lp.description}</span
      >
      <span style="color:#94a3b8;font-size:11px">${lp.learnMore}</span>
    </div>`;
}

/** スコアリングセクション */
function scoringSection(
  scoring: ModalAnalysis["scoring"],
): HtmlContent {
  if (!scoring) return html``;
  const rc =
    { S: "#f59e0b", A: "#3b82f6", B: "#22c55e", C: "#94a3b8" }[
      scoring.rank
    ] ?? "#94a3b8";

  return html`<div class="modal-section">スコアリング</div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span style="font-size:24px;font-weight:700">${scoring.totalScore}</span>
      <span style="font-size:12px;color:#94a3b8">/100</span>
      <span class="badge" style="background:${rc}20;color:${rc}"
        >${scoring.rank}ランク</span
      >
      ${scoring.isDisqualified
        ? html`<span
            class="badge tt"
            data-tooltip="${scoring.disqualifyReason || "即死ルールに該当し自動失格"}"
            style="background:rgba(239,68,68,0.15);color:#ef4444"
            >即死</span
          >`
        : ""}
      ${scoring.aiDecision
        ? (() => {
            const aiColor =
              scoring.aiDecision === "go" ? "#22c55e" : "#ef4444";
            const aiLabel = scoring.aiDecision === "go" ? "GO" : "NO GO";
            return html`<span
              class="badge"
              style="background:${aiColor}20;color:${aiColor}"
              >${aiLabel}</span
            >`;
          })()
        : ""}
    </div>
    ${scoreBar(tt("トレンド品質", "MA整列・週足トレンド・トレンド継続性の評価"), scoring.trendQualityScore, 40, "#3b82f6")}
    ${scoreBar(tt("エントリー", "押し目深さ・ブレイクアウト・ローソク足シグナルの評価"), scoring.entryTimingScore, 35, "#a855f7")}
    ${scoreBar(tt("リスク品質", "ATR安定性・レンジ収束・出来高安定性の評価"), scoring.riskQualityScore, 20, "#22c55e")}
    ${scoreBar(tt("セクター", "セクター相対強度スコア"), scoring.sectorMomentumScore, 5, "#f59e0b")}`;
}

// ========================================
// SVG チャート
// ========================================

/** ローソク足チャート（サーバーサイドSVG生成） */
function candlestickChart(
  data: OHLCVData[],
  technical: TechnicalSummary,
): HtmlContent {
  const W = 388;
  const H = 200;
  const padT = 16;
  const padB = 24;
  const padL = 48;
  const padR = 8;
  const volH = 40;
  const chartH = H - padT - padB - volH;
  const chartW = W - padL - padR;

  const highs = data.map((d) => d.high);
  const lows = data.map((d) => d.low);
  const volumes = data.map((d) => d.volume);
  const minP = Math.min(...lows);
  const maxP = Math.max(...highs);
  const rangeP = maxP - minP || 1;
  const maxVol = Math.max(...volumes) || 1;

  const yPrice = (v: number) => padT + chartH - ((v - minP) / rangeP) * chartH;
  const xPos = (i: number) => padL + (i / (data.length - 1)) * chartW;

  // サポート・レジスタンスライン
  const srLines = [
    ...technical.supports
      .map((s) => ({ y: yPrice(s), color: "#22c55e" }))
      .filter((l) => l.y > padT && l.y < padT + chartH),
    ...technical.resistances
      .map((r) => ({ y: yPrice(r), color: "#ef4444" }))
      .filter((l) => l.y > padT && l.y < padT + chartH),
  ];

  // SMA25ライン
  const smaPoints: string[] = [];
  if (technical.sma25 != null && data.length >= 25) {
    for (let i = 24; i < data.length; i++) {
      let sum = 0;
      for (let j = i - 24; j <= i; j++) sum += data[j].close;
      const sma = sum / 25;
      smaPoints.push(`${xPos(i)},${yPrice(sma)}`);
    }
  }

  // ローソク足 or ラインチャート
  const useCandles = data.length <= 80;
  const barW = useCandles
    ? Math.max(1, (chartW / data.length) * 0.6)
    : 0;

  // X軸ラベル
  const labelIndices = [0, Math.floor(data.length / 2), data.length - 1];

  // 出来高
  const volTop = padT + chartH + 4;
  const volBarW = Math.max(1, (chartW / data.length) * 0.5);

  return html`<svg viewBox="0 0 ${W} ${H}">
    <!-- Y軸ラベル -->
    <text
      x="${padL - 4}"
      y="${padT + 4}"
      text-anchor="end"
      fill="#64748b"
      font-size="9"
    >
      ¥${Math.round(maxP).toLocaleString()}
    </text>
    <text
      x="${padL - 4}"
      y="${padT + chartH + 4}"
      text-anchor="end"
      fill="#64748b"
      font-size="9"
    >
      ¥${Math.round(minP).toLocaleString()}
    </text>

    <!-- サポート・レジスタンス -->
    ${srLines.map(
      (l) =>
        html`<line
          x1="${padL}"
          y1="${l.y}"
          x2="${W - padR}"
          y2="${l.y}"
          stroke="${l.color}"
          stroke-width="0.7"
          stroke-dasharray="3,3"
          opacity="0.5"
        />`,
    )}

    <!-- SMA25 -->
    ${smaPoints.length > 0
      ? html`<polyline
          fill="none"
          stroke="#f59e0b"
          stroke-width="1"
          opacity="0.6"
          points="${smaPoints.join(" ")}"
        />`
      : ""}

    <!-- 価格 -->
    ${useCandles
      ? data.map((d, i) => {
          const x = xPos(i);
          const isUp = d.close >= d.open;
          const color = isUp ? "#22c55e" : "#ef4444";
          const bodyTop = yPrice(Math.max(d.open, d.close));
          const bodyBot = yPrice(Math.min(d.open, d.close));
          const bodyH = Math.max(1, bodyBot - bodyTop);
          return html`<line
              x1="${x}"
              y1="${yPrice(d.high)}"
              x2="${x}"
              y2="${yPrice(d.low)}"
              stroke="${color}"
              stroke-width="0.8"
            />
            <rect
              x="${x - barW / 2}"
              y="${bodyTop}"
              width="${barW}"
              height="${bodyH}"
              fill="${isUp ? "none" : color}"
              stroke="${color}"
              stroke-width="0.8"
            />`;
        })
      : html`<polyline
          fill="none"
          stroke="#3b82f6"
          stroke-width="1.5"
          points="${data.map((d, i) => `${xPos(i)},${yPrice(d.close)}`).join(" ")}"
        />`}

    <!-- 出来高 -->
    ${data.map((d, i) => {
      const x = xPos(i);
      const vBarH = (d.volume / maxVol) * (volH - 8);
      const color = d.close >= d.open ? "#22c55e" : "#ef4444";
      return html`<rect
        x="${x - volBarW / 2}"
        y="${volTop + volH - 8 - vBarH}"
        width="${volBarW}"
        height="${vBarH}"
        fill="${color}"
        opacity="0.3"
      />`;
    })}

    <!-- X軸ラベル -->
    ${labelIndices.map((idx) => {
      const parts = data[idx].date.split("-");
      const label = parts[1] + "/" + parts[2];
      return html`<text
        x="${xPos(idx)}"
        y="${H - 2}"
        text-anchor="middle"
        fill="#64748b"
        font-size="8"
      >
        ${label}
      </text>`;
    })}

    <!-- クリックターゲット -->
    ${data.map((d, i) => {
      const x = xPos(i);
      const hitW = Math.max(4, chartW / data.length);
      const change = i > 0 ? d.close - data[i - 1].close : 0;
      const changePct = i > 0 && data[i - 1].close !== 0
        ? (change / data[i - 1].close) * 100
        : 0;
      return html`<rect
        x="${x - hitW / 2}"
        y="${padT}"
        width="${hitW}"
        height="${chartH + volH}"
        fill="transparent"
        data-chart-bar
        data-date="${d.date}"
        data-open="${d.open}"
        data-high="${d.high}"
        data-low="${d.low}"
        data-close="${d.close}"
        data-volume="${d.volume}"
        data-change="${i > 0 ? change.toFixed(1) : ""}"
        data-change-pct="${i > 0 ? changePct.toFixed(2) : ""}"
        style="cursor:pointer"
      />`;
    })}
  </svg>`;
}

// ========================================
// 小さなヘルパーコンポーネント
// ========================================

/** モーダル行（ラベル: 値） */
function modalRow(
  label: string | HtmlContent,
  value: string | HtmlContent,
): HtmlContent {
  return html`<div class="modal-row">
    <span class="modal-row-label">${label}</span>
    <span>${value}</span>
  </div>`;
}

/** テクニカル指標1個 */
function indicatorItem(
  label: string | HtmlContent,
  value: string,
  color: string | null,
): HtmlContent {
  return html`<div class="indicator-item">
    <div class="indicator-label">${label}</div>
    <div class="indicator-value" ${color ? html`style="color:${color}"` : ""}>
      ${value}
    </div>
  </div>`;
}

/** スコアバー */
function scoreBar(
  label: string | HtmlContent,
  value: number,
  max: number,
  color: string,
): HtmlContent {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return html`<div class="score-bar-wrap">
    <div class="score-bar-label">
      <span>${label}</span><span>${value}/${max}</span>
    </div>
    <div class="score-bar-track">
      <div
        class="score-bar-fill"
        style="width:${pct}%;background:${color}"
      ></div>
    </div>
  </div>`;
}

// ========================================
// フォーマットヘルパー
// ========================================

// Prisma Decimal 互換（Decimal | number | null を受け取る）
function fmt(v: unknown, suffix?: string): string {
  return v != null ? String(v) + (suffix || "") : "-";
}

function fmtYen(v: unknown): string {
  return v != null
    ? "¥" + Number(v).toLocaleString("ja-JP", { maximumFractionDigits: 0 })
    : "-";
}

function fmtPctHtml(v: unknown): HtmlContent {
  if (v == null) return html`-`;
  const n = Number(v);
  const sign = n >= 0 ? "+" : "";
  const color = n >= 0 ? "#22c55e" : "#ef4444";
  return html`<span style="color:${color}">${sign}${n.toFixed(2)}%</span>`;
}

function fmtDate(v: Date | string | null | undefined): string {
  if (!v) return "-";
  const d = new Date(v);
  return d.getMonth() + 1 + "/" + d.getDate();
}

function rsiColor(rsi: number | null): string | null {
  if (rsi == null) return null;
  if (rsi >= 70) return "#ef4444";
  if (rsi <= 30) return "#22c55e";
  return null;
}
