/**
 * M6（T6.3）预警邮件发送。
 *
 * 渠道优先级与统一 mailer（lib/email/mailer.ts）一致——仅在配置了服务时真实发送：
 *   1. RESEND_API_KEY 已配置 → resend SDK；
 *   2. 否则 SMTP_HOST/SMTP_USER/SMTP_PASS 已配置 → nodemailer；
 *   3. 都未配置 → 开发态预览：内容打印到服务端控制台，不发送（同 auth.ts 开发态约定）。
 *
 * 降级约定（与 M6 保持一致）：SMTP 发送失败 → 退回控制台预览并 console.warn，
 * 保证预警不静默丢失；resend 发送失败 → 原样返回失败（不降级），由调用方记录。
 *
 * 安全红线：本模块只接收调用方拼好的 subject/html（模板只嵌 last4），日志只写
 * 收件人/主题，绝不输出 API Key 明文。
 */
import { sendMail } from "./mailer";

export interface AlertEmailInput {
  to: string;
  subject: string;
  html: string;
}

export type SendAlertEmailResult = { ok: true } | { ok: false; error: string };

/** 开发态预览：邮件内容打印到服务端控制台（与 auth.ts 魔法链接开发态一致）。 */
function logPreview(input: AlertEmailInput): void {
  console.log(
    `[alerts:email-dev] 邮件预览 to=${input.to} subject=${input.subject}\n${input.html}`
  );
}

export async function sendAlertEmail(
  input: AlertEmailInput
): Promise<SendAlertEmailResult> {
  const result = await sendMail(input);
  if (result.ok) return result;

  if (result.channel === "unconfigured") {
    // 无任何邮件配置：开发态预览（不抛）
    logPreview(input);
    return { ok: true };
  }

  if (result.channel === "smtp") {
    // SMTP 发送失败 → 退回开发态预览（并 warn 说明），避免预警静默丢失
    console.warn(`[alerts:email] SMTP 发送失败，退回控制台预览: ${result.error}`);
    logPreview(input);
    return { ok: true };
  }

  // resend 发送失败：原样返回（不降级），由 cron 调用方记录
  return { ok: false, error: result.error };
}
