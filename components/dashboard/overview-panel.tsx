"use client";

import Link from "next/link";
import { CircleAlert, RefreshCw } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PROVIDER_META } from "@/lib/providers/meta";
import { formatDateTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import type { DashboardOverview, OverviewCurrency, OverviewPlatform } from "@/lib/api-types";

/** 跨平台总览（FR-3 / AC3.1-3.3）：分币种合计 + 平台卡 + 健康区。 */
export function OverviewPanel({ data }: { data: DashboardOverview["overview"] }) {
  return (
    <div className="flex flex-col gap-6">
      {/* 分币种合计（不混算、不换算） */}
      <div className="grid gap-4 sm:grid-cols-2">
        {data.currencies.length === 0 ? (
          <Card className="sm:col-span-2">
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              暂无余额快照。快照任务会按小时拉取一次，或到凭证页手动「立即刷新」。
            </CardContent>
          </Card>
        ) : (
          data.currencies.map((c) => (
            <CurrencyCard key={c.currency} currency={c} />
          ))
        )}
      </div>

      {/* 平台卡 */}
      <div className="grid gap-4 lg:grid-cols-3">
        {data.platforms.map((p) => (
          <PlatformCard key={p.provider} platform={p} />
        ))}
      </div>
    </div>
  );
}

function CurrencyCard({ currency }: { currency: OverviewCurrency }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-sm font-normal text-muted-foreground">
          可用余额合计
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs">{currency.currency}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-4xl font-semibold tracking-tight">
          {formatMoney(currency.totalAvailable, currency.currency)}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {currency.credentialCount} 个凭证 ·{" "}
          {currency.latestFetchedAt
            ? `数据截至 ${formatDateTime(currency.latestFetchedAt)}`
            : "暂无数据"}
        </p>
      </CardContent>
    </Card>
  );
}

function PlatformCard({ platform }: { platform: OverviewPlatform }) {
  const meta = PROVIDER_META[platform.provider];
  const hasIssue = platform.failedCount > 0 || platform.staleCount > 0;
  return (
    <Card className={hasIssue ? "border-amber-500/50" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-sm">
          <span>{meta?.label ?? platform.provider}</span>
          <span
            aria-hidden
            className={`inline-block size-2 rounded-full ${hasIssue ? "bg-amber-500" : "bg-emerald-500"}`}
          />
        </CardTitle>
        <CardDescription>
          {platform.credentialCount} 个凭证
          {platform.latestFetchedAt
            ? ` · 数据截至 ${formatDateTime(platform.latestFetchedAt)}`
            : " · 暂无数据"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {platform.byCurrency.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无成功快照。</p>
        ) : (
          platform.byCurrency.map((c) => (
            <div key={c.currency} className="flex items-baseline justify-between">
              <span className="text-2xl font-semibold tracking-tight">
                {formatMoney(c.available, c.currency)}
              </span>
              <span className="text-xs text-muted-foreground">{c.currency}</span>
            </div>
          ))
        )}
        {platform.failedCount > 0 ? (
          <p className="flex items-center gap-1 text-xs text-destructive">
            <CircleAlert aria-hidden className="size-3.5 shrink-0" />
            {platform.failedCount} 个凭证拉取失败
          </p>
        ) : null}
        {platform.staleCount > 0 ? (
          <p className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-500">
            <RefreshCw aria-hidden className="size-3.5 shrink-0" />
            {platform.staleCount} 个凭证数据已陈旧（获取失败 / 数据截至 xx:xx，未显示为 0）
          </p>
        ) : null}
        <Link
          href="/credentials"
          className="mt-1 text-xs text-primary underline underline-offset-4 hover:opacity-80"
        >
          管理凭证
        </Link>
      </CardContent>
    </Card>
  );
}
