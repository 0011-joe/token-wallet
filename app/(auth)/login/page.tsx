"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSession, signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface EmailStatusPayload {
  email: {
    configured: boolean;
    channel: "resend" | "smtp" | "console";
    hint: string;
  };
  inviteRequired: boolean;
  allowlistEnabled: boolean;
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [inviteOk, setInviteOk] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<EmailStatusPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkingInvite, setCheckingInvite] = useState(false);
  const router = useRouter();

  // 已登录（点完魔法链接回到 /login）→ 直接进入仪表盘
  useEffect(() => {
    void getSession().then((sess) => {
      if (sess) router.replace("/dashboard");
    });
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/auth/email-status")
      .then(async (r) => (r.ok ? ((await r.json()) as EmailStatusPayload) : null))
      .then((data) => {
        if (!cancelled && data) setStatus(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleInviteCheck() {
    setError(null);
    setCheckingInvite(true);
    try {
      const res = await fetch("/api/auth/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, inviteCode }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (res.ok && data?.ok) {
        setInviteOk(true);
      } else {
        setInviteOk(false);
        setError(data?.error ?? "邀请码验证失败");
      }
    } catch {
      setInviteOk(false);
      setError("网络错误，请稍后重试");
    } finally {
      setCheckingInvite(false);
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (status?.inviteRequired && !inviteOk) {
      setError("请先验证邀请码");
      return;
    }
    setLoading(true);
    try {
      const res = await signIn("email", { email, redirect: false });
      if (res?.error) {
        setError("登录失败，请重试（若开启了白名单/邀请码，请确认邮箱与邀请码）");
      } else {
        setSent(true);
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <h1 className="text-2xl font-semibold tracking-tight">登录 token-wallet</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        输入邮箱，我们会发送一次性魔法链接。
      </p>

      {status && !status.email.configured ? (
        <p
          role="status"
          className="mt-4 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-100"
        >
          {status.email.hint}
        </p>
      ) : null}
      {status?.allowlistEnabled ? (
        <p className="mt-2 text-xs text-muted-foreground">
          本实例已开启邮箱白名单，仅允许列表内邮箱登录。
        </p>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">邮箱</Label>
          <Input
            id="email"
            type="email"
            name="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setInviteOk(false);
            }}
            required
            autoComplete="email"
          />
        </div>

        {status?.inviteRequired ? (
          <div className="flex flex-col gap-2 rounded-lg border p-3">
            <Label htmlFor="inviteCode">邀请码</Label>
            <div className="flex gap-2">
              <Input
                id="inviteCode"
                name="inviteCode"
                placeholder="向管理员索取"
                value={inviteCode}
                onChange={(e) => {
                  setInviteCode(e.target.value);
                  setInviteOk(false);
                }}
                required
                autoComplete="one-time-code"
              />
              <Button
                type="button"
                variant="outline"
                disabled={checkingInvite || !email || !inviteCode}
                onClick={() => void handleInviteCheck()}
              >
                {checkingInvite ? "验证中…" : inviteOk ? "已通过" : "验证"}
              </Button>
            </div>
            {inviteOk ? (
              <p className="text-xs text-muted-foreground">邀请码已通过，有效期约 10 分钟，请继续发送登录链接。</p>
            ) : null}
          </div>
        ) : null}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {sent ? (
          <p className="text-sm text-muted-foreground">
            已发送登录链接，请查收邮件
            {status?.email.channel === "console" ? "（开发态请查看服务端控制台）" : ""}。
          </p>
        ) : null}
        <Button type="submit" disabled={loading || (status?.inviteRequired && !inviteOk)}>
          {loading ? "发送中…" : "发送登录链接"}
        </Button>
      </form>
    </div>
  );
}
