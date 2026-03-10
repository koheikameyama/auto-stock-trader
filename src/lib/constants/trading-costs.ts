/**
 * 取引コスト定数
 *
 * 立花証券 e-Supportプラン手数料 + 税金
 */

/** 手数料ティア（固定額 or 料率） */
interface CommissionTierFixed {
  maxTradeValue: number;
  commission: number;
}

interface CommissionTierRate {
  maxTradeValue: number;
  rate: number;
}

export type CommissionTier = CommissionTierFixed | CommissionTierRate;

export const TRADING_COSTS = {
  /** 立花証券 e-Supportプラン 手数料テーブル（税込） */
  COMMISSION_TIERS: [
    { maxTradeValue: 100_000, commission: 0 },
    { maxTradeValue: 500_000, commission: 264 },
    { maxTradeValue: 1_000_000, commission: 517 },
    { maxTradeValue: Infinity, rate: 0.000517 },
  ] as CommissionTier[],

  /** 譲渡益課税（特定口座・源泉徴収あり） */
  TAX: {
    RATE: 0.20315,
  },
} as const;
