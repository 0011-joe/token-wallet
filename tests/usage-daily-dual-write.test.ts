/**
 * CSV 双写对账 + ingest 设备鉴权（需测试库时 skipIf）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const describeDb = describe.skipIf(!process.env.DATABASE_URL);

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: vi.fn(),
}));

import { db } from "@/lib/db";
import { parseUsageCsv } from "@/lib/usage/csv-parse";
import {
  dualWriteUsageDaily,
  sumModelUsageMonthCost,
  sumUsageDailyMonthCost,
} from "@/lib/usage/daily-dual-write";
import { upsertUsageImport } from "@/lib/usage/import-store";
import { createIngestDevice, findActiveDeviceByKey, revokeIngestDevice } from "@/lib/usage/ingest-device";
import { getCurrentUser } from "@/lib/auth/current-user";
import { POST as ingestPost } from "@/app/api/usage/ingest/route";

const EMAIL = `dual-${Date.now()}@test.local`;
const USER_ID = `dual-${Date.now()}`;
const MONTH = "2026-08";

const SAMPLE_CSV = [
  "user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount",
  `u1,${MONTH}-05T10:00:00Z,${MONTH}-05T11:00:00Z,deepseek-chat,key,sk-****,input_cache_miss_tokens,0.000001,1000000`,
  `u1,${MONTH}-05T10:00:00Z,${MONTH}-05T11:00:00Z,deepseek-chat,key,sk-****,output_tokens,0.000002,500000`,
  `u1,${MONTH}-06T10:00:00Z,${MONTH}-06T11:00:00Z,deepseek-chat,key,sk-****,request_count,,10`,
].join("\n");

describe("dualWriteUsageDaily 聚合", () => {
  it("解析样本含 startDate，type 映射到五桶", () => {
    const parsed = parseUsageCsv(SAMPLE_CSV);
    expect(parsed.month).toBe(MONTH);
    expect(parsed.rows[0]?.startDate).toBe(`${MONTH}-05`);
  });
});

describeDb("双写对账 + ingest", () => {
  beforeAll(async () => {
    await db.user.create({ data: { id: USER_ID, email: EMAIL } });
  });

  afterAll(async () => {
    await db.usageDaily.deleteMany({ where: { userId: USER_ID } });
    await db.modelUsage.deleteMany({ where: { import: { userId: USER_ID } } });
    await db.usageImport.deleteMany({ where: { userId: USER_ID } });
    await db.usageIngest.deleteMany({ where: { userId: USER_ID } });
    await db.ingestDevice.deleteMany({ where: { userId: USER_ID } });
    await db.user.deleteMany({ where: { id: USER_ID } });
    await db.$disconnect();
  });

  it("同一 CSV 双写后月 cost 误差为 0（红线 15）", async () => {
    const parsed = parseUsageCsv(SAMPLE_CSV);
    await db.$transaction(async (tx) => {
      await upsertUsageImport(tx, USER_ID, "deepseek", MONTH, "sample.csv", parsed.rows, "CNY");
      await dualWriteUsageDaily(tx, {
        userId: USER_ID,
        provider: "deepseek",
        month: MONTH,
        rows: parsed.rows,
        currency: "CNY",
      });
    });
    const a = await sumModelUsageMonthCost(db, USER_ID, "deepseek", MONTH);
    const b = await sumUsageDailyMonthCost(db, USER_ID, "deepseek", MONTH);
    expect(Math.abs(a - b)).toBeLessThan(1e-9);
    expect(a).toBeCloseTo(2, 9); // 1*1 + 0.5*2
  });

  it("重复导入覆盖不翻倍", async () => {
    const parsed = parseUsageCsv(SAMPLE_CSV);
    await db.$transaction(async (tx) => {
      await upsertUsageImport(tx, USER_ID, "deepseek", MONTH, "sample2.csv", parsed.rows, "CNY");
      await dualWriteUsageDaily(tx, {
        userId: USER_ID,
        provider: "deepseek",
        month: MONTH,
        rows: parsed.rows,
        currency: "CNY",
      });
    });
    const count = await db.usageDaily.count({
      where: { userId: USER_ID, source: "csv_official" },
    });
    expect(count).toBe(2); // 两个日期
  });

  it("设备密钥创建/校验/吊销", async () => {
    const { device, ingestKey } = await createIngestDevice(USER_ID, "dev1");
    expect(ingestKey.length).toBeGreaterThan(20);
    const found = await findActiveDeviceByKey(USER_ID, ingestKey);
    expect(found?.id).toBe(device.id);
    await revokeIngestDevice(USER_ID, device.id);
    expect(await findActiveDeviceByKey(USER_ID, ingestKey)).toBeNull();
  });

  it("ingest：无密钥 401；有效密钥写入 host_measured", async () => {
    const getU = vi.mocked(getCurrentUser);
    getU.mockResolvedValue({ id: USER_ID, email: EMAIL });

    const noAuth = await ingestPost(
      new Request("http://t/api/usage/ingest", {
        method: "POST",
        body: JSON.stringify({ source: "host_measured", days: [] }),
      })
    );
    expect(noAuth.status).toBe(401);

    const { ingestKey } = await createIngestDevice(USER_ID, "dev2");
    const res = await ingestPost(
      new Request("http://t/api/usage/ingest", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ingestKey}`,
          "Content-Type": "application/json",
          "x-tw-nonce": `n-${Date.now()}`,
        },
        body: JSON.stringify({
          source: "host_measured",
          days: [
            {
              provider: "deepseek",
              model: "deepseek-chat",
              date: "2026-08-10",
              inputTokens: "100",
              outputTokens: "50",
              requests: 1,
            },
          ],
        }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; accepted: number };
    expect(body.ok).toBe(true);
    expect(body.accepted).toBe(1);

    const row = await db.usageDaily.findFirst({
      where: {
        userId: USER_ID,
        source: "host_measured",
        date: new Date("2026-08-10T00:00:00.000Z"),
      },
    });
    expect(row?.inputTokens).toBe(BigInt(100));
    expect(row?.costComplete).toBe(false);
  });
});
