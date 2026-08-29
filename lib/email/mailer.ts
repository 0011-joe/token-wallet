/**
 * 统一邮件发送器：M6 预警邮件（send.ts）与 Auth.js 魔法链接邮件（verification-request.ts）
 * 共用同一渠道配置与优先级：
 *   1. RESEND_API_KEY 已配置 → resend SDK（`new Resend(key).emails.send`）；
 *   2. 否则 SMTP_HOST/SMTP_USER/SMTP_PASS 已配置 → nodemailer（动态导入，仅 SMTP 路径加载）；
 *   3. 都未配置 → 返回 channel="unconfigured" 错误，由调用方决定开发态行为
 *      （sendAlertEmail 降级控制台预览；auth.ts 的"未配置"分支保持打印链接）。
 *
 * SMTP 安全参数规则：SMTP_SECURE 显式设置时以其为准；未设置时按端口自动判定——
 * 端口 465 → secure=true（立即 TLS 直连），其余（常见 587）→ secure=false（STARTTLS 升级）。
 *
 * 安全红线：本模块只负责把调用方拼好的 subject/html 发出去，不打印正文；
 * 绝不输出 API Key 明文到日志。
 */
import { Resend } from "resend";

export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
  /** 纯文本备选（可选，部分邮件客户端/合规场景使用） */
  text?: string;
}

export type SendMailResult =
  | { ok: true }
  | { ok: false; error: string; channel: "resend" | "smtp" | "unconfigured" };

function emailFrom(): string {
  return process.env.SMTP_FROM ?? "DeepBalance <noreply@example.com>";
}

function smtpPort(): number | undefined {
  const raw = process.env.SMTP_PORT;
  if (!raw) return undefined;
  const port = Number(raw);
  return Number.isFinite(port) ? port : undefined;
}

function smtpSecure(): boolean {
  const explicit = process.env.SMTP_SECURE;
  if (explicit === "true" || explicit === "1") return true;
  if (explicit === "false" || explicit === "0") return false;
  // 未显式指定：465 默认安全（TLS 直连），其余端口（587 等）默认非安全（STARTTLS 协商）
  return smtpPort() === 465;
}

/** 用 resend SDK 发送。 */
async function sendViaResend(input: SendMailInput): Promise<SendMailResult> {
  try {
    const resend = new Resend(process.env.RESEND_API_KEY!);
    const payload = {
      from: emailFrom(),
      to: input.to,
      subject: input.subject,
      html: input.html,
      ...(input.text ? { text: input.text } : {}),
    };
    await resend.emails.send(payload);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `resend 发送失败: ${err instanceof Error ? err.message : String(err)}`,
      channel: "resend",
    };
  }
}

/** 用 nodemailer 走 SMTP（动态导入：仅 SMTP 路径触发加载）。 */
async function sendViaSmtp(input: SendMailInput): Promise<SendMailResult> {
  try {
    const { default: nodemailer } = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: smtpPort(),
      secure: smtpSecure(),
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    await transporter.sendMail({
      from: emailFrom(),
      to: input.to,
      subject: input.subject,
      html: input.html,
      ...(input.text ? { text: input.text } : {}),
    });
    return { ok: true };
  } catch (err) {
    // nodemailer 发送失败（含网络/鉴权）：不向外抛原始异常，由调用方决定降级或重试
    return {
      ok: false,
      error: `smtp 发送失败: ${err instanceof Error ? err.message : String(err)}`,
      channel: "smtp",
    };
  }
}

/**
 * 统一发送入口：RESEND_API_KEY 优先，其次 SMTP；都未配置时返回
 * channel="unconfigured" 的失败结果（不抛异常），由调用方走开发态预览。
 */
export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  if (process.env.RESEND_API_KEY?.trim()) {
    return sendViaResend(input);
  }
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return sendViaSmtp(input);
  }
  return {
    ok: false,
    error: "未配置邮件渠道（RESEND_API_KEY 或 SMTP_HOST/USER/PASS）",
    channel: "unconfigured",
  };
}
