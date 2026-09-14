/**
 * Budgets API 集成（测试库）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const describeDb = describe.skipIf(!process.env.DATABASE_URL);

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: vi.fn(),
}));

import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { GET as budgetsGet, POST as budgetsPost } from "@/app/api/budgets/route";
import { DELETE as budgetDelete } from "@/app/api/budgets/[id]/route";

const EMAIL = `budget-${Date.now()}@test.local`;
const USER_ID = `budget-${Date.now()}`;

describeDb("POST/GET/DELETE /api/budgets", () => {
  beforeAll(async () => {
    await db.user.create({ data: { id: USER_ID, email: EMAIL } });
    vi.mocked(getCurrentUser).mockResolvedValue({ id: USER_ID, email: EMAIL });
  });

  afterAll(async () => {
    await db.budget.deleteMany({ where: { userId: USER_ID } });
    await db.user.deleteMany({ where: { id: USER_ID } });
    await db.$disconnect();
  });

  it("非法阈值 400", async () => {
    const res = await budgetsPost(
      new Request("http://t/api/budgets", {
        method: "POST",
        body: JSON.stringify({
          amount: "10",
          currency: "CNY",
          warnPct: 100,
          criticalPct: 80,
        }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("创建成功并可列表，删除后消失", async () => {
    const create = await budgetsPost(
      new Request("http://t/api/budgets", {
        method: "POST",
        body: JSON.stringify({
          amount: "100.5",
          currency: "cny",
          period: "month",
          scope: "global",
          warnPct: 80,
          criticalPct: 100,
          runwayAlertDays: 3,
        }),
      })
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as { budget: { id: string; currency: string } };
    expect(created.budget.currency).toBe("CNY");

    const list = await budgetsGet();
    expect(list.status).toBe(200);
    const body = (await list.json()) as { budgets: Array<{ id: string }> };
    expect(body.budgets.some((b) => b.id === created.budget.id)).toBe(true);

    const del = await budgetDelete(
      new Request("http://t/api/budgets/x", { method: "DELETE" }),
      { params: Promise.resolve({ id: created.budget.id }) }
    );
    expect(del.status).toBe(200);

    const list2 = await budgetsGet();
    const body2 = (await list2.json()) as { budgets: Array<{ id: string }> };
    expect(body2.budgets.some((b) => b.id === created.budget.id)).toBe(false);
  });
});
