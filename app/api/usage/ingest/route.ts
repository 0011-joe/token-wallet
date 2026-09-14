/**
 * POST /api/usage/ingest —— 本地采集器上报日聚合（红线 16/17）。
 * 鉴权：Authorization: Bearer <ingestKey>（每设备，IngestDevice）。
 * 只接受 source=host_measured；token 为非负整数字符串。
 */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import { findActiveDeviceByKey, touchDevice } from "@/lib/usage/ingest-device";
import { hitRateLimit } from "@/lib/auth/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const tokenStr = z
  .string()
  .regex(/^\d+$/, "token 计数须为非负整数字符串")
  .or(z.literal(""));

const daySchema = z.object({
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(128),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  inputTokens: z.union([tokenStr, z.number().int().nonnegative()]).optional(),
  outputTokens: z.union([tokenStr, z.number().int().nonnegative()]).optional(),
  cacheHitTokens: z.union([tokenStr, z.number().int().nonnegative()]).optional(),
  cacheMissTokens: z.union([tokenStr, z.number().int().nonnegative()]).optional(),
  reasoningTokens: z.union([tokenStr, z.number().int().nonnegative()]).optional(),
  requests: z.number().int().nonnegative().optional(),
});

const bodySchema = z.object({
  source: z.literal("host_measured"),
  tz: z.string().min(1).max(64).optional(),
  days: z.array(daySchema).min(1).max(5000),
});

function toBig(v: string | number | undefined): bigint {
  if (v === undefined || v === "") return BigInt(0);
  if (typeof v === "number") return BigInt(Math.max(0, Math.floor(v)));
  return BigInt(v);
}

function dayKey(d: string): Date {
  return new Date(d + "T00:00:00.000Z");
}

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }

  const auth = request.headers.get("authorization") ?? "";
  const key = auth.replace(/^Bearer\s+/i, "").trim();
  if (!key) {
    return NextResponse.json(
      { ok: false, error: "缺少设备密钥（Authorization: Bearer <ingestKey>）" },
      { status: 401 }
    );
  }

  const device = await findActiveDeviceByKey(user.id, key);
  if (!device) {
    return NextResponse.json({ ok: false, error: "设备密钥无效或已吊销" }, { status: 401 });
  }

  const rl = hitRateLimit({ key: `ingest:${device.id}`, limit: 60 });
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, error: "上报过于频繁，请稍后再试" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 1_000_000) {
    return NextResponse.json({ ok: false, error: "请求体过大" }, { status: 413 });
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ ok: false, error: "读取请求体失败" }, { status: 400 });
  }
  if (raw.length > 1_000_000) {
    return NextResponse.json({ ok: false, error: "请求体过大" }, { status: 413 });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      {
        ok: false,
        error: `校验失败：${issue.path.join(".")} ${issue.message}`,
      },
      { status: 400 }
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const d of parsed.data.days) {
    if (d.date > today) {
      return NextResponse.json(
        { ok: false, error: "不允许未来日期" },
        { status: 400 }
      );
    }
  }

  const nonce =
    request.headers.get("x-tw-nonce") ??
    createHash("sha256").update(raw).digest("hex").slice(0, 32);

  const payloadHash = createHash("sha256").update(raw).digest("hex");

  const result = await db.$transaction(async (tx) => {
    try {
      await tx.usageIngest.create({
        data: {
          userId: user.id,
          deviceId: device.id,
          nonce,
          source: "host_measured",
          payloadHash,
          batchCount: parsed.data.days.length,
          accepted: 0,
          rejected: 0,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        return { replay: true as const, accepted: 0 };
      }
      throw err;
    }

    let accepted = 0;
    for (const d of parsed.data.days) {
      await tx.usageDaily.upsert({
        where: {
          userId_provider_model_date_source: {
            userId: user.id,
            provider: d.provider,
            model: d.model,
            date: dayKey(d.date),
            source: "host_measured",
          },
        },
        create: {
          userId: user.id,
          provider: d.provider,
          model: d.model,
          date: dayKey(d.date),
          tz: parsed.data.tz ?? "Asia/Shanghai",
          source: "host_measured",
          inputTokens: toBig(d.inputTokens),
          outputTokens: toBig(d.outputTokens),
          cacheHitTokens: toBig(d.cacheHitTokens),
          cacheMissTokens: toBig(d.cacheMissTokens),
          reasoningTokens: toBig(d.reasoningTokens),
          requests: d.requests ?? 0,
          cost: null,
          costComplete: false,
          currency: null,
        },
        update: {
          inputTokens: toBig(d.inputTokens),
          outputTokens: toBig(d.outputTokens),
          cacheHitTokens: toBig(d.cacheHitTokens),
          cacheMissTokens: toBig(d.cacheMissTokens),
          reasoningTokens: toBig(d.reasoningTokens),
          requests: d.requests ?? 0,
          updatedAt: new Date(),
        },
      });
      accepted += 1;
    }

    await tx.usageIngest.updateMany({
      where: { nonce },
      data: { accepted, rejected: parsed.data.days.length - accepted },
    });

    return { replay: false as const, accepted };
  });

  await touchDevice(device.id);

  if (result.replay) {
    return NextResponse.json(
      { ok: false, error: "REPLAY", message: "nonce 已使用" },
      { status: 409 }
    );
  }

  return NextResponse.json({ ok: true, accepted: result.accepted });
}
