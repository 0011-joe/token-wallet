/**
 * 价格种子落库（D8：只追加；sourceUrl/checkedAt 必填）。
 * 用法：npx tsx scripts/pricing-apply.ts [seed.json]
 * 默认 seed：pricing/seed/deepseek-2026-09-14.json
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { db } from "../lib/db";

interface SeedPrice {
  provider: string;
  model: string;
  effectiveFrom: string;
  currency: string;
  input: string;
  output: string;
  cacheHit?: string | null;
  cacheMiss?: string | null;
  reasoning?: string | null;
  sourceUrl: string;
  checkedAt: string;
  note?: string;
}

interface SeedFile {
  asOf: string;
  sourceUrl: string;
  checkedAt: string;
  peakWindowUtc: {
    weekdayMask: number;
    windows: Array<{ startMinute: number; endMinute: number }>;
    tz: string;
    multiplier: string;
  };
  prices: SeedPrice[];
}

async function main() {
  const file =
    process.argv[2] ??
    path.join(process.cwd(), "pricing", "seed", "deepseek-2026-09-14.json");
  const raw = readFileSync(file, "utf8");
  const seed = JSON.parse(raw) as SeedFile;

  if (!seed.sourceUrl || !seed.checkedAt) {
    throw new Error("种子必须包含 sourceUrl 与 checkedAt");
  }

  let priceCount = 0;
  for (const p of seed.prices) {
    if (!p.sourceUrl || !p.checkedAt) {
      throw new Error(`价格 ${p.provider}/${p.model} 缺少 sourceUrl/checkedAt`);
    }
    const where = {
      provider_model_effectiveFrom_currency: {
        provider: p.provider,
        model: p.model,
        effectiveFrom: new Date(p.effectiveFrom),
        currency: p.currency.toUpperCase(),
      },
    };
    const exists = await db.price.findUnique({ where });
    if (exists) {
      console.log(`skip existing ${p.provider}/${p.model} ${p.currency}`);
      continue;
    }
    await db.price.create({
      data: {
        provider: p.provider,
        model: p.model,
        effectiveFrom: new Date(p.effectiveFrom),
        currency: p.currency.toUpperCase(),
        input: p.input,
        output: p.output,
        cacheHit: p.cacheHit ?? null,
        cacheMiss: p.cacheMiss ?? null,
        reasoning: p.reasoning ?? null,
        sourceUrl: p.sourceUrl,
        checkedAt: new Date(p.checkedAt),
        note: p.note ?? null,
      },
    });
    priceCount += 1;
    console.log(`+ price ${p.provider}/${p.model} ${p.currency}`);
  }

  let windowCount = 0;
  for (const w of seed.peakWindowUtc.windows) {
    const effectiveFrom = new Date(seed.checkedAt);
    const existing = await db.priceWindow.findFirst({
      where: {
        provider: "deepseek",
        effectiveFrom,
        startMinute: w.startMinute,
        endMinute: w.endMinute,
      },
    });
    if (existing) {
      console.log(`skip window ${w.startMinute}-${w.endMinute}`);
      continue;
    }
    await db.priceWindow.create({
      data: {
        provider: "deepseek",
        label: "peak",
        effectiveFrom,
        weekdayMask: seed.peakWindowUtc.weekdayMask,
        startMinute: w.startMinute,
        endMinute: w.endMinute,
        tz: seed.peakWindowUtc.tz,
        multiplier: seed.peakWindowUtc.multiplier,
        sourceUrl: seed.sourceUrl,
        checkedAt: new Date(seed.checkedAt),
      },
    });
    windowCount += 1;
    console.log(`+ window ${w.startMinute}-${w.endMinute} ${seed.peakWindowUtc.tz}`);
  }

  console.log(`done: +${priceCount} prices, +${windowCount} windows`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
