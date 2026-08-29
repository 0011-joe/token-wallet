/**
 * M7/T7.3 埋点（PRD §1.2 成功指标；计划 §11 Q6：埋点先建、目标内测后回填，不阻塞）。
 *
 * 事件类型约定（本任务只定义类型与上报函数，挂接点属于各里程碑）：
 * - dashboard_view：打开仪表盘 —— M4 dashboard 页挂载时上报；
 * - key_bound：成功绑定 Key —— M4 前端在 POST /api/keys 返回 201 后上报；
 * - ttv：注册完成 → 首次成功渲染余额卡 —— M4 前端在 dashboard 首次拿到余额数据时上报，
 *       调用方把注册完成时间戳放 props.startAtMs（epoch ms），与本模块记录的服务端
 *       到达时间 ts 求差即 TTV（口径「来源前后端时间戳」）；
 * - alert_sent：预警发送 —— M6 预警发送处挂接后上报（本任务不改 app/api/cron/snapshot/route.ts）。
 *
 * 上报 POST /api/events（app/api/events/route.ts）：浏览器端 fetch 相对路径；
 * 服务端（如 cron/M6）用 APP_URL（缺省 http://localhost:3000）拼绝对地址，部署时必须配置。
 * 失败静默：所有异常吞掉（catch），绝不影响主流程；keepalive 保证页面卸载前尽量送达。
 *
 * 安全：props 只保留扁平原始类型（对象/数组/函数一律丢弃，保证日志一行可序列化），
 * 字符串值经 redactSecretStrings 脱敏（sk- 前缀密钥替换为 sk-***）——事件日志不可能出现
 * API Key；本模块不引入任何 node 专属 API，客户端/服务端均可使用。
 */
export const EVENT_NAMES = [
  "dashboard_view",
  "key_bound",
  "ttv",
  "alert_sent",
] as const;
export type AnalyticsEventName = (typeof EVENT_NAMES)[number];

/** 扁平、可序列化的上报属性；字符串值自动做密钥脱敏 */
export type AnalyticsProps = Record<
  string,
  string | number | boolean | null | undefined
>;

/** API Key / 任何以 sk- 开头的密钥的脱敏正则（与 keys/service 的 KEY_FORMAT_RE 同形） */
export const SECRET_KEY_RE = /sk-[A-Za-z0-9_-]{8,}/g;

/** 把文本中形如 sk-xxx 的密钥替换为 sk-***（防日志/文件泄漏的最后一道兜底）。 */
export function redactSecretStrings(value: string): string {
  return value.replace(SECRET_KEY_RE, "sk-***");
}

/** 只保留扁平原始类型属性；字符串脱敏；其余（对象/数组/函数/符号）丢弃。 */
export function sanitizeProps(props: Record<string, unknown>): AnalyticsProps {
  const out: AnalyticsProps = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "string") {
      out[key] = redactSecretStrings(value);
    } else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null ||
      value === undefined
    ) {
      out[key] = value;
    }
  }
  return out;
}

export async function trackEvent(
  name: AnalyticsEventName,
  props: AnalyticsProps = {}
): Promise<void> {
  const payload = {
    name,
    props: sanitizeProps(props),
    ts: new Date().toISOString(), // 服务端到达时间：与调用方传入的 startAtMs 差值即 TTV
  };
  // 服务端没有浏览器 location，用环境变量拼绝对地址
  const endpoint =
    typeof window !== "undefined"
      ? "/api/events"
      : `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "")}/api/events`;
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch {
    // 埋点静默失败：不影响主流程（也不 console，避免噪音）
  }
}
