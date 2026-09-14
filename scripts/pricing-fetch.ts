/**
 * 定价页抓取 → 候选 seed JSON（D8：不写库）。
 * 用法：npx tsx scripts/pricing-fetch.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  DEEPSEEK_PRICING_EN,
  DEEPSEEK_PRICING_ZH,
  parseDeepSeekPricesFromText,
} from "../lib/pricing/fetch-parse";

async function main() {
  const timeout = Number(process.env.PRICING_SYNC_TIMEOUT_MS ?? 15000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const [enRes, zhRes] = await Promise.all([
      fetch(DEEPSEEK_PRICING_EN, { signal: ctrl.signal }),
      fetch(DEEPSEEK_PRICING_ZH, { signal: ctrl.signal }),
    ]);
    if (!enRes.ok || !zhRes.ok) {
      throw new Error(`HTTP ${enRes.status}/${zhRes.status}`);
    }
    const enText = await enRes.text();
    const zhText = await zhRes.text();
    const checkedAt = new Date().toISOString();
    const candidate = parseDeepSeekPricesFromText(enText, zhText, checkedAt);
    const dir = path.join(process.cwd(), "pricing", "candidates");
    mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${checkedAt.slice(0, 10)}.json`);
    writeFileSync(out, JSON.stringify(candidate, null, 2), "utf8");
    console.log(`candidate written: ${out}`);
    console.log("请人工审阅后运行 scripts/pricing-apply.ts（禁止自动写库）");
  } finally {
    clearTimeout(timer);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
