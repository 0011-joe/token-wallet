"use client";

/**
 * 设置页（M6 / T6.3）——预警设置 + 最近预警列表 + 账户设置。
 *
 * 布局约定：本页面只有内容区（顶栏/导航由 M4 的 app/(app)/layout.tsx 提供）；
 * 预警设置区带 id="alerts" 锚点，供顶栏预警铃铛跳转（/settings#alerts）。
 *
 * 账户区：注销调用 M7 的 DELETE /api/account?confirm=true（二次确认输入 DELETE）；
 * 该接口由 M7 并行实现，未就绪时本页只做 fetch 调用（404/错误会展示提示，不影响其他功能）。
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
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
import { cn } from "@/lib/utils";

interface AlertSettings {
  lowBalanceThreshold: number;
  failThresholdN: number;
  emailEnabled: boolean;
  inappEnabled: boolean;
}

interface AlertEventItem {
  id: string;
  type: string;
  apiKeyId: string;
  message: string;
  severity: "warning" | "critical";
  createdAt: string;
}

const DEFAULT_SETTINGS: AlertSettings = {
  lowBalanceThreshold: 20,
  failThresholdN: 3,
  emailEnabled: true,
  inappEnabled: true,
};

const TYPE_LABELS: Record<string, string> = {
  LOW_BALANCE: "低余额",
  UNAVAILABLE: "不可用",
  KEY_FAILED: "Key 异常",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0") +
    " " +
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0")
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<AlertSettings>(DEFAULT_SETTINGS);
  const [thresholdInput, setThresholdInput] = useState("20");
  const [failNInput, setFailNInput] = useState("3");
  const [events, setEvents] = useState<AlertEventItem[]>([]);
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [accountError, setAccountError] = useState<string | null>(null);

  // 挂载时加载：预警设置/事件 + 当前邮箱。
  // 注意：fetch 链中所有 setState 均位于 .then/.catch 回调内（React Compiler 规则要求，
  // 不允许在 effect 体内同步调用 setState 函数，会造成级联渲染）。
  useEffect(() => {
    let cancelled = false;

    fetch("/api/alerts", { cache: "no-store" })
      .then((res) => {
        if (cancelled) return null;
        if (res.status === 401) {
          setAuthError(true);
          return null;
        }
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json() as Promise<{
          settings: AlertSettings;
          events: AlertEventItem[];
        }>;
      })
      .then((data) => {
        if (!data || cancelled) return;
        setSettings(data.settings);
        setThresholdInput(String(data.settings.lowBalanceThreshold));
        setFailNInput(String(data.settings.failThresholdN));
        setEvents(data.events);
      })
      .catch(() => {
        if (!cancelled) {
          setSaveMessage({ kind: "error", text: "预警数据加载失败，请稍后重试" });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    // 当前邮箱：直接读 next-auth 的 session 端点（不依赖 SessionProvider）
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((s: { user?: { email?: string } }) => {
        if (!cancelled) setEmail(s.user?.email ?? null);
      })
      .catch(() => {
        if (!cancelled) setEmail(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaveMessage(null);

    const threshold = Number(thresholdInput);
    const failN = Number(failNInput);
    if (thresholdInput.trim() === "" || !Number.isFinite(threshold) || threshold < 0) {
      setSaveMessage({
        kind: "error",
        text: "低余额阈值必须是不小于 0 的数字",
      });
      return;
    }
    if (failNInput.trim() === "" || !Number.isInteger(failN) || failN < 1) {
      setSaveMessage({ kind: "error", text: "连续失败次数 N 必须是正整数" });
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/alerts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lowBalanceThreshold: threshold,
          failThresholdN: failN,
          emailEnabled: settings.emailEnabled,
          inappEnabled: settings.inappEnabled,
        }),
      });
      const body = (await res.json()) as {
        settings?: AlertSettings;
        error?: string;
      };
      if (!res.ok) {
        setSaveMessage({ kind: "error", text: body.error ?? "保存失败" });
        return;
      }
      if (body.settings) setSettings(body.settings);
      setSaveMessage({ kind: "ok", text: "已保存" });
    } catch {
      setSaveMessage({ kind: "error", text: "网络错误，保存失败" });
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteAccount() {
    setAccountError(null);
    try {
      const res = await fetch("/api/account?confirm=true", { method: "DELETE" });
      if (res.ok) {
        router.push("/");
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      setAccountError(body?.error ?? "注销失败（HTTP " + res.status + "）");
    } catch {
      setAccountError("网络错误，请稍后重试");
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">设置</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          管理预警阈值、通知渠道与账户。
        </p>
      </div>

      {authError ? (
        <Card>
          <CardContent className="flex flex-col gap-3 py-6 text-sm text-muted-foreground">
            <span>请先登录后再访问设置。</span>
            <Link href="/login" className="text-primary underline">
              去登录
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ── 预警设置（锚点 #alerts） ── */}
          <section id="alerts" aria-label="预警设置">
            <Card>
              <CardHeader>
                <CardTitle>预警设置</CardTitle>
                <CardDescription>
                  低余额跌破阈值、账户不可用、Key 连续失败时通过邮件与站内消息提醒。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSave} className="flex flex-col gap-5">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="low-balance-threshold">低余额阈值</Label>
                      <Input
                        id="low-balance-threshold"
                        type="number"
                        min={0}
                        step="0.01"
                        value={thresholdInput}
                        onChange={(e) => setThresholdInput(e.target.value)}
                        aria-describedby="threshold-hint"
                      />
                      <p id="threshold-hint" className="text-xs text-muted-foreground">
                        余额低于该值即预警（阈值不可为负）；多币种按主币种（CNY 优先）评估。
                      </p>
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="fail-threshold-n">连续失败次数 N</Label>
                      <Input
                        id="fail-threshold-n"
                        type="number"
                        min={1}
                        step={1}
                        value={failNInput}
                        onChange={(e) => setFailNInput(e.target.value)}
                        aria-describedby="failn-hint"
                      />
                      <p id="failn-hint" className="text-xs text-muted-foreground">
                        Key 连续失败达到 N 次提醒检查（正整数）。
                      </p>
                    </div>
                  </div>

                  <fieldset className="flex flex-col gap-3">
                    <legend className="text-sm font-medium">通知渠道</legend>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={settings.emailEnabled}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            emailEnabled: e.target.checked,
                          }))
                        }
                        className="size-4 accent-primary"
                      />
                      邮件通知
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={settings.inappEnabled}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            inappEnabled: e.target.checked,
                          }))
                        }
                        className="size-4 accent-primary"
                      />
                      站内消息通知
                    </label>
                  </fieldset>

                  <div className="flex items-center gap-3">
                    <Button type="submit" disabled={saving}>
                      {saving ? "保存中…" : "保存"}
                    </Button>
                    {saveMessage ? (
                      <p
                        role="status"
                        className={cn(
                          "text-sm",
                          saveMessage.kind === "ok"
                            ? "text-emerald-600"
                            : "text-destructive"
                        )}
                      >
                        {saveMessage.text}
                      </p>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    设置保存在云端，多端登录一致；预警在快照采集（每小时）后 1
                    个周期内发出，同类预警 24 小时内不重复。
                  </p>
                </form>
              </CardContent>
            </Card>
          </section>
          {/* ── 最近预警 ── */}
          <section aria-label="最近预警">
            <Card>
              <CardHeader>
                <CardTitle>最近预警</CardTitle>
                <CardDescription>最近 50 条预警事件（时间按 UTC 展示）。</CardDescription>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <p className="text-sm text-muted-foreground">加载中…</p>
                ) : events.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    暂无预警事件。当前余额正常、Key 可用，或尚未触发任何阈值。
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y divide-border">
                    {events.map((ev) => (
                      <li
                        key={ev.id}
                        className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                              ev.severity === "critical"
                                ? "bg-destructive/10 text-destructive"
                                : "bg-muted text-muted-foreground"
                            )}
                          >
                            {TYPE_LABELS[ev.type] ?? ev.type}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {formatTime(ev.createdAt)}
                          </span>
                        </div>
                        <p
                          className={cn(
                            "text-sm",
                            ev.severity === "critical" && "text-destructive"
                          )}
                        >
                          {ev.message}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </section>

          {/* ── 账户设置 ── */}
          <section aria-label="账户设置">
            <Card>
              <CardHeader>
                <CardTitle>账户设置</CardTitle>
                <CardDescription>当前登录邮箱与账户操作。</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="current-email">当前邮箱</Label>
                  <Input id="current-email" value={email ?? ""} readOnly disabled />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="outline" onClick={() => signOut({ callbackUrl: "/" })}>
                    登出
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => {
                      setDeletingAccount(true);
                      setConfirmText("");
                      setAccountError(null);
                    }}
                  >
                    注销账户
                  </Button>
                </div>

                {deletingAccount ? (
                  <div className="flex flex-col gap-3 rounded-lg border border-destructive/40 p-4">
                    <p className="text-sm text-destructive">
                      此操作将永久删除你的 API Key、快照与设置数据，且不可恢复。请在输入框内输入
                      DELETE 后点击确认。
                    </p>
                    <div className="flex items-center gap-3">
                      <Input
                        type="text"
                        placeholder="输入 DELETE"
                        value={confirmText}
                        onChange={(e) => setConfirmText(e.target.value)}
                        aria-label="确认删除：输入 DELETE"
                      />
                      <Button
                        variant="destructive"
                        disabled={confirmText !== "DELETE"}
                        onClick={handleDeleteAccount}
                      >
                        确认注销
                      </Button>
                      <Button variant="ghost" onClick={() => setDeletingAccount(false)}>
                        取消
                      </Button>
                    </div>
                    {accountError ? (
                      <p role="alert" className="text-sm text-destructive">
                        {accountError}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </section>
        </>
      )}
    </main>
  );
}
