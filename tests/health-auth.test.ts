/**
 * /api/health 鉴权集成测试（P0）：mock DB 查询，不依赖真实库。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    credential: {
      findMany: (...args: unknown[]) => findMany(...args),
    },
  },
}));

import { GET as healthGet } from "@/app/api/health/route";

describe("/api/health auth", () => {
  beforeEach(() => {
    findMany.mockReset();
    findMany.mockResolvedValue([]);
    vi.stubEnv("CRON_SECRET", "health-test-secret");
    vi.stubEnv("AUTH_SECRET", "other-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("无凭据 → 401", async () => {
    const res = await healthGet(new Request("http://test/api/health"));
    expect(res.status).toBe(401);
  });

  it("错误 Bearer → 401", async () => {
    const res = await healthGet(
      new Request("http://test/api/health", {
        headers: { authorization: "Bearer wrong" },
      })
    );
    expect(res.status).toBe(401);
  });

  it("正确 Bearer → 200", async () => {
    const res = await healthGet(
      new Request("http://test/api/health", {
        headers: { authorization: "Bearer health-test-secret" },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; providers: unknown };
    expect(body.ok).toBe(true);
  });

  it("x-health-secret 亦可鉴权", async () => {
    const res = await healthGet(
      new Request("http://test/api/health", {
        headers: { "x-health-secret": "health-test-secret" },
      })
    );
    expect(res.status).toBe(200);
  });

  it("未配置任何 secret 且 NODE_ENV=production → 503", async () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");
    const res = await healthGet(new Request("http://test/api/health"));
    expect(res.status).toBe(503);
  });
});
