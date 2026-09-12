/**
 * 登录验证码邮件（OTP）。正文只含 6 位码与有效期，无登录链接。
 * 安全红线：不打印码到日志（dev 回显走 API 响应体，由调用方决定）。
 */
import { sendMail } from "./mailer";

export interface OtpMailInput {
  to: string;
  code: string;
  /** 分钟 */
  ttlMinutes?: number;
}

export function renderOtpEmail(code: string, ttlMinutes = 10): { subject: string; html: string } {
  const subject = "[token-wallet] 登录验证码";
  const html = `<!doctype html>
<html lang="zh-CN">
  <body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e5;border-radius:12px;padding:24px;">
      <h2 style="margin:0 0 12px;font-size:18px;color:#111;">登录验证码</h2>
      <p style="margin:0 0 8px;font-size:14px;color:#333;">你的验证码是：</p>
      <p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:0.35em;color:#111;">${code}</p>
      <p style="margin:0 0 8px;font-size:13px;color:#666;">${ttlMinutes} 分钟内有效，请勿转发给他人。</p>
      <p style="margin:0;font-size:12px;color:#999;">若非本人操作，请忽略本邮件。本邮件由 token-wallet 自动发送。</p>
    </div>
  </body>
</html>`;
  return { subject, html };
}

export async function sendOtpEmail(input: OtpMailInput) {
  const { subject, html } = renderOtpEmail(input.code, input.ttlMinutes ?? 10);
  return sendMail({ to: input.to, subject, html });
}
