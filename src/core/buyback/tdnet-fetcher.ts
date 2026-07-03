/**
 * やのしんTDnet WEB-API から自社株買い開示を取得 (KOH-504)
 *
 * 非公式・無料API。ある期間の適時開示を一括取得し、
 * 「自己株式取得に係る事項の決定」だけを classifyBuybackTitle で抽出する。
 * 障害時は空配列を返して呼び出し元でリトライ判定(news-fetcher.ts と同じ作法)。
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
 */
export async function fetchBuybackDisclosures(from: Date, to: Date): Promise<BuybackDisclosure[]> {
  const s = dayjs(from).format("YYYYMMDD");
  const e = dayjs(to).format("YYYYMMDD");
  const url = `${BUYBACK.YANOSHIN_BASE}/list/${s}-${e}.json?limit=100000`;

  // やのしんは非公式・無料でしばしば 5xx/タイムアウトするため 3回リトライ(指数バックオフ)
  let items: YanoshinItem[] | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(url, {
        headers: { "User-Agent": "AutoStockTrader/1.0" },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        console.warn(`${tag} HTTP ${res.status} (${s}-${e}) 試行${attempt}/3`);
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
          continue;
        }
        return [];
      }
      const json = (await res.json()) as { items?: YanoshinItem[] };
      items = json.items ?? [];
      break;
    } catch (err) {
      console.error(`${tag} 取得失敗 (${s}-${e}) 試行${attempt}/3:`, err instanceof Error ? err.message : err);
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      return [];
    }
  }
  if (items === null) return [];

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
