/**
 * 价格/窗口种子（T9.0 占位结构）。
 * 正式种子必须由 scripts/pricing-seed 从官方页当次抓取生成，
 * 本文件仅含引擎自测用的结构说明与空数组，禁止手抄生产价入库。
 */
export interface SeedPrice {
  provider: string;
  model: string;
  effectiveFrom: string; // ISO
  currency: string;
  /** 每 1M token */
  input: string;
  output: string;
  cacheHit?: string | null;
  cacheMiss?: string | null;
  reasoning?: string | null;
  sourceUrl: string;
  checkedAt: string;
  note?: string;
}

export interface SeedWindow {
  provider: string;
  label: string;
  effectiveFrom: string;
  weekdayMask: number;
  startMinute: number;
  endMinute: number;
  tz: string;
  multiplier: string;
  sourceUrl: string;
  checkedAt: string;
}

export interface PricingSeed {
  prices: SeedPrice[];
  windows: SeedWindow[];
}

/** 空种子：生产应用前必须先跑抓取脚本写入真实价 */
export const EMPTY_SEED: PricingSeed = { prices: [], windows: [] };
