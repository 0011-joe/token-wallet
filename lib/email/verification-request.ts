/**
 * Auth.js Email provider 的魔法链接真实发送（auth.ts 的 sendVerificationRequest
 * "已配置"分支调用；"未配置"分支的开发态打印逻辑保持在 auth.ts 内不变）。
 *
 * 与 M6 预警邮件共用 lib/email/mailer.ts 的 sendMail：
 * RESEND_API_KEY 优先，其次 SMTP；两者都未配置时返回 ok:false（auth.ts 已判定
 * "已配置"才会调用本函数，此处仅兜底）。
 *
 * 安全红线：url 只嵌入邮件 HTML 发送给用户；本模块的错误信息绝不包含 url。
 */
import { sendMail } from "./mailer";
import { renderMagicLinkEmail } from "./templates";

export type SendVerificationRequestEmailResult =
  | { ok: true }
  | { ok: false; error: string };

export async function sendVerificationRequestEmail(
  identifier: string,
  url: string
): Promise<SendVerificationRequestEmailResult> {
  const { subject, html } = renderMagicLinkEmail({ url });
  const result = await sendMail({ to: identifier, subject, html });
  if (result.ok) return result;
  if (result.channel === "unconfigured") {
    return {
      ok: false,
      error: "未配置邮件渠道（RESEND_API_KEY 或 SMTP_HOST/USER/PASS）",
    };
  }
  return { ok: false, error: result.error };
}
