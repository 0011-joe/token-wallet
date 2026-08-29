/**
 * T0.2 完成定义「迁移成功，可读写」：建 User → 读回 → 清理。
 */
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../lib/db";

const EMAIL = `smoke-${Date.now()}@test.local`;

describe("db smoke (T0.2)", () => {
  it("可写与可读：创建 User 并回读", async () => {
    const user = await db.user.create({ data: { email: EMAIL } });
    const found = await db.user.findUnique({ where: { email: EMAIL } });
    expect(found?.id).toBe(user.id);
  }, 15000);
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: EMAIL } });
  await db.$disconnect();
});
