/**
 * 邮件渠道状态探测（P0 配置引导）。
 * 只返回「是否已配置 / 渠道类型」，绝不暴露密钥或域名细节之外的敏感值。
 */

export type EmailChannel = "resend" | "smtp" | "console";

export interface EmailStatus {
  configured: boolean;
  channel: EmailChannel;
  /** 登录页展示的引导文案（中文，面向用户） */
  hint: string;
}

export function detectEmailChannel(
  env: Record<string, string | undefined> = process.env
): EmailChannel {
  if (env.RESEND_API_KEY?.trim()) return "resend";
  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) return "smtp";
  return "console";
}

export function getEmailStatus(env: Record<string, string | undefined> = process.env): EmailStatus {
  const channel = detectEmailChannel(env);
  if (channel === "resend") {
    return {
      configured: true,
      channel,
      hint: "已启用 Resend 发信。若收不到邮件，请检查 Resend Logs；未验证自有域名时，发件人通常为 onboarding@resend.dev，且免费档可能仅能发往 Resend 账号绑定邮箱。",
    };
  }
  if (channel === "smtp") {
    return {
      configured: true,
      channel: "smtp",
      hint: "已启用 SMTP 发信。若收不到邮件，请核对 SMTP_HOST/PORT/USER/PASS 与发件人。",
    };
  }
  return {
    configured: false,
    channel: "console",
    hint: "未配置邮件服务：登录验证码只会打印在服务端控制台，其他邮箱无法登录。生产环境请配置 RESEND_API_KEY（并验证自有域名）或 SMTP。",
  };
}
