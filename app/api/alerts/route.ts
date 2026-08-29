/**
 * /api/alerts —— 预警设置与事件（M6 / T6.3）。
 *
 * GET /api/alerts：当前用户最近 50 条预警事件 + 当前预警设置。
 *   返回 { events: [{id,type,apiKeyId,message,severity,createdAt}], settings }。
 *   注意：severity 是后端按 type 映射的**派生字段，非数据库字段**
 *   （UNAVAILABLE→critical，其他→warning），便于前端直接渲染样式。
 * PUT /api/alerts：body { lowBalanceThreshold?, failThresholdN?, emailEnabled?, inappEnabled? }。
 *   - lowBalanceThreshold 必须为 >= 0 的数字（AC5：阈值不允许为负），否则 400；
 *   - failThresholdN 必须为正整数；两个开关必须为布尔；
 *   - 按 userId upsert AlertSetting（无记录则创建，默认值 = schema 默认值）。
 *
 * 鉴权：复用 lib/auth/current-user（getServerSession → email 回查 User，未登录 401）。
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import {
  DEFAULT_FAIL_THRESHOLD_N,
  DEFAULT_LOW_BALANCE_THRESHOLD,
  type AlertType,
} from "@/lib/alerts/evaluate";

export const dynamic = "force-dynamic";

/** severity 为派生字段（非表字段）：UNAVAILABLE→critical，其余→warning。 */
function severityOf(type: string): "critical" | "warning" {
  return type === "UNAVAILABLE" ? "critical" : "warning";
}

/** schema 默认值（与 AlertSetting 的 @default 一致）。 */
const DEFAULT_SETTINGS = {
  lowBalanceThreshold: DEFAULT_LOW_BALANCE_THRESHOLD,
  failThresholdN: DEFAULT_FAIL_THRESHOLD_N,
  emailEnabled: true,
  inappEnabled: true,
};

export async function GET(): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  const [settingsRow, events] = await Promise.all([
    db.alertSetting.findUnique({ where: { userId: user.id } }),
    db.alertEvent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  return NextResponse.json({
    events: events.map((e) => ({
      id: e.id,
      type: e.type as AlertType,
      apiKeyId: e.apiKeyId,
      message: e.message,
      severity: severityOf(e.type), // 派生字段，非数据库列
      createdAt: e.createdAt.toISOString(),
    })),
    settings: settingsRow ?? DEFAULT_SETTINGS,
  });
}

interface SettingsUpdate {
  lowBalanceThreshold?: number;
  failThresholdN?: number;
  emailEnabled?: boolean;
  inappEnabled?: boolean;
}

/** 校验并抽取可更新字段；非法返回错误文案（undefined 项按缺省处理）。 */
function parseSettingsUpdate(body: Record<string, unknown>):
  | { ok: true; data: SettingsUpdate }
  | { ok: false; error: string } {
  const {
    lowBalanceThreshold,
    failThresholdN,
    emailEnabled,
    inappEnabled,
  } = body;
  const data: SettingsUpdate = {};

  if (lowBalanceThreshold !== undefined) {
    if (
      typeof lowBalanceThreshold !== "number" ||
      !Number.isFinite(lowBalanceThreshold) ||
      lowBalanceThreshold < 0
    ) {
      return { ok: false, error: "低余额阈值必须是不小于 0 的数字" };
    }
    data.lowBalanceThreshold = lowBalanceThreshold;
  }
  if (failThresholdN !== undefined) {
    if (
      typeof failThresholdN !== "number" ||
      !Number.isInteger(failThresholdN) ||
      failThresholdN < 1
    ) {
      return { ok: false, error: "连续失败次数 N 必须是正整数" };
    }
    data.failThresholdN = failThresholdN;
  }
  if (emailEnabled !== undefined) {
    if (typeof emailEnabled !== "boolean") {
      return { ok: false, error: "emailEnabled 必须是布尔值" };
    }
    data.emailEnabled = emailEnabled;
  }
  if (inappEnabled !== undefined) {
    if (typeof inappEnabled !== "boolean") {
      return { ok: false, error: "inappEnabled 必须是布尔值" };
    }
    data.inappEnabled = inappEnabled;
  }
  if (Object.keys(data).length === 0) {
    return { ok: false, error: "缺少可更新的字段" };
  }
  return { ok: true, data };
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  }

  const parsed = parseSettingsUpdate(body as Record<string, unknown>);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const saved = await db.alertSetting.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      lowBalanceThreshold:
        parsed.data.lowBalanceThreshold ?? DEFAULT_SETTINGS.lowBalanceThreshold,
      failThresholdN: parsed.data.failThresholdN ?? DEFAULT_SETTINGS.failThresholdN,
      emailEnabled: parsed.data.emailEnabled ?? DEFAULT_SETTINGS.emailEnabled,
      inappEnabled: parsed.data.inappEnabled ?? DEFAULT_SETTINGS.inappEnabled,
    },
    update: parsed.data,
  });

  return NextResponse.json({
    settings: {
      lowBalanceThreshold: saved.lowBalanceThreshold,
      failThresholdN: saved.failThresholdN,
      emailEnabled: saved.emailEnabled,
      inappEnabled: saved.inappEnabled,
    },
  });
}
