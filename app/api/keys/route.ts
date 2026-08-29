/**
 * /api/keys —— Key 增删查改接口（T2.1/T2.2/T2.3）。
 *
 * 鉴权：getServerSession(authOptions)，未登录 401。
 * 安全红线：apiKey 明文只用于实测（fetchBalance）与加密入库，绝不写日志、绝不回传；
 * 所有响应只含 id/label/last4/isActive/failCount/lastStatus/createdAt，不含密文。
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import { db } from "@/lib/db";
import { fetchBalance } from "@/lib/deepseek/client";
import { addKey, deleteKey, listKeys, updateKey } from "@/lib/keys/service";
import { keysRepo } from "@/lib/keys/repo";

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "未登录" }, { status: 401 });
}

/**
 * 取当前登录用户 id。
 * auth.ts 的 session 策略为 jwt，session.user 默认不含 id（只有 email/name/image），
 * 因此以 email 回查数据库拿到 userId；若两种途径都取不到则视为未登录。
 */
async function authenticate(): Promise<
  { userId: string } | { response: NextResponse }
> {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return { response: unauthorized() };
  }
  const user = session.user as { id?: string; email?: string | null };
  if (typeof user.id === "string" && user.id !== "") {
    return { userId: user.id };
  }
  if (typeof user.email === "string" && user.email !== "") {
    const found = await db.user.findUnique({
      where: { email: user.email },
      select: { id: true },
    });
    if (found) {
      return { userId: found.id };
    }
  }
  return { response: unauthorized() };
}

/** GET /api/keys：当前用户全部 Key（只含掩码字段） */
export async function GET(): Promise<NextResponse> {
  const auth = await authenticate();
  if ("response" in auth) return auth.response;
  const keys = await listKeys(auth.userId, keysRepo);
  return NextResponse.json({ keys });
}

/** POST /api/keys：body { label?, apiKey }，添加即实测校验（AC1-1/2/3/4） */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await authenticate();
  if ("response" in auth) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const { apiKey, label } = (body ?? {}) as {
    apiKey?: unknown;
    label?: unknown;
  };
  if (typeof apiKey !== "string" || apiKey === "") {
    return NextResponse.json({ error: "缺少 apiKey" }, { status: 400 });
  }
  if (label !== undefined && typeof label !== "string") {
    return NextResponse.json({ error: "label 必须是字符串" }, { status: 400 });
  }

  const result = await addKey({
    userId: auth.userId,
    apiKey,
    label,
    checkKey: fetchBalance,
    repo: keysRepo,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ key: result.record }, { status: 201 });
}

/** DELETE /api/keys?id=xxx：删除（快照由 onDelete: Cascade 连带删除） */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const auth = await authenticate();
  if ("response" in auth) return auth.response;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "缺少 id 参数" }, { status: 400 });
  }

  const result = await deleteKey({ userId: auth.userId, id, repo: keysRepo });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return new NextResponse(null, { status: 204 });
}

/** PATCH /api/keys：body { id, isActive?, label? } 启停 / 改名 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const auth = await authenticate();
  if ("response" in auth) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const { id, isActive, label } = (body ?? {}) as {
    id?: unknown;
    isActive?: unknown;
    label?: unknown;
  };
  if (typeof id !== "string" || id === "") {
    return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  }
  if (isActive !== undefined && typeof isActive !== "boolean") {
    return NextResponse.json({ error: "isActive 必须是布尔值" }, { status: 400 });
  }
  if (label !== undefined && (typeof label !== "string" || label.trim() === "")) {
    return NextResponse.json({ error: "label 必须是非空字符串" }, { status: 400 });
  }
  if (isActive === undefined && label === undefined) {
    return NextResponse.json(
      { error: "缺少可更新的字段（isActive 或 label）" },
      { status: 400 }
    );
  }

  const result = await updateKey({
    userId: auth.userId,
    id,
    isActive: typeof isActive === "boolean" ? isActive : undefined,
    label: typeof label === "string" ? label.trim() : undefined,
    repo: keysRepo,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ key: result.record });
}
