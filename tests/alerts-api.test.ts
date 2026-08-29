/**
 * M6 / T6.3 alerts 路由集成测试：mock next-auth 会话，走真实 Postgres 测试库，
 * 验证：PUT 阈值非负校验（AC5：阈值不允许为负）、部分字段更新 upsert 保留其余字段、
 * GET 返回设置 + 事件列表（severity 为后端派生字段）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/auth", () => ({ authOptions: {} }));

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { GET, PUT } from "../app/api/alerts/route";
import { db } from "../lib/db";

const EMAIL = `unit-alerts-${Date.now()}@test.local`;
const USER_ID = `unit-alerts-${Date.now()}`;

const mockSession = vi.mocked(getServerSession);
function session(email: string | null): Session {
  return {
    user: { email },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function putReq(body: unknown, url = "http://localhost/api/alerts"): NextRequest {
  return new NextRequest(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await db.user.create({ data: { id: USER_ID, email: EMAIL } });
});

afterAll(async () => {
  await db.user.delete({ where: { id: USER_ID } }).catch(() => {});
});

describe("PUT /api/alerts 设置校验与 upsert（AC5：阈值非负 / 渠道开关生效）", () => {
  it("未登录 → 401", async () => {
    mockSession.mockResolvedValueOnce(null);
    const res = await PUT(putReq({ lowBalanceThreshold: 10 }));
    expect(res.status).toBe(401);
  });

  it("低余额阈值为负数 → 400", async () => {
    mockSession.mockResolvedValueOnce(session(EMAIL));
    const res = await PUT(putReq({ lowBalanceThreshold: -1 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("不小于 0");
  });

  it("failThresholdN 非正整数 → 400", async () => {
    mockSession.mockResolvedValueOnce(session(EMAIL));
    const res = await PUT(putReq({ failThresholdN: 0 }));
    expect(res.status).toBe(400);
  });

  it("合法阈值 upsert 成功，并返回保存后的设置", async () => {
    mockSession.mockResolvedValueOnce(session(EMAIL));
    const res = await PUT(
      putReq({ lowBalanceThreshold: 50, failThresholdN: 5, emailEnabled: false })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: {
        lowBalanceThreshold: number;
        failThresholdN: number;
        emailEnabled: boolean;
        inappEnabled: boolean;
      };
    };
    expect(body.settings).toMatchObject({
      lowBalanceThreshold: 50,
      failThresholdN: 5,
      emailEnabled: false,
      inappEnabled: true, // 未传字段沿用默认 true
    });
    const row = await db.alertSetting.findUnique({ where: { userId: USER_ID } });
    expect(row).toMatchObject({
      lowBalanceThreshold: 50,
      failThresholdN: 5,
      emailEnabled: false,
      inappEnabled: true,
    });
  });

  it("部分更新（只传 inappEnabled）不覆盖已保存的其他字段", async () => {
    mockSession.mockResolvedValueOnce(session(EMAIL));
    const res = await PUT(putReq({ inappEnabled: false }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: { lowBalanceThreshold: number } };
    expect(body.settings.lowBalanceThreshold).toBe(50); // 保留上次保存值
    const row = await db.alertSetting.findUnique({ where: { userId: USER_ID } });
    expect(row?.inappEnabled).toBe(false);
  });

  it("空 body（无可更新字段）→ 400", async () => {
    mockSession.mockResolvedValueOnce(session(EMAIL));
    const res = await PUT(putReq({}));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/alerts 设置与事件列表", () => {
  it("返回设置 + 事件（severity 派生：UNAVAILABLE→critical，其他→warning）", async () => {
    mockSession.mockResolvedValueOnce(session(EMAIL));
    await db.alertEvent.create({
      data: {
        userId: USER_ID,
        apiKeyId: "fake-key-1",
        type: "UNAVAILABLE",
        message: "Key sk-****d8d7 判定为不可用",
        dedupKey: "UNAVAILABLE:fake-key-1",
      },
    });
    await db.alertEvent.create({
      data: {
        userId: USER_ID,
        apiKeyId: "fake-key-2",
        type: "LOW_BALANCE",
        message: "Key sk-****a1b2 余额 5CNY",
        dedupKey: "LOW_BALANCE:fake-key-2",
      },
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: { lowBalanceThreshold: number; inappEnabled: boolean };
      events: Array<{
        type: string;
        severity: string;
        createdAt: string;
      }>;
    };
    expect(body.settings.lowBalanceThreshold).toBe(50);
    expect(body.settings.inappEnabled).toBe(false);
    // createdAt desc：LOW_BALANCE（后写的）在前
    expect(body.events.map((e) => e.type)).toEqual(["LOW_BALANCE", "UNAVAILABLE"]);
    const severities = new Map(
      body.events.map((e) => [e.type, e.severity] as const)
    );
    expect(severities.get("UNAVAILABLE")).toBe("critical");
    expect(severities.get("LOW_BALANCE")).toBe("warning");
    for (const e of body.events) {
      expect(typeof e.createdAt).toBe("string");
    }
  });
});
