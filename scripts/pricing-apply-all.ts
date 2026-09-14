/**
 * 多 seed 落库（DeepSeek + Kimi；火山无官方可抓价则跳过）。
 * 用法：npx tsx scripts/pricing-apply-all.ts
 */
import { readdirSync, readFileSync } from "node:fs";
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
  sourceUrl?: string;
  checkedAt?: string;
  peakWindowUtc?: {
    weekdayMask: number;
    windows: Array<{ startMinute: number; endMinute: number }>;
    tz: string;
    multiplier: string;
  };
  prices?: SeedPrice[];
}

async function applySeed(file: string): Promise<void> {
  const seed = JSON.parse(readFileSync(file, "utf8")) as SeedFile;
  const prices = seed.prices ?? [];
  for (const p of prices) {
    if (!p.sourceUrl || !p.checkedAt) {
      throw new Error(`${file}: ${p.provider}/${p.model} 缺 sourceUrl/checkedAt`);
    }
    const exists = await db.price.findUnique({
      where: {
        provider_model_effectiveFrom_currency: {
          provider: p.provider,
          model: p.model,
          effectiveFrom: new Date(p.effectiveFrom),
          currency: p.currency.toUpperCase(),
        },
      },
    });
    if (exists) {
      console.log(`skip ${p.provider}/${p.model} ${p.currency}`);
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
    console.log(`+ ${p.provider}/${p.model} ${p.currency}`);
  }

  if (seed.peakWindowUtc && seed.sourceUrl && seed.checkedAt) {
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
      if (existing) continue;
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
      console.log(`+ window ${w.startMinute}-${w.endMinute}`);
    }
  }
}

async function main() {
  const dir = path.join(process.cwd(), "pricing", "seed");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(dir, f));
  for (const f of files) {
    console.log(`apply ${path.basename(f)}`);
    await applySeed(f);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
