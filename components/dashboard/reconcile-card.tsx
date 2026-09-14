"use client";

/**
 * 月度对账 + runway 摘要卡（M11）。
 */
import { useQuery } from "@tanstack/react-query";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import { SourceBadge } from "./source-badge";

interface ReconcilePayload {
  month: string;
  provider: string;
  currency: string;
  modelUsageCost: string;
  usageDailyCost: string;
  absDiff: string;
  relDiffPct: number;
  usable: boolean;
  note: string;
}

interface RunwayPayload {
  runways: Array<{
    currency: string;
    runway:
      | { basis: "ok"; days: number; sampleDays: number; medianDailyCost: string; p25Days: number; p75Days: number }
      | { basis: "estimate"; days: number; sampleDays: number; note: string }
      | { basis: "insufficient"; sampleDays: number; reason: string };
  }>;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function ReconcileCard({
  month,
  provider,
}: {
  month: string;
  provider: string;
}) {
  const rec = useQuery({
    queryKey: ["billing", "reconcile", month, provider],
    queryFn: () =>
      fetchJson<ReconcilePayload>(
        `/api/billing/reconcile?month=${encodeURIComponent(month)}&provider=${encodeURIComponent(provider)}`
      ),
    retry: 0,
  });

  const rw = useQuery({
    queryKey: ["billing", "runway"],
    queryFn: () => fetchJson<RunwayPayload>("/api/billing/runway"),
    retry: 0,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          月度对账与 runway
          <SourceBadge source="csv_official" />
        </CardTitle>
        <CardDescription>
          计价/导入合计 vs UsageDaily；runway 按最近 30 天有效日估算
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {rec.isLoading ? (
          <p className="text-muted-foreground">对账加载中…</p>
        ) : rec.data ? (
          <div className="rounded-xl border border-border p-3">
            <p className="font-medium">
              {rec.data.month} · {rec.data.provider}
            </p>
            <p className="mt-1 text-muted-foreground">
              ModelUsage {formatMoney(rec.data.modelUsageCost, rec.data.currency)} · UsageDaily{" "}
              {formatMoney(rec.data.usageDailyCost, rec.data.currency)}
            </p>
            <p className="mt-1">
              绝对差 {formatMoney(rec.data.absDiff, rec.data.currency)}（
              {rec.data.relDiffPct.toFixed(4)}%）
              {rec.data.usable ? (
                <span className="ml-2 text-emerald-700 dark:text-emerald-400">一致</span>
              ) : (
                <span className="ml-2 text-amber-700 dark:text-amber-400">有差异</span>
              )}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{rec.data.note}</p>
          </div>
        ) : rec.isError ? (
          <p className="text-muted-foreground">对账数据暂不可用</p>
        ) : null}

        {rw.data?.runways?.length ? (
          <div className="flex flex-col gap-2">
            {rw.data.runways.map((r) => {
              const w = r.runway;
              if (w.basis === "insufficient") {
                return (
                  <p key={r.currency} className="text-muted-foreground">
                    {r.currency} runway：数据不足（{w.sampleDays} 天有效样本）
                  </p>
                );
              }
              return (
                <p key={r.currency}>
                  {r.currency} runway：约{" "}
                  <span className="font-medium">{w.days} 天</span>
                  <span className="text-muted-foreground">
                    （{w.sampleDays} 天样本，按最近速度估算，非承诺）
                  </span>
                  {w.basis === "estimate" ? (
                    <span className="ml-2 text-amber-700 dark:text-amber-400">含估算</span>
                  ) : null}
                </p>
              );
            })}
          </div>
        ) : rw.isError ? (
          <p className="text-muted-foreground">runway 暂不可用</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
