/**
 * M5 / T5.1 解析器单测：官方样本（AC4-1 解析误差为 0）+ 非法输入（AC4-3）。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CsvParseError, parseCostCsv, parseUsageCsv } from "../lib/usage/csv-parse";

const SAMPLES_DIR = path.join(process.cwd(), "samples");
const AMOUNT_CSV = path.join(SAMPLES_DIR, "amount-2026-07-31_2026-08-28.csv");
const COST_CSV = path.join(SAMPLES_DIR, "cost-2026-07-31_2026-08-28.csv");

// 探针 Q1（scripts/spike-notes.md）与样本原文一致，非臆造
const OFFICIAL_MODEL = "deepseek-v4-flash-vision-exp";
const MASKED_KEY = "sk-dbad1***********************d8d7";

describe("parseUsageCsv：官方样本（AC4-1）", () => {
  const parsed = parseUsageCsv(fs.readFileSync(AMOUNT_CSV, "utf8"));

  it("7 行、month=2026-08、单一模型", () => {
    expect(parsed.rows).toHaveLength(7);
    expect(parsed.month).toBe("2026-08");
    for (const r of parsed.rows) expect(r.model).toBe(OFFICIAL_MODEL);
  });

  it("type 分布恰为 hit:2 / miss:2 / output:2 / request_count:1", () => {
    const counts: Record<string, number> = {};
    for (const r of parsed.rows) counts[r.type] = (counts[r.type] ?? 0) + 1;
    expect(counts).toEqual({
      input_cache_hit_tokens: 2,
      input_cache_miss_tokens: 2,
      output_tokens: 2,
      request_count: 1,
    });
  });

  it("request_count 行 unitPrice=null、cost=0、amount=302", () => {
    const rc = parsed.rows.filter((r) => r.type === "request_count");
    expect(rc).toHaveLength(1);
    expect(rc[0].unitPrice).toBeNull();
    expect(rc[0].cost).toBe(0);
    expect(rc[0].amount).toBe(302);
  });

  it("同 type 多档 price 各自保留（hit 两档 14242048 / 126464）", () => {
    const hit = parsed.rows.filter((r) => r.type === "input_cache_hit_tokens");
    expect(hit.map((r) => r.unitPrice).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([0.00000005, 0.0000001]);
    const totalHit = hit.reduce((s, r) => s + r.amount, 0);
    expect(totalHit).toBe(14242048 + 126464); // = 14368512
  });

  it("api_key 打码值原样存储且 7 行一致", () => {
    for (const r of parsed.rows) expect(r.apiKeyRef).toBe(MASKED_KEY);
  });

  it("总 cost 与官方 cost 文件一致（解析误差为 0 级）", () => {
    // cost 文件列序：user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency
    const costLine = fs.readFileSync(COST_CSV, "utf8").trim().split("\n")[1];
    const official = Number(costLine.split(",")[5]);
    expect(official).toBe(2.8196908);

    const total = parsed.rows.reduce((s, r) => s + r.cost, 0);
    expect(total).toBeCloseTo(official, 5);
    expect(Math.abs(total - official)).toBeLessThan(1e-9);
  });
});

describe("parseUsageCsv：非法输入必须抛 CsvParseError（AC4-3）", () => {
  const header =
    "user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount";
  const baseRow =
    "u1,2026-08-28T00:00:00+08:00,2026-08-29T00:00:00+08:00," +
    OFFICIAL_MODEL +
    ",铠,sk-dbad1***********************d8d7";

  it("缺少列 → message 含「缺少列」与具体列名", () => {
    const csv = `${header.replace(",price", "")}\n${baseRow},input_cache_hit_tokens,5`;
    expect(() => parseUsageCsv(csv)).toThrow(CsvParseError);
    expect(() => parseUsageCsv(csv)).toThrow(/缺少列/);
    expect(() => parseUsageCsv(csv)).toThrow(/price/);

    const csv2 = `${header.replace(",price", "").replace(",amount", "")}\n${baseRow}`;
    expect(() => parseUsageCsv(csv2)).toThrow(/缺少列.*price.*amount/);
  });

  it("type 非法 → message 含非法值与原因为 type", () => {
    const csv = `${header}\n${baseRow},unknown_type,0.5,5`;
    expect(() => parseUsageCsv(csv)).toThrow(CsvParseError);
    expect(() => parseUsageCsv(csv)).toThrow(/type/);
    expect(() => parseUsageCsv(csv)).toThrow(/unknown_type/);
  });

  it("amount 负数 → 报错", () => {
    const csv = `${header}\n${baseRow},input_cache_hit_tokens,0.00000005,-5`;
    expect(() => parseUsageCsv(csv)).toThrow(CsvParseError);
    expect(() => parseUsageCsv(csv)).toThrow(/amount/);
    expect(() => parseUsageCsv(csv)).toThrow(/非负整数/);
  });

  it("amount 小数 → 报错（必须整数）", () => {
    const csv = `${header}\n${baseRow},request_count,,3.5`;
    expect(() => parseUsageCsv(csv)).toThrow(/amount/);
  });

  it("token 行 price 非数字 → 报错", () => {
    const csv = `${header}\n${baseRow},input_cache_hit_tokens,abc,5`;
    expect(() => parseUsageCsv(csv)).toThrow(/price/);
  });

  it("model / api_key 空缺 → 报错", () => {
    const noModel = `${header}\n${baseRow.replace(OFFICIAL_MODEL, "")},request_count,,5`;
    expect(() => parseUsageCsv(noModel)).toThrow(/model/);

    const noKey = `${header}\n${baseRow.replace("sk-dbad1***********************d8d7", "")},request_count,,5`;
    expect(() => parseUsageCsv(noKey)).toThrow(/api_key/);
  });

  it("空文件 / 仅表头 → 报错", () => {
    expect(() => parseUsageCsv("")).toThrow(CsvParseError);
    expect(() => parseUsageCsv("")).toThrow(/空/);
    expect(() => parseUsageCsv(`${header}\n`)).toThrow(/无数据行/);
  });

  it("多个月份 → 报错「文件包含多个月份数据」", () => {
    const csv =
      `${header}\n` +
      `${baseRow},request_count,,3\n` +
      `${baseRow.replace("2026-08-28", "2026-09-01")},request_count,,4`;
    expect(() => parseUsageCsv(csv)).toThrow(/多个月份/);
  });

  it("start_time_iso 无法识别 → 报错", () => {
    const csv = `${header}\n${baseRow.replace("2026-08-28T00:00:00+08:00", "not-a-date")},request_count,,3`;
    expect(() => parseUsageCsv(csv)).toThrow(/start_time_iso/);
  });

  it("BOM 容忍；乱码字符（U+FFFD）→ 报错", () => {
    const withBom = "\ufeff" + fs.readFileSync(AMOUNT_CSV, "utf8");
    expect(parseUsageCsv(withBom).rows).toHaveLength(7);

    const garbled = fs
      .readFileSync(AMOUNT_CSV, "utf8")
      .replace("request_count", "request_cou\uFFFDnt");
    expect(() => parseUsageCsv(garbled)).toThrow(/乱码/);
  });
});

describe("parseCostCsv：官方 cost 样本（AC4-1，Q4 币种接入）", () => {
  const parsed = parseCostCsv(fs.readFileSync(COST_CSV, "utf8"));

  it("month=2026-08、totalCost≈2.8196908、currency=CNY、walletType=Paid", () => {
    expect(parsed.month).toBe("2026-08");
    expect(parsed.totalCost).toBeCloseTo(2.8196908, 5);
    expect(Math.abs(parsed.totalCost - 2.8196908)).toBeLessThan(1e-9); // 与样本解析误差为 0 级
    expect(parsed.currency).toBe("CNY");
    expect(parsed.walletType).toBe("Paid");
  });

  it("多行求和、币种一致、walletType 取首个非空值", () => {
    const header =
      "user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency";
    const csv = `${header}
u1,2026-08-01T00:00:00+08:00,2026-08-02T00:00:00+08:00,m1,Paid,1.5,CNY
u1,2026-08-02T00:00:00+08:00,2026-08-03T00:00:00+08:00,m2,,0.75,CNY
u1,2026-08-03T00:00:00+08:00,2026-08-04T00:00:00+08:00,m3,Granted,0.25,CNY`;
    const r = parseCostCsv(csv);
    expect(r.month).toBe("2026-08");
    expect(r.totalCost).toBe(2.5);
    expect(r.currency).toBe("CNY");
    expect(r.walletType).toBe("Paid"); // 第 2 行 wallet_type 为空 → 取第 1 行非空值
  });
});

describe("parseCostCsv：非法输入必须抛 CsvParseError（AC4-3，Q4）", () => {
  const header =
    "user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency";
  const baseRow =
    "u1,2026-08-28T00:00:00+08:00,2026-08-29T00:00:00+08:00,deepseek-v4-flash-vision-exp";

  it("缺少列 → message 含「缺少列」与具体列名", () => {
    const csv = `${header.replace(",currency", "")}
${baseRow},Paid,2.8`;
    expect(() => parseCostCsv(csv)).toThrow(CsvParseError);
    expect(() => parseCostCsv(csv)).toThrow(/缺少列/);
    expect(() => parseCostCsv(csv)).toThrow(/currency/);
  });

  it("币种不一致 → 报错「cost 文件币种不一致」", () => {
    const csv = `${header}
${baseRow},Paid,1.5,CNY
${baseRow.replace("2026-08-28", "2026-08-27")},Paid,1.0,USD`;
    expect(() => parseCostCsv(csv)).toThrow(/币种不一致/);
  });

  it("多个月份 → 报错「文件包含多个月份数据」", () => {
    const csv = `${header}
${baseRow},Paid,1.5,CNY
${baseRow.replace("2026-08-28", "2026-09-28")},Paid,1.0,CNY`;
    expect(() => parseCostCsv(csv)).toThrow(/多个月份/);
  });

  it("cost 负数 / 非数字 → 报错", () => {
    const neg = `${header}
${baseRow},Paid,-1,CNY`;
    expect(() => parseCostCsv(neg)).toThrow(CsvParseError);
    expect(() => parseCostCsv(neg)).toThrow(/cost/);
    expect(() => parseCostCsv(neg)).toThrow(/非负数字/);

    const nan = `${header}
${baseRow},Paid,abc,CNY`;
    expect(() => parseCostCsv(nan)).toThrow(/cost/);
  });

  it("currency 为空 → 报错", () => {
    const csv = `${header}
${baseRow},Paid,2.8,`;
    expect(() => parseCostCsv(csv)).toThrow(/currency/);
    expect(() => parseCostCsv(csv)).toThrow(/为空/);
  });

  it("空文件 / 仅表头 → 报错", () => {
    expect(() => parseCostCsv("")).toThrow(CsvParseError);
    expect(() => parseCostCsv(`${header}
`)).toThrow(/无数据行/);
  });
});

