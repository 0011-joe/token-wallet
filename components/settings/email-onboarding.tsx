"use client";

/**
 * 设置页「邮件与发信」引导组件（P0 配置引导）。
 *
 * - 挂载时拉取 GET /api/auth/email-status，展示当前 channel（resend/smtp/console）与 hint；
 * - Resend 推荐路径分步清单 + SMTP 备选简表；
 * - channel=console 时给出危险提示（验证码只能进服务端控制台）；
 * - 只读展示，不改动任何环境变量。
 */
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { EmailChannel, EmailStatus } from "@/lib/email/channel-status";

interface EmailStatusPayload {
  email: EmailStatus;
  inviteRequired: boolean;
  allowlistEnabled: boolean;
}

const CHANNEL_LABELS: Record<EmailChannel, string> = {
  resend: "Resend API",
  smtp: "SMTP",
  console: "控制台（未配置）",
};

/** Resend 推荐路径分步清单（与 docs/onboarding-email.md 保持一致）。 */
const RESEND_STEPS: { title: string; detail: string }[] = [
  {
    title: "注册 Resend 并创建 API Key",
    detail:
      "访问 resend.com 注册账号 → 打开 API Keys → 创建 Key（Production 推荐 Full access 或 Sending only）→ 复制 re_ 开头的密钥。",
  },
  {
    title: "配置 RESEND_API_KEY",
    detail:
      "将密钥写入部署环境（如 Vercel → Settings → Environment Variables）或本地 .env.local 的 RESEND_API_KEY，改完需重启/重新部署生效。",
  },
  {
    title: "添加自有域名并完成 DNS 验证",
    detail:
      "打开 Domains → Add Domain → 按提示在 DNS 服务商添加 TXT（SPF/验证）、DKIM CNAME，以及 Return-Path MX（若 Resend 要求）。状态变为 Verified 后才能用 noreply@你的域名 发信。",
  },
  {
    title: "把 SMTP_FROM 改为自有域名发件人",
    detail:
      "例如 SMTP_FROM=\"token-wallet <noreply@example.com>\"，域名须与 Resend 已验证域名一致，否则会被拒发。",
  },
  {
    title: "注意免费档限制",
    detail:
      "免费档仅能发往 Resend 账号绑定邮箱；未验证自有域名时发件人只能是 onboarding@resend.dev，且同样受限。生产请验证域名。",
  },
];

/** SMTP 备选路径简表。 */
const SMTP_ROWS: { key: string; desc: string }[] = [
  { key: "SMTP_HOST", desc: "SMTP 服务器主机名" },
  { key: "SMTP_PORT", desc: "端口：465（TLS 直连）或 587（STARTTLS）" },
  { key: "SMTP_USER / SMTP_PASS", desc: "SMTP 账号与密码/授权码" },
  { key: "SMTP_FROM", desc: "发件人，须被该 SMTP 服务商允许" },
  { key: "SMTP_SECURE", desc: "可选：显式 true/false；未设置时 465 自动 TLS" },
];

export function EmailOnboarding() {
  const [status, setStatus] = useState<EmailStatusPayload | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/auth/email-status", { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as EmailStatusPayload) : null))
      .then((data) => {
        if (cancelled) return;
        if (data) setStatus(data);
        else setLoadFailed(true);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const email = status?.email;
  const unconfigured = email?.configured === false;

  return (
    <section id="email-onboarding" aria-label="邮件与发信">
      <Card>
        <CardHeader>
          <CardTitle>邮件与发信</CardTitle>
          <CardDescription>
            登录验证码与预警邮件共用同一发信渠道。优先推荐 Resend；也可用任意 SMTP。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {/* ── 当前状态 ── */}
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">当前渠道</p>
            {loadFailed ? (
              <p className="text-sm text-muted-foreground">
                无法获取邮件状态，请刷新页面或检查 /api/auth/email-status。
              </p>
            ) : !email ? (
              <p className="text-sm text-muted-foreground">加载中…</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                      unconfigured
                        ? "bg-destructive/10 text-destructive"
                        : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    )}
                  >
                    {CHANNEL_LABELS[email.channel] ?? email.channel}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {email.configured ? "已配置" : "未配置"}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{email.hint}</p>
              </>
            )}
          </div>

          {/* ── 未配置危险提示 ── */}
          {unconfigured ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              未配置发信渠道：登录验证码只会打印在服务端控制台，其他邮箱无法完成登录。生产环境必须配置
              RESEND_API_KEY（并验证自有域名）或完整 SMTP 变量。
            </div>
          ) : null}

          {/* ── Resend 推荐路径 ── */}
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">推荐：Resend 分步清单</p>
            <ol className="flex flex-col gap-3">
              {RESEND_STEPS.map((step, i) => (
                <li key={step.title} className="flex gap-3">
                  <span
                    aria-hidden
                    className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary"
                  >
                    {i + 1}
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <p className="text-sm font-medium">{step.title}</p>
                    <p className="text-sm text-muted-foreground">{step.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="text-xs text-muted-foreground">
              外链：
              <a
                href="https://resend.com/domains"
                target="_blank"
                rel="noopener noreferrer"
                className="mx-1 text-primary underline"
              >
                resend.com/domains
              </a>
              （域名验证）
              <span aria-hidden> · </span>
              <a
                href="https://resend.com/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                className="mx-1 text-primary underline"
              >
                resend.com/api-keys
              </a>
              （API Key）
            </p>
          </div>

          {/* ── SMTP 备选 ── */}
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">备选：SMTP</p>
            <p className="text-sm text-muted-foreground">
              若已有企业邮/第三方 SMTP，配置以下变量即可（RESEND_API_KEY 未配置时才会走 SMTP）：
            </p>
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {SMTP_ROWS.map((row) => (
                <li
                  key={row.key}
                  className="flex flex-col gap-0.5 px-3 py-2 first:rounded-t-lg last:rounded-b-lg sm:flex-row sm:items-baseline sm:gap-3"
                >
                  <code className="font-mono text-xs text-foreground sm:w-48 sm:shrink-0">
                    {row.key}
                  </code>
                  <span className="text-sm text-muted-foreground">{row.desc}</span>
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
