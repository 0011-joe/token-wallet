/**
 * M5 / T5.2 幂等入库单测（AC4-2：同月覆盖不翻倍）。
 * 直接测 upsertUsageImport（纯数据函数，route 只做薄封装），
 * 用唯一 userId 隔离数据，afterAll 清理。
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../lib/db";
import { parseUsageCsv } from "../lib/usage/csv-parse";
import { upsertUsageImport } from "../lib/usage/import-store";

const AMOUNT_CSV = path.join(
  process.cwd(),
  "samples",
  "amount-2026-07-31_2026-08-28.csv"
);

const USER_ID = `unit-import-${Date.now()}`;
// 远离真实数据的月份，避免与真实导入冲突
const MONTH_A = "2099-01";
const MONTH_B = "2099-02";

describe("upsertUsageImport 幂等覆盖（AC4-2）", () => {
  it("同月重复导入：importId 不变、行数不翻倍、元数据被覆盖", async () => {
    const parsed = parseUsageCsv(fs.readFileSync(AMOUNT_CSV, "utf8"));

    const first = await db.$transaction((tx) =>
      upsertUsageImport(tx, USER_ID, MONTH_A, "first.csv", parsed.rows)
    );
    const second = await db.$transaction((tx) =>
      upsertUsageImport(tx, USER_ID, MONTH_A, "second.csv", parsed.rows)
    );

    // upsert 命中同一行：importId 不变，rowCount 恒为 7
    expect(second.importId).toBe(first.importId);
    expect(first.rowCount).toBe(7);
    expect(second.rowCount).toBe(7);

    const imp = await db.usageImport.findUnique({
      where: { userId_month: { userId: USER_ID, month: MONTH_A } },
      include: { rows: true },
    });
    expect(imp).not.toBeNull();
    expect(imp!.fileName).toBe("second.csv");
    expect(imp!.rows).toHaveLength(7); // 不翻倍

    // 覆盖后数值仍是样本合计，而非翻倍
    const totalAmount = imp!.rows.reduce((s, r) => s + r.amount, 0);
    const expectAmount = parsed.rows.reduce((s, r) => s + r.amount, 0);
    expect(totalAmount).toBe(expectAmount);
    const totalCost = imp!.rows.reduce((s, r) => s + r.cost, 0);
    expect(totalCost).toBeCloseTo(2.8196908, 5);
  });

  it("不同月份互不影响", async () => {
    const parsed = parseUsageCsv(fs.readFileSync(AMOUNT_CSV, "utf8"));
    await db.$transaction((tx) =>
      upsertUsageImport(tx, USER_ID, MONTH_B, "feb.csv", parsed.rows)
    );
    const count = await db.usageImport.count({ where: { userId: USER_ID } });
    expect(count).toBe(2);
  });
});

afterAll(async () => {
  await db.usageImport.deleteMany({ where: { userId: USER_ID } });
  await db.$disconnect();
});

describe("upsertUsageImport currency 语义（Q4：cost 文件币种）", () => {
  const MONTH_C = "2099-05";
  const MONTH_D = "2099-06";

  it("带 cost 文件导入 → currency 落库；再带不同币种 → 覆盖", async () => {
    const parsed = parseUsageCsv(fs.readFileSync(AMOUNT_CSV, "utf8"));
    // 首次不带 cost 文件：currency=null
    await db.$transaction((tx) =>
      upsertUsageImport(tx, USER_ID, MONTH_C, "c0.csv", parsed.rows)
    );
    let imp = await db.usageImport.findUniqueOrThrow({
      where: { userId_month: { userId: USER_ID, month: MONTH_C } },
    });
    expect(imp.currency).toBeNull();

    // 带 cost 文件（CNY）→ 落库
    await db.$transaction((tx) =>
      upsertUsageImport(tx, USER_ID, MONTH_C, "c1.csv", parsed.rows, "CNY")
    );
    imp = await db.usageImport.findUniqueOrThrow({
      where: { userId_month: { userId: USER_ID, month: MONTH_C } },
    });
    expect(imp.currency).toBe("CNY");

    // 再带不同币种（USD）→ 覆盖
    await db.$transaction((tx) =>
      upsertUsageImport(tx, USER_ID, MONTH_C, "c2.csv", parsed.rows, "USD")
    );
    imp = await db.usageImport.findUniqueOrThrow({
      where: { userId_month: { userId: USER_ID, month: MONTH_C } },
    });
    expect(imp.currency).toBe("USD");
  });

  it("不带 cost 文件重复导入 → currency 保留旧值（不回退为 null）", async () => {
    const parsed = parseUsageCsv(fs.readFileSync(AMOUNT_CSV, "utf8"));
    await db.$transaction((tx) =>
      upsertUsageImport(tx, USER_ID, MONTH_D, "d1.csv", parsed.rows, "CNY")
    );
    // 同月再只传 amount：update 分支不动 currency
    await db.$transaction((tx) =>
      upsertUsageImport(tx, USER_ID, MONTH_D, "d2.csv", parsed.rows)
    );
    const imp = await db.usageImport.findUniqueOrThrow({
      where: { userId_month: { userId: USER_ID, month: MONTH_D } },
    });
    expect(imp.currency).toBe("CNY");
    expect(imp.fileName).toBe("d2.csv"); // 其余元数据仍被覆盖
  });
});

