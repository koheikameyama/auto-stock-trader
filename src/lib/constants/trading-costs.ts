/**
 * 取引コスト定数
 *
 * 立花証券 e支店 個別手数料コース手数料 + 税金
 */

/** 手数料ティア（固定額 or 料率） */
interface CommissionTierFixed {
  maxTradeValue: number;
  commission: number;
}

interface CommissionTierRate {
  maxTradeValue: number;
  rate: number;
  maxCommission?: number;
}

export type CommissionTier = CommissionTierFixed | CommissionTierRate;

export const TRADING_COSTS = {
  /**
   * 立花証券 e支店 現物個別手数料コース 手数料テーブル（税込）
   * 1注文の約定代金に対する手数料
   */
  COMMISSION_TIERS: [
    { maxTradeValue: 100_000, commission: 77 },
    { maxTradeValue: 200_000, commission: 99 },
    { maxTradeValue: 500_000, commission: 187 },
    { maxTradeValue: 1_000_000, commission: 341 },
    { maxTradeValue: 1_500_000, commission: 407 },
    { maxTradeValue: 3_000_000, commission: 473 },
    { maxTradeValue: 6_000_000, commission: 814 },
    { maxTradeValue: 10_000_000, commission: 869 },
    { maxTradeValue: Infinity, commission: 1_100 },
  ] as CommissionTier[],

  /** 譲渡益課税（特定口座・源泉徴収あり） */
  TAX: {
    RATE: 0.20315,
  },
} as const;
