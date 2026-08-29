"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSession, signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  // 已登录（点完魔法链接回到 /login）→ 直接进入仪表盘
  useEffect(() => {
    void getSession().then((sess) => {
      if (sess) router.replace("/dashboard");
    });
  }, [router]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await signIn("email", { email, redirect: false });
      if (res?.error) {
        setError("登录失败，请重试");
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
      <h1 className="text-2xl font-semibold tracking-tight">登录 DeepBalance</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        输入邮箱，我们会发送一次性魔法链接。
      </p>
      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">邮箱</Label>
          <Input
            id="email"
            type="email"
            name="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {sent ? (
          <p className="text-sm text-muted-foreground">
            已发送登录链接，请查收邮件（开发态请查看服务端控制台）。
          </p>
        ) : null}
        <Button type="submit" disabled={loading}>
          {loading ? "发送中…" : "发送登录链接"}
        </Button>
      </form>
    </div>
  );
}
