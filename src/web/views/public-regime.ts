/**
 * 相場局面プロダクト（KOH-515 Phase 0）の公開ページ。
 *
 * 案B「無料は物足りなさを残す」:
 *   - 無料で見せるのは局面レベル + 一言サマリー + 基準日のみ
 *   - 指標値・シグナル内訳・D期への距離・アラートはロック表示（有料の予告）
 *   - メールのウェイトリスト登録で需要検証
 *
 * 法務ガード（KOH-500）: 客観的な「相場の状態」の記述に留め、個別銘柄の推奨・「買い時」表現はしない。
 */

import type { SignalLevel } from "../../core/regime-shift-detector";

export interface PublicRegimeData {
  level: SignalLevel;
  levelLabel: string;
  emoji: string;
  summary: string;
  asOfDate: string;
}

const LEVEL_COLOR: Record<SignalLevel, string> = {
  STRONG_BULL: "#d9772e",
  MODERATE_BULL: "#2f9e5f",
  EARLY_SIGNAL: "#c99a1e",
  NEUTRAL: "#8792a2",
};

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8C%A1%EF%B8%8F%3C/text%3E%3C/svg%3E";

function baseHead(
  title: string,
  description: string,
  ogTitle: string = title,
  ogDescription: string = description,
): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<meta property="og:title" content="${ogTitle}">
<meta property="og:description" content="${ogDescription}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="相場局面モニター">
<meta name="twitter:card" content="summary">
<link rel="icon" href="${FAVICON}">
<style>${STYLES}</style>`;
}

/** OGP・共有カード用の局面ラベル（日本語・短め） */
const LEVEL_JA_SHORT: Record<SignalLevel, string> = {
  STRONG_BULL: "大強気相場",
  MODERATE_BULL: "強気優勢",
  EARLY_SIGNAL: "強気の初期サイン",
  NEUTRAL: "中立・様子見",
};

const STYLES = `
:root{
  --bg:#eef1f5;--surface:#fff;--surface-2:#f4f6f9;--border:#d9dee6;--border-strong:#c3cad4;
  --text:#1b2330;--text-muted:#5a6576;--text-faint:#9aa4b2;--accent:#3a63a8;--accent-ink:#fff;
  --lock:#b0b8c4;--shadow:0 1px 2px rgba(20,30,50,.06),0 12px 30px rgba(20,30,50,.08);
  --sans:"Hiragino Kaku Gothic ProN","Hiragino Sans","Yu Gothic","Noto Sans JP",system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0d1016;--surface:#161b23;--surface-2:#1c222c;--border:#2a323e;--border-strong:#38424f;
  --text:#e7ebf1;--text-muted:#9aa5b4;--text-faint:#667082;--accent:#6c93d6;--accent-ink:#0d1016;
  --lock:#4a5563;--shadow:0 1px 2px rgba(0,0,0,.3),0 14px 34px rgba(0,0,0,.45);
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.6;-webkit-font-smoothing:antialiased}
.wrap{max-width:560px;margin:0 auto;padding:40px 20px 64px}
.brand{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted);padding:5px 11px;border:1px solid var(--border);border-radius:999px;background:var(--surface)}
.brand .dot{width:8px;height:8px;border-radius:50%}
h1{font-size:clamp(22px,5vw,30px);line-height:1.2;margin:18px 0 8px;letter-spacing:-.01em;text-wrap:balance;font-weight:800}
.tagline{margin:0 0 28px;color:var(--text-muted);font-size:15px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow);overflow:hidden}
.verdict{display:flex;gap:16px;align-items:center;padding:22px 20px}
.lamp{width:58px;height:58px;border-radius:50%;flex:none;display:grid;place-items:center;background:color-mix(in srgb,var(--lamp-c) 16%,var(--surface));border:1.5px solid color-mix(in srgb,var(--lamp-c) 45%,transparent)}
.lamp::after{content:"";width:26px;height:26px;border-radius:50%;background:var(--lamp-c);box-shadow:0 0 0 6px color-mix(in srgb,var(--lamp-c) 20%,transparent)}
.lv-name{font-family:var(--mono);font-weight:700;font-size:17px;letter-spacing:.02em;color:var(--lamp-c)}
.one-line{font-size:14px;color:var(--text);margin-top:3px}
.asof{font-family:var(--mono);font-size:11px;color:var(--text-faint);margin-top:5px}
.locked{display:flex;flex-direction:column;gap:1px;border-top:1px solid var(--border)}
.locked-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 20px;background:var(--surface-2);color:var(--text-faint);font-size:13px}
.locked-row .lk{color:var(--lock)}
.gate{padding:20px;border-top:1px dashed var(--border-strong)}
.gate h2{font-size:16px;margin:0 0 4px}
.gate p{margin:0 0 14px;font-size:13px;color:var(--text-muted)}
form{display:flex;gap:8px;flex-wrap:wrap}
input[type=email]{flex:1;min-width:180px;padding:12px 14px;border:1px solid var(--border-strong);border-radius:10px;background:var(--bg);color:var(--text);font-size:15px;font-family:var(--sans)}
input[type=email]:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
button{appearance:none;border:none;cursor:pointer;background:var(--accent);color:var(--accent-ink);font-family:var(--sans);font-size:14.5px;font-weight:700;padding:12px 18px;border-radius:10px}
button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.fine{margin:10px 0 0;font-size:11.5px;color:var(--text-faint)}
.foot{margin-top:28px;padding-top:18px;border-top:1px solid var(--border);font-size:12px;color:var(--text-muted);display:flex;flex-direction:column;gap:7px}
.foot .row{display:flex;gap:8px;align-items:flex-start}
.result{text-align:center;padding:8px 0 4px}
.result .big{font-size:40px;line-height:1}
.result h1{margin:14px 0 6px}
.result p{color:var(--text-muted);margin:0 0 22px}
.back{display:inline-block;background:var(--accent);color:var(--accent-ink);text-decoration:none;font-weight:700;padding:11px 20px;border-radius:10px;font-size:14px}
`;

/** 局面が取得できない時のフォールバック表示 */
const UNAVAILABLE_VERDICT = `
<div class="verdict" style="--lamp-c:#8792a2">
  <div class="lamp"></div>
  <div>
    <div class="lv-name">集計中</div>
    <div class="one-line">相場局面を集計しています。しばらくお待ちください。</div>
  </div>
</div>`;

export function publicRegimePage(data: PublicRegimeData | null): string {
  const title = "相場局面モニター";
  const description =
    "日本株の相場局面（強気か・休むべきか）を毎日ひと目で。breadth・VIX・日経の客観データから局面を判定します。";

  const verdict = data
    ? `<div class="verdict" style="--lamp-c:${LEVEL_COLOR[data.level]}">
        <div class="lamp"></div>
        <div>
          <div class="lv-name">${data.emoji} ${data.levelLabel}</div>
          <div class="one-line">${data.summary}</div>
          <div class="asof">${data.asOfDate} 引け時点</div>
        </div>
      </div>`
    : UNAVAILABLE_VERDICT;

  // シェアされた時に現局面がカードに出るよう OGP を動的化
  const ogTitle = data
    ? `${data.emoji} 日本株の相場局面：${LEVEL_JA_SHORT[data.level]}（${data.asOfDate}）`
    : title;
  const ogDescription = data ? data.summary : description;

  return `<!doctype html><html lang="ja"><head>${baseHead(title, description, ogTitle, ogDescription)}</head>
<body>
  <div class="wrap">
    <span class="brand"><span class="dot" style="background:${data ? LEVEL_COLOR[data.level] : "#8792a2"}"></span>相場局面モニター</span>
    <h1>いま、攻めるか休むか。</h1>
    <p class="tagline">日本株の相場局面を、毎日ひと目で。</p>

    <div class="card">
      ${verdict}
      <div class="locked">
        <div class="locked-row"><span>主要指標（breadth / VIX / 日経）</span><span class="lk">🔒</span></div>
        <div class="locked-row"><span>5シグナルの点灯状況</span><span class="lk">🔒</span></div>
        <div class="locked-row"><span>大強気相場まであと何が必要か</span><span class="lk">🔒</span></div>
        <div class="locked-row"><span>局面が変わったら即通知（アラート）</span><span class="lk">🔒</span></div>
      </div>
      <div class="gate">
        <h2>アラートの先行案内を受け取る</h2>
        <p>局面が変わった瞬間に届く通知や、指標の内訳を準備中です。公開時にご案内します。</p>
        <form method="post" action="/live/waitlist">
          <input type="email" name="email" placeholder="you@example.com" required autocomplete="email" inputmode="email">
          <button type="submit">登録する</button>
        </form>
        <p class="fine">登録は先行案内のみに使用します。いつでも解除できます。</p>
      </div>
    </div>

    <div class="foot">
      <div class="row"><span>⚖️</span><span>本サービスは客観的な市場データの提示のみを行い、個別銘柄の売買を推奨するものではありません。投資判断はご自身の責任で行ってください。</span></div>
      <div class="row"><span>📊</span><span>データ：東証全体の騰落（breadth）／VIX／日経225。引け後に日次更新。</span></div>
    </div>
  </div>
</body></html>`;
}

export function waitlistResultPage(opts: { ok: boolean; message: string }): string {
  const title = opts.ok ? "登録ありがとうございます" : "登録できませんでした";
  return `<!doctype html><html lang="ja"><head>${baseHead(title, "相場局面モニター")}</head>
<body>
  <div class="wrap">
    <div class="card" style="padding:32px 24px">
      <div class="result">
        <div class="big">${opts.ok ? "✅" : "⚠️"}</div>
        <h1>${title}</h1>
        <p>${opts.message}</p>
        <a class="back" href="/live">相場局面モニターへ戻る</a>
      </div>
    </div>
  </div>
</body></html>`;
}
