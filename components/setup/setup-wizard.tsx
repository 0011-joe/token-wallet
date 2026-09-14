/**
 * 3 步 Deploy 向导（G9）：环境变量核对 → 发信 → 首份余额。
 * 只读探测 /api/auth/email-status 与 /api/health（health 需密钥时提示）。
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CircleCheck, CircleDashed } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface EmailStatus {
  email: { configured: boolean; channel: string; hint: string };
  inviteRequired: boolean;
  allowlistEnabled: boolean;
}

const ENV_CHECKLIST = [
  { key: "DATABASE_URL", desc: "Neon pooled 连接串（含 -pooler 与 sslmode=require）" },
  { key: "AUTH_SECRET", desc: "会话签名（openssl rand -base64 32）" },
  { key: "ENCRYPTION_KEY", desc: "32 字节 hex，凭证加密主密钥，丢失不可恢复" },
  { key: "NEXTAUTH_URL", desc: "https://你的域名" },
  { key: "CRON_SECRET", desc: "快照与 /api/health 鉴权" },
  { key: "RESEND_API_KEY 或 SMTP_*", desc: "生产必配其一，否则无法收验证码" },
  { key: "ALLOWED_EMAILS", desc: "公网建议：邮箱白名单" },
  { key: "INVITE_CODES", desc: "公网建议：邀请码" },
];

export function SetupWizard() {
  const [email, setEmail] = useState<EmailStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/auth/email-status")
      .then((r) => (r.ok ? (r.json() as Promise<EmailStatus>) : null))
      .then((d) => {
        if (!cancelled && d) setEmail(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const mailReady = email?.email.configured === true;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Deploy 向导（3 步）</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          目标：fork → 配置 → 看到第一张余额卡，约 5 分钟、5 个动作。
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CircleDashed aria-hidden className="size-5" />
            第 1 步 · 环境变量
          </CardTitle>
          <CardDescription>Vercel → Settings → Environment Variables，逐项核对</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2 text-sm">
            {ENV_CHECKLIST.map((e) => (
              <li key={e.key} className="flex flex-col gap-0.5">
                <code className="font-mono text-xs">{e.key}</code>
                <span className="text-muted-foreground">{e.desc}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {mailReady ? (
              <CircleCheck aria-hidden className="size-5 text-emerald-600" />
            ) : (
              <CircleDashed aria-hidden className="size-5" />
            )}
            第 2 步 · 邮件发信
          </CardTitle>
          <CardDescription>
            验证码登录依赖邮件；未配置时生产会拒绝签发（503）
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {email ? (
            <p>
              当前渠道：
              <span className="mx-1 font-medium">{email.email.channel}</span>
              {mailReady ? "（已配置）" : "（未配置）"}
            </p>
          ) : (
            <p className="text-muted-foreground">检测中…</p>
          )}
          <p className="text-muted-foreground">{email?.email.hint}</p>
          <Link href="/settings#email-onboarding" className={cn(buttonVariants({ variant: "outline" }), "w-fit")}>
            打开邮件引导
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CircleDashed aria-hidden className="size-5" />
            第 3 步 · 首份余额
          </CardTitle>
          <CardDescription>添加 DeepSeek / Kimi / 豆包 任一凭证</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            DeepSeek：platform → API Keys；Kimi：platform.moonshot.cn；火山：费用中心只读 IAM AK/SK。
          </p>
          <Link href="/credentials" className={cn(buttonVariants(), "w-fit")}>
            去添加凭证
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
