/**
 * M7/T7.3 埋点上报端点（POST /api/events）。
 *
 * - 无鉴权：事件 payload 本身不含敏感数据（名称白名单校验 + props 扁平化 + sk- 脱敏，
 *   服务端再脱敏一层作双保险）；若上线后有刷量/伪造顾虑，可在网关做同源校验或一次性令牌。
 * - 落点：① console.log 输出单行 JSON（服务端日志，便于对接日志/第三方埋点）；
 *         ② 追加写入 scripts/analytics-events.ndjson（本地先攒量；scripts/ 已被
 *            tsconfig exclude，不参与 tsc 收集；该文件已加入 .gitignore）。
 *   生产环境应切换为 Postgres 事件表或第三方埋点服务（Q6 待定，本地文件仅作过渡）。
 * - 失败不打扰：即使写文件失败也返回 204（埋点不能影响上报方主流程），只 console.warn；
 *   事件日志只含脱敏后的扁平属性，绝不含 API Key。
 */
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

import { EVENT_NAMES, sanitizeProps } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_CHARS = 4096;
const EVENTS_FILE = path.join(process.cwd(), "scripts", "analytics-events.ndjson");

export async function POST(req: Request): Promise<NextResponse> {
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) {
    return NextResponse.json({ error: "payload 过大" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const { name, props } = (body ?? {}) as { name?: unknown; props?: unknown };
  if (
    typeof name !== "string" ||
    !(EVENT_NAMES as readonly string[]).includes(name)
  ) {
    return NextResponse.json(
      { error: `未知事件类型（可选：${EVENT_NAMES.join(" | ")}）` },
      { status: 400 }
    );
  }
  const safeProps = sanitizeProps(
    typeof props === "object" && props !== null
      ? (props as Record<string, unknown>)
      : {}
  );

  const line = JSON.stringify({
    name,
    props: safeProps,
    ts: new Date().toISOString(),
  });
  console.log(`[analytics] ${line}`);

  try {
    await appendFile(EVENTS_FILE, `${line}\n`, "utf8");
  } catch (err) {
    console.warn(
      `[analytics] 事件写文件失败（服务端日志仍保留）：${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  return new NextResponse(null, { status: 204 });
}
