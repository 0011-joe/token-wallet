"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSession, signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ApiError,
  fetchEmailStatus,
  requestCode,
  verifyInvite,
  type EmailStatusResponse,
} from "@/lib/api-client";

/** 页面步骤：idle 收集邮箱/邀请码；codeSent 输入 6 位验证码并登录 */
type Step = "idle" | "codeSent";

const CODE_LENGTH = 6;
const RESEND_COOLDOWN_SEC = 60;

function readApiMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  return fallback;
}

export default function LoginPage() {
  const [step, setStep] = useState<Step>("idle");
  const [email, setEmail] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [inviteOk, setInviteOk] = useState(false);
  const [checkingInvite, setCheckingInvite] = useState(false);
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [status, setStatus] = useState<EmailStatusResponse | null>(null);
  const router = useRouter();

  const busy = checkingInvite || sending || verifying;

  // 已登录 → 直接进入仪表盘
  useEffect(() => {
    void getSession().then((sess) => {
      if (sess) router.replace("/dashboard");
    });
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    void fetchEmailStatus()
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 重发倒计时
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  function resetEmailDependentState() {
    setInviteOk(false);
    setCode("");
    setDevCode(null);
  }

  async function handleInviteCheck() {
    setError(null);
    setSuccess(null);
    setCheckingInvite(true);
    try {
      await verifyInvite({ email, inviteCode });
      setInviteOk(true);
    } catch (err) {
      setInviteOk(false);
      setError(readApiMessage(err, "邀请码验证失败"));
    } finally {
      setCheckingInvite(false);
    }
  }

  async function handleSendCode() {
    setError(null);
    setSuccess(null);
    if (status?.inviteRequired && !inviteOk) {
      setError("请先验证邀请码");
      return;
    }
    setSending(true);
    try {
      const data = await requestCode({ email });
      setDevCode(data.devCode ?? null);
      setStep("codeSent");
      setCode("");
      setCountdown(RESEND_COOLDOWN_SEC);
      setSuccess(`验证码已发送至 ${email}`);
    } catch (err) {
      setError(readApiMessage(err, "验证码发送失败，请稍后重试"));
    } finally {
      setSending(false);
    }
  }

  async function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (code.length !== CODE_LENGTH) {
      setError(`请输入 ${CODE_LENGTH} 位验证码`);
      return;
    }
    setVerifying(true);
    try {
      const res = await signIn("credentials", {
        email,
        code,
        redirect: false,
      });
      if (res?.error) {
        setError("验证码错误或已过期，请重试");
      } else {
        router.replace("/dashboard");
      }
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setVerifying(false);
    }
  }

  function handleCodeChange(next: string) {
    setCode(next.replace(/\D/g, "").slice(0, CODE_LENGTH));
  }

  function handleCodePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    const digits = text.replace(/\D/g, "").slice(0, CODE_LENGTH);
    if (digits.length > 0) {
      e.preventDefault();
      setCode(digits);
    }
  }

  function backToIdle() {
    setStep("idle");
    setCode("");
    setDevCode(null);
    setError(null);
    setSuccess(null);
    setCountdown(0);
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-2xl font-semibold tracking-tight">
          登录 token-wallet
        </CardTitle>
        <CardDescription>
          {step === "idle"
            ? "输入邮箱，我们将发送 6 位验证码。"
            : "输入邮箱收到的 6 位验证码完成登录。"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {status && !status.email.configured ? (
          <p
            role="status"
            className="mb-4 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-100"
          >
            {status.email.hint}
          </p>
        ) : null}
        {status?.allowlistEnabled ? (
          <p className="mb-4 text-xs text-muted-foreground">
            本实例已开启邮箱白名单，仅允许列表内邮箱登录。
          </p>
        ) : null}

        {step === "idle" ? (
          <form
            aria-busy={busy}
            onSubmit={(e) => {
              e.preventDefault();
              void handleSendCode();
            }}
            className="flex flex-col gap-4"
          >
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
                  resetEmailDependentState();
                }}
                required
                autoComplete="email"
                disabled={busy}
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
                    disabled={busy}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || !email || !inviteCode}
                    aria-busy={checkingInvite}
                    onClick={() => void handleInviteCheck()}
                  >
                    {checkingInvite ? "验证中…" : inviteOk ? "已通过" : "验证"}
                  </Button>
                </div>
                {inviteOk ? (
                  <p className="text-xs text-muted-foreground">
                    邀请码已通过，有效期约 10 分钟，请继续发送验证码。
                  </p>
                ) : null}
              </div>
            ) : null}

            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <Button
              type="submit"
              disabled={busy || (status?.inviteRequired && !inviteOk)}
              aria-busy={sending}
            >
              {sending ? "发送中…" : "发送验证码"}
            </Button>
          </form>
        ) : (
          <form
            aria-busy={busy}
            onSubmit={(e) => void handleLogin(e)}
            className="flex flex-col gap-4"
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">邮箱</Label>
              <Input
                id="email"
                type="email"
                name="email"
                value={email}
                readOnly
                autoComplete="email"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="code">验证码</Label>
              <Input
                id="code"
                name="code"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={CODE_LENGTH}
                placeholder="6 位数字"
                value={code}
                onChange={(e) => handleCodeChange(e.target.value)}
                onPaste={handleCodePaste}
                autoFocus
                required
                autoComplete="one-time-code"
                className="text-center tracking-[0.4em]"
                disabled={verifying}
              />
            </div>

            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {success ? (
              <p role="status" className="text-sm text-muted-foreground">
                {success}
              </p>
            ) : null}
            {devCode ? (
              <p className="text-sm text-muted-foreground">
                开发态验证码：{devCode}
              </p>
            ) : null}

            <Button type="submit" disabled={verifying || code.length !== CODE_LENGTH} aria-busy={verifying}>
              {verifying ? "登录中…" : "登录"}
            </Button>

            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={backToIdle}
                disabled={busy}
              >
                更换邮箱
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || countdown > 0}
                aria-busy={sending}
                onClick={() => void handleSendCode()}
              >
                {sending
                  ? "发送中…"
                  : countdown > 0
                    ? `重新发送（${countdown}s）`
                    : "重新发送"}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
