/**
 * CSV → UsageDaily 双写（红线 15：与 ModelUsage 月聚合误差 0）。
 */
import type { Prisma } from "@prisma/client";
import type { ParsedUsageRow } from "./csv-parse";

interface DayModelAcc {
  inputTokens: bigint;
  outputTokens: bigint;
  cacheHitTokens: bigint;
  cacheMissTokens: bigint;
  reasoningTokens: bigint;
  requests: number;
  costMicro: bigint;
}

function costToMicro(cost: number): bigint {
  if (!Number.isFinite(cost) || cost === 0) return BigInt(0);
  const s = cost.toFixed(9);
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [i, f = ""] = body.split(".");
  const frac = (f + "000000000").slice(0, 9);
  const raw = BigInt(i + frac);
  return neg ? -raw : raw;
}

function microToDecimal(micro: bigint): string {
  const neg = micro < BigInt(0);
  const abs = neg ? -micro : micro;
  const scale = BigInt(10) ** BigInt(9);
  const intPart = abs / scale;
  const fracPart = abs % scale;
  return (neg ? "-" : "") + intPart.toString() + "." + fracPart.toString().padStart(9, "0");
}

function monthRangeUtc(month: string): { gte: Date; lt: Date } {
  const [y, m] = month.split("-").map(Number);
  return {
    gte: new Date(Date.UTC(y, m - 1, 1)),
    lt: new Date(Date.UTC(y, m, 1)),
  };
}

export interface DualWriteResult {
  dayCount: number;
  rowCount: number;
}

export async function dualWriteUsageDaily(
  tx: Prisma.TransactionClient,
  opts: {
    userId: string;
    provider: string;
    month: string;
    rows: ParsedUsageRow[];
    currency: string | null;
    tz?: string;
  }
): Promise<DualWriteResult> {
  const { userId, provider, month, rows, currency } = opts;
  const tz = opts.tz ?? "Asia/Shanghai";
  const acc = new Map<string, DayModelAcc>();

  for (const r of rows) {
    const date = (r.startDate && r.startDate.slice(0, 10)) || month + "-01";
    const key = date + "|" + r.model;
    let a = acc.get(key);
    if (!a) {
      a = {
        inputTokens: BigInt(0),
        outputTokens: BigInt(0),
        cacheHitTokens: BigInt(0),
        cacheMissTokens: BigInt(0),
        reasoningTokens: BigInt(0),
        requests: 0,
        costMicro: BigInt(0),
      };
      acc.set(key, a);
    }
    const n = BigInt(r.amount);
    if (r.type === "input_cache_hit_tokens") {
      a.cacheHitTokens += n;
      a.inputTokens += n;
    } else if (r.type === "input_cache_miss_tokens") {
      a.cacheMissTokens += n;
      a.inputTokens += n;
    } else if (r.type === "output_tokens") {
      a.outputTokens += n;
    } else if (r.type === "request_count") {
      a.requests += r.amount;
    }
    a.costMicro += costToMicro(r.cost);
  }

  const range = monthRangeUtc(month);
  await tx.usageDaily.deleteMany({
    where: {
      userId,
      provider,
      source: "csv_official",
      date: { gte: range.gte, lt: range.lt },
    },
  });

  let rowCount = 0;
  for (const [key, a] of acc) {
    const sep = key.indexOf("|");
    const date = key.slice(0, sep);
    const model = key.slice(sep + 1);
    await tx.usageDaily.create({
      data: {
        userId,
        provider,
        model,
        date: new Date(date + "T00:00:00.000Z"),
        tz,
        source: "csv_official",
        inputTokens: a.inputTokens,
        outputTokens: a.outputTokens,
        cacheHitTokens: a.cacheHitTokens,
        cacheMissTokens: a.cacheMissTokens,
        reasoningTokens: a.reasoningTokens,
        requests: a.requests,
        cost: microToDecimal(a.costMicro),
        costComplete: true,
        currency,
      },
    });
    rowCount += 1;
  }

  return { dayCount: acc.size, rowCount };
}

export async function sumModelUsageMonthCost(
  tx: Prisma.TransactionClient,
  userId: string,
  provider: string,
  month: string
): Promise<number> {
  const rows = await tx.modelUsage.findMany({
    where: { provider: provider as never, import: { userId, month } },
    select: { cost: true },
  });
  return rows.reduce((s, r) => s + Number(r.cost.toString()), 0);
}

export async function sumUsageDailyMonthCost(
  tx: Prisma.TransactionClient,
  userId: string,
  provider: string,
  month: string
): Promise<number> {
  const range = monthRangeUtc(month);
  const rows = await tx.usageDaily.findMany({
    where: {
      userId,
      provider,
      source: "csv_official",
      date: { gte: range.gte, lt: range.lt },
    },
    select: { cost: true },
  });
  return rows.reduce((s, r) => s + Number((r.cost ?? 0).toString()), 0);
}

