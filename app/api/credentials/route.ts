/**
 * /api/credentials —— 凭证增删查改（M1 / FR-1）。
 *
 * GET：当前用户全部凭证（仅脱敏字段）。
 * POST：body { provider, kind, region?, label?, secret: {key} | {ak, sk} }
 *   - provider 必须是 registry 已注册平台；kind 必须与 adapter.credentialKind 一致；
 *   - 提交即 testCredential()（AC1.2：失败返回可操作原因，不落库）；
 *   - 成功后加密落库（keyVersion=1）+ 立即写首份余额快照（AC1.3：不等整点）。
 * 安全红线：明文凭证只用于测试调用与加密，绝不写日志、绝不回传（AC1.4）。
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { addCredential, listCredentials } from "@/lib/credentials/service";
import { credentialsRepo } from "@/lib/credentials/repo";
import { getProviderOrThrow, isProviderRegistered } from "@/lib/providers/registry";
import type { ProviderId } from "@/lib/providers/types";
import { writeSnapshots } from "@/lib/snapshot/runner";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const credentials = await listCredentials(user.id, credentialsRepo);
  return NextResponse.json({ credentials });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
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
  const { provider, kind, region, label, secret } = (body ?? {}) as {
    provider?: unknown;
    kind?: unknown;
    region?: unknown;
    label?: unknown;
    secret?: unknown;
  };
  if (typeof provider !== "string" || !["deepseek", "kimi", "volcengine"].includes(provider)) {
    return NextResponse.json(
      { error: "provider 仅支持 deepseek | kimi | volcengine" },
      { status: 400 }
    );
  }
  if (!isProviderRegistered(provider as ProviderId)) {
    return NextResponse.json({ error: "该平台暂未支持" }, { status: 400 });
  }
  if (typeof kind !== "string" || !["bearer", "aksk"].includes(kind)) {
    return NextResponse.json({ error: "kind 仅支持 bearer | aksk" }, { status: 400 });
  }
  if (region !== undefined && region !== null && typeof region !== "string") {
    return NextResponse.json({ error: "region 必须是字符串" }, { status: 400 });
  }
  if (label !== undefined && typeof label !== "string") {
    return NextResponse.json({ error: "label 必须是字符串" }, { status: 400 });
  }
  if (secret === null || typeof secret !== "object" || Array.isArray(secret)) {
    return NextResponse.json({ error: "缺少 secret 对象" }, { status: 400 });
  }

  const adapter = getProviderOrThrow(provider as ProviderId);
  if (kind !== adapter.credentialKind) {
    return NextResponse.json(
      { error: `${provider} 平台使用 ${adapter.credentialKind === "bearer" ? "模型 Key（bearer）" : "AK/SK（aksk）"} 凭证` },
      { status: 400 }
    );
  }

  const secretPayload = secret as { key?: unknown; ak?: unknown; sk?: unknown };
  const normalizedSecret = {
    ...(typeof secretPayload.key === "string" ? { key: secretPayload.key } : {}),
    ...(typeof secretPayload.ak === "string" ? { ak: secretPayload.ak } : {}),
    ...(typeof secretPayload.sk === "string" ? { sk: secretPayload.sk } : {}),
  };

  const result = await addCredential({
    userId: user.id,
    provider: provider as ProviderId,
    kind: kind as "bearer" | "aksk",
    region: typeof region === "string" ? region : null,
    label: typeof label === "string" ? label : undefined,
    secret: normalizedSecret,
    testFn: (s, o) => adapter.testCredential(s, o),
    repo: credentialsRepo,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  // AC1.3：提交即写首份余额快照，用户切到仪表盘即可看到
  try {
    await writeSnapshots(result.record.id, adapter.id, result.test.balance);
  } catch (err) {
    console.warn(
      `[api/credentials] 首份快照写入失败（凭证已保存）：${
        err instanceof Error ? err.name : "unknown"
      }`
    );
  }

  return NextResponse.json(
    {
      credential: result.record,
      firstBalance: result.test.balance,
    },
    { status: 201 }
  );
}
