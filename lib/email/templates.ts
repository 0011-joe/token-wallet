/**
 * M6（T6.3）预警邮件 HTML 模板。
 *
 * 安全红线：只接收 last4（后 4 位掩码展示），绝不在邮件内容中内嵌 API Key 明文
 * （与 auth.ts「魔法链接 URL 不进客户端/数据库」同级的 Key 最小暴露口径）。
 */
import type { AlertType } from "@/lib/alerts/evaluate";

const TYPE_TITLES: Record<AlertType, string> = {
  LOW_BALANCE: "低余额预警",
  UNAVAILABLE: "账户不可用预警",
  KEY_FAILED: "Key 异常预警",
};

/** 行动建议（不同事件给用户不同动作指引）。 */
const TYPE_ACTIONS: Record<AlertType, string> = {
  LOW_BALANCE: "请为 DeepSeek 账户充值，避免余额不足导致服务不可用。",
  UNAVAILABLE: "请登录 DeepSeek 官方平台检查账户状态（欠费、实名或风控限制等）。",
  KEY_FAILED:
    "请在 DeepSeek 官方平台确认该 Key 是否已失效；必要时在 DeepBalance 中删除或重新绑定。",
};

const SEVERITY_LABEL: Record<"warning" | "critical", string> = {
  warning: "Warning",
  critical: "Critical",
};

export interface AlertEmailData {
  type: AlertType;
  /** Key 后 4 位（数据库中 last4 字段），仅用于脱敏展示 */
  last4: string;
  /** 事件描述（与站内 message 相同文案） */
  message: string;
  severity: "warning" | "critical";
}

/**
 * 渲染预警邮件：返回 subject 与内联样式的简易 HTML
 * （不依赖邮件客户端支持的复杂 CSS，兼容性优先）。
 */
export function renderAlertEmail(data: AlertEmailData): {
  subject: string;
  html: string;
} {
  const masked = `sk-****${data.last4}`;
  const title = TYPE_TITLES[data.type];
  const action = TYPE_ACTIONS[data.type];
  const subject = `[DeepBalance] ${title}（${masked}）`;

  const html = `<!doctype html>
<html lang="zh-CN">
  <body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e5;border-radius:12px;overflow:hidden;">
      <div style="padding:16px 24px;background:${data.severity === "critical" ? "#b91c1c" : "#b45309"};color:#ffffff;">
        <h2 style="margin:0;font-size:18px;font-weight:600;">${title}</h2>
        <p style="margin:4px 0 0;font-size:12px;opacity:.9;">DeepBalance · ${SEVERITY_LABEL[data.severity]} · ${masked}</p>
      </div>
      <div style="padding:24px;">
        <p style="margin:0 0 12px;font-size:14px;color:#333333;line-height:1.6;">${data.message}</p>
        <p style="margin:0 0 16px;font-size:13px;color:#666666;line-height:1.6;">建议：${action}</p>
        <hr style="margin:0 0 12px;border:none;border-top:1px solid #eeeeee;" />
        <p style="margin:0;font-size:12px;color:#999999;">
          本邮件由 DeepBalance 自动发送，请勿直接回复。可在「设置 → 预警」中调整阈值与通知渠道。
        </p>
      </div>
    </div>
  </body>
</html>`;

  return { subject, html };
}

/**
 * 魔法链接登录邮件 HTML 模板（Auth.js Email provider 发送验证请求时使用）。
 *
 * 安全红线：url（含 token 的敏感值）只嵌进发给用户的邮件 HTML，绝不打印到
 * 日志/控制台、绝不落库；嵌入前做 HTML 转义防止属性注入。
 */

export interface MagicLinkEmailData {
  /** 登录魔法链接（next-auth 生成，含 token）——仅进入邮件正文 */
  url: string;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch]!
  );
}

/**
 * 渲染魔法链接登录邮件：返回 subject 与内联样式 HTML（与 renderAlertEmail 同风格）。
 * 链接有效期为 next-auth 默认 1 天（87600s 内有效且点击后即失效）。
 */
export function renderMagicLinkEmail(data: MagicLinkEmailData): {
  subject: string;
  html: string;
} {
  const href = escapeHtml(data.url);
  const subject = "DeepBalance 登录链接";

  const html = `<!doctype html>
<html lang="zh-CN">
  <body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e5;border-radius:12px;overflow:hidden;">
      <div style="padding:16px 24px;background:#0f766e;color:#ffffff;">
        <h2 style="margin:0;font-size:18px;font-weight:600;">登录 DeepBalance</h2>
        <p style="margin:4px 0 0;font-size:12px;opacity:.9;">DeepBalance · 魔法链接登录</p>
      </div>
      <div style="padding:24px;">
        <p style="margin:0 0 12px;font-size:14px;color:#333333;line-height:1.6;">您刚刚在 DeepBalance 发起了登录请求，点击下方按钮即可完成登录：</p>
        <div style="margin:0 0 16px;text-align:center;">
          <a href="${href}" style="display:inline-block;padding:12px 32px;background:#0f766e;color:#ffffff;border-radius:8px;font-size:15px;text-decoration:none;">登录 DeepBalance</a>
        </div>
        <p style="margin:0 0 12px;font-size:13px;color:#666666;line-height:1.6;">安全提示：此链接 24 小时内有效，点击后即失效；任何人获得此链接都可登录您的账户，请勿转发。</p>
        <hr style="margin:0 0 12px;border:none;border-top:1px solid #eeeeee;" />
        <p style="margin:0;font-size:12px;color:#999999;">如果这不是您本人操作，请忽略本邮件，您的账户仍然是安全的。本邮件由 DeepBalance 自动发送，请勿直接回复。</p>
      </div>
    </div>
  </body>
</html>`;

  return { subject, html };
}
