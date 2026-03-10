/**
 * JPX 値幅制限テーブル
 *
 * 東証の1日あたりの値幅制限。基準値段（前日終値）に応じて制限値幅が決まる。
 * ストップ高/ストップ安の価格を算出し、バックテストで損切り不可能な状況をシミュレーションする。
 *
 * 参考: https://www.jpx.co.jp/equities/trading/domestic/06.html
 */

interface PriceLimitTier {
  /** この基準値段以下に適用される */
  maxBasePrice: number;
  /** 制限値幅（円） */
  limit: number;
}

/**
 * JPX 値幅制限テーブル（2024年時点）
 *
 * 基準値段が各 maxBasePrice 以下の場合、対応する limit が適用される。
 */
export const JPX_PRICE_LIMITS: readonly PriceLimitTier[] = [
  { maxBasePrice: 100, limit: 30 },
  { maxBasePrice: 200, limit: 50 },
  { maxBasePrice: 500, limit: 80 },
  { maxBasePrice: 700, limit: 100 },
  { maxBasePrice: 1_000, limit: 150 },
  { maxBasePrice: 1_500, limit: 300 },
  { maxBasePrice: 2_000, limit: 400 },
  { maxBasePrice: 3_000, limit: 500 },
  { maxBasePrice: 5_000, limit: 700 },
  { maxBasePrice: 7_000, limit: 1_000 },
  { maxBasePrice: 10_000, limit: 1_500 },
  { maxBasePrice: 15_000, limit: 3_000 },
  { maxBasePrice: 20_000, limit: 4_000 },
  { maxBasePrice: 30_000, limit: 5_000 },
  { maxBasePrice: 50_000, limit: 7_000 },
  { maxBasePrice: 70_000, limit: 10_000 },
  { maxBasePrice: 100_000, limit: 15_000 },
  { maxBasePrice: 150_000, limit: 30_000 },
  { maxBasePrice: 200_000, limit: 40_000 },
  { maxBasePrice: 300_000, limit: 50_000 },
  { maxBasePrice: 500_000, limit: 70_000 },
  { maxBasePrice: 700_000, limit: 100_000 },
  { maxBasePrice: 1_000_000, limit: 150_000 },
  { maxBasePrice: 1_500_000, limit: 300_000 },
  { maxBasePrice: 2_000_000, limit: 400_000 },
  { maxBasePrice: 3_000_000, limit: 500_000 },
  { maxBasePrice: 5_000_000, limit: 700_000 },
  { maxBasePrice: 7_000_000, limit: 1_000_000 },
  { maxBasePrice: 10_000_000, limit: 1_500_000 },
  { maxBasePrice: 15_000_000, limit: 3_000_000 },
  { maxBasePrice: 20_000_000, limit: 4_000_000 },
  { maxBasePrice: 30_000_000, limit: 5_000_000 },
  { maxBasePrice: 50_000_000, limit: 7_000_000 },
] as const;

/**
 * 基準値段から値幅制限を取得
 */
export function getPriceLimit(basePrice: number): number {
  for (const tier of JPX_PRICE_LIMITS) {
    if (basePrice <= tier.maxBasePrice) return tier.limit;
  }
  // テーブル外: 約15%をフォールバック
  return Math.round(basePrice * 0.15);
}

/**
 * ストップ安価格（制限値幅下限）を取得
 */
export function getLimitDownPrice(previousClose: number): number {
  return previousClose - getPriceLimit(previousClose);
}

/**
 * ストップ高価格（制限値幅上限）を取得
 */
export function getLimitUpPrice(previousClose: number): number {
  return previousClose + getPriceLimit(previousClose);
}
