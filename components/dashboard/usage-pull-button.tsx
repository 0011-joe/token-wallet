"use client";

/**
 * 用量拉取按钮：POST /api/usage/pull。
 *
 * - mode=derived → 展示「估算」徽章（复用 EstimateBadge）+ note
 * - mode=unsupported → 友好灰字说明，不报红
 * - 501 provider not ready → 提示改用 CSV
 * - 成功后回调 onPulled 刷新 models 查询；不破坏既有 CSV 上传区
 */
import { useState } from "react";
import { CircleAlert, CircleCheck, CloudDownload, Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ProviderId } from "@/lib/api-types";
import { cn } from "@/lib/utils";

import { EstimateBadge } from "./estimate-badge";

interface PullResponse {
  ok?: boolean;
  mode?: "api" | "derived" | "csv" | "unsupported";
  month?: string | null;
  months?: string[];
  rows?: number;
  models?: number;
  currency?: string;
  note?: string;
  error?: string;
  message?: string;
}

export function UsagePullButton({
  provider,
  onPulled,
  className,
}: {
  /** 用量归属平台 */
  provider: ProviderId;
  /** 拉取成功（有数据入库）后回调，父组件负责刷新 models 查询 */
  onPulled: () => void;
  className?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: "ok" | "estimate" | "unsupported";
    text: string;
  } | null>(null);

  async function pull() {
    if (loading) return;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const res = await fetch("/api/usage/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      let data: PullResponse = {};
      try {
        data = (await res.json()) as PullResponse;
      } catch {
        data = {};
      }

      if (!res.ok) {
        if (res.status === 501) {
          setNotice({
            tone: "unsupported",
            text:
              data.message ??
              data.error ??
              "该平台用量拉取尚未就绪，请先使用 CSV 导入。",
          });
          return;
        }
        setError(data.error ?? data.message ?? `拉取失败（HTTP ${res.status}）`);
        return;
      }

      if (data.mode === "unsupported") {
        setNotice({
          tone: "unsupported",
          text: data.note ?? "该平台暂不支持用量拉取，请使用 CSV 导入。",
        });
        return;
      }

      if ((data.rows ?? 0) > 0) {
        const monthLabel = data.month ? `${data.month}：` : "";
        const base = `${monthLabel}已拉取 ${data.rows} 行 / ${data.models ?? 0} 个模型`;
        if (data.mode === "derived") {
          setNotice({
            tone: "estimate",
            text: data.note ? `${base}。${data.note}` : base,
          });
        } else {
          setNotice({ tone: "ok", text: base });
        }
        onPulled();
        return;
      }

      setNotice({
        tone: "unsupported",
        text: data.note ?? "拉取成功，但没有可入库的用量数据。",
      });
    } catch {
      setError("网络异常，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void pull()}
          disabled={loading}
          aria-busy={loading}
        >
          <CloudDownload aria-hidden className={cn(loading && "animate-pulse")} />
          {loading ? "拉取中…" : "一键拉取用量"}
        </Button>
        {notice?.tone === "estimate" ? <EstimateBadge /> : null}
      </div>

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 text-sm text-destructive"
        >
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className={cn(
            "flex items-start gap-1.5 text-sm",
            notice.tone === "ok" && "text-emerald-700 dark:text-emerald-500",
            notice.tone === "estimate" && "text-foreground",
            notice.tone === "unsupported" && "text-muted-foreground"
          )}
        >
          {notice.tone === "ok" ? (
            <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
          ) : (
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          )}
          <span>{notice.text}</span>
        </p>
      ) : null}
    </div>
  );
}
