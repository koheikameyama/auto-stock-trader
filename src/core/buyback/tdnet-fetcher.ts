/**
 * やのしんTDnet WEB-API から自社株買い開示を取得 (KOH-504 / KOH-529)
 *
 * 非公式・無料API。ある期間の適時開示を一括取得し、
 * 「自己株式取得に係る事項の決定」だけを classifyBuybackTitle で抽出する。
 *
 * 障害時は null を返し、呼び出し元が「開示ゼロ」と区別して fail-loud できるようにする (KOH-529)。
 * やのしんの障害は数十分単位で続くため、試行間隔は10分(FETCH_RETRY_WAIT_MS)。
 * HTTP 200 で空 items が返る silent failure も既知(KOH-519)のため、
 * 生 items=0 は失敗として扱う(7日窓に営業日が含まれれば生開示ゼロはあり得ない)。
 */

import dayjs from "dayjs";
import { BUYBACK, classifyBuybackTitle, normalizeBuybackCode } from "../../lib/constants/buyback";

export interface BuybackDisclosure {
  /** やのしんの開示ID(重複防止キー) */
  tdnetId: string;
  /** 4桁銘柄コード(.T なし) */
  code: string;
  companyName: string;
  /** 開示日時(pubdate, "YYYY-MM-DD HH:mm:ss") */
  pubdate: string;
  title: string;
  documentUrl: string | null;
}

interface YanoshinItem {
  Tdnet: {
    id?: string;
    pubdate?: string;
    company_code?: string;
    company_name?: string;
    title?: string;
    document_url?: string | null;
  };
}

const tag = "[tdnet-fetcher]";

/**
 * 指定期間(両端含む)の自社株買い「取得決定」開示を取得する。
 * @param from 開始日
 * @param to 終了日
 * @returns 取得成功時は開示配列(0件あり得ない前提のため、フィルター後0件は正常)。
 *          やのしん障害(HTTPエラー/タイムアウト/生items空)が全試行で続いた場合は null。
 */
export async function fetchBuybackDisclosures(from: Date, to: Date): Promise<BuybackDisclosure[] | null> {
  const s = dayjs(from).format("YYYYMMDD");
  const e = dayjs(to).format("YYYYMMDD");
  const url = `${BUYBACK.YANOSHIN_BASE}/list/${s}-${e}.json?limit=100000`;

  let items: YanoshinItem[] | null = null;
  for (let attempt = 1; attempt <= BUYBACK.FETCH_RETRY_ATTEMPTS; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(url, {
        headers: { "User-Agent": "AutoStockTrader/1.0" },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        console.warn(`${tag} HTTP ${res.status} (${s}-${e}) 試行${attempt}/${BUYBACK.FETCH_RETRY_ATTEMPTS}`);
      } else {
        const json = (await res.json()) as { items?: YanoshinItem[] };
        const raw = json.items ?? [];
        if (raw.length > 0) {
          items = raw;
          break;
        }
        // 200 + 空items = やのしんの silent failure (KOH-519)。7日窓で生開示ゼロはあり得ない
        console.warn(`${tag} HTTP 200 だが items 空 (${s}-${e}) 試行${attempt}/${BUYBACK.FETCH_RETRY_ATTEMPTS} — silent failure とみなす`);
      }
    } catch (err) {
      console.error(
        `${tag} 取得失敗 (${s}-${e}) 試行${attempt}/${BUYBACK.FETCH_RETRY_ATTEMPTS}:`,
        err instanceof Error ? err.message : err,
      );
    }
    if (attempt < BUYBACK.FETCH_RETRY_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, BUYBACK.FETCH_RETRY_WAIT_MS));
    }
  }
  if (items === null) return null;

  const out: BuybackDisclosure[] = [];
  for (const it of items) {
    const d = it.Tdnet ?? {};
    if (!classifyBuybackTitle(d.title ?? "")) continue;
    const code = normalizeBuybackCode(d.company_code ?? "");
    if (!code || !d.id || !d.pubdate) continue;
    out.push({
      tdnetId: String(d.id),
      code,
      companyName: d.company_name ?? "",
      pubdate: d.pubdate,
      title: d.title ?? "",
      documentUrl: d.document_url ?? null,
    });
  }
  return out;
}
