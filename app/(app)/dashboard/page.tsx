"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, KeyRound, RefreshCw } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BalanceCard } from "@/components/dashboard/balance-card";
import { OverviewPanel } from "@/components/dashboard/overview-panel";
import { TrendCard, type RangeValue } from "@/components/dashboard/trend-chart";
import { BalanceComposition } from "@/components/dashboard/balance-composition";
import { ModelUsage } from "@/components/dashboard/model-usage";
import { StaleBanner } from "@/components/dashboard/stale-banner";
import { fetchCredentials, fetchDashboard, fetchOverview } from "@/lib/api-client";
import type { DashboardData } from "@/lib/api-types";

export default function DashboardPage() {
  // useSearchParams 需要 Suspense 边界（Next.js 构建期要求）
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardContent />
    </Suspense>
  );
}

function DashboardContent() {
  const params = useSearchParams();
  const credentialId = params.get("credentialId");
  const [range, setRange] = useState<RangeValue>(30);

  // 凭证列表：未选中时自动选第一个（选中态写入 URL query，刷新不丢）
  const credQuery = useQuery({
    queryKey: ["credentials"],
    queryFn: fetchCredentials,
    retry: 0,
  });


  const overviewQuery = useQuery({
    queryKey: ["dashboard", "overview"],
    queryFn: fetchOverview,
    enabled: credentialId === null,
    retry: 0,
  });

  const dashQuery = useQuery({
    queryKey: ["dashboard", credentialId ?? "none", range],
    queryFn: () => fetchDashboard(credentialId as string, range),
    // 仅当 credentialId 在列表中存在时才请求（避免删除后的陈旧 URL 触发 404 闪现）
    enabled:
      credentialId !== null &&
      (credQuery.data?.credentials.some((c) => c.id === credentialId) ?? false),
    retry: 1,
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">仪表盘</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          余额、消耗估算与分模型用量总览
        </p>
      </div>

      {credQuery.isLoading ? <DashboardSkeleton /> : null}

      {credQuery.isError ? (
        <Card>
          <CardContent className="flex items-center gap-3 py-8">
            <CircleAlert aria-hidden className="size-5 text-destructive" />
            <p className="text-sm text-destructive">凭证列表加载失败。</p>
            <Button variant="outline" size="sm" onClick={() => void credQuery.refetch()}>
              <RefreshCw />
              重试
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {credentialId === null && overviewQuery.data ? (
        (() => {
          const ov = overviewQuery.data.overview;
          const hasIssue = ov.platforms.some(
            (p) => p.failedCount > 0 || p.staleCount > 0
          );
          const latestSuccessAt =
            ov.currencies
              .map((c) => c.latestFetchedAt)
              .filter((x): x is string => Boolean(x))
              .sort()
              .at(-1) ??
            ov.platforms
              .map((p) => p.latestFetchedAt)
              .filter((x): x is string => Boolean(x))
              .sort()
              .at(-1) ??
            null;
          return (
            <>
              <StaleBanner
                key={ov.generatedAt}
                hasIssue={hasIssue}
                latestSuccessAt={latestSuccessAt}
                signature={ov.generatedAt}
              />
              <OverviewPanel data={ov} />
            </>
          );
        })()
      ) : null}

      {credentialId === null && overviewQuery.isError ? (
        <Card>
          <CardContent className="flex items-center gap-3 py-8">
            <CircleAlert aria-hidden className="size-5 text-destructive" />
            <p className="text-sm text-destructive">总览加载失败。</p>
            <Button variant="outline" size="sm" onClick={() => void overviewQuery.refetch()}>
              <RefreshCw />
              重试
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {credQuery.data && credQuery.data.credentials.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <KeyRound aria-hidden className="size-8 text-muted-foreground" />
            <div className="flex flex-col gap-1">
              <p className="font-medium">还未绑定凭证</p>
              <p className="text-sm text-muted-foreground">
                添加 DeepSeek / Kimi / 豆包 任一平台凭证，即可看到余额与消耗估算。
              </p>
            </div>
            <Link href="/credentials" className={buttonVariants()}>
              去添加凭证
            </Link>
          </CardContent>
        </Card>
      ) : null}

      {credQuery.data && credQuery.data.credentials.length > 0 ? (
        <>
          {dashQuery.isLoading ? <DashboardSkeleton /> : null}

          {dashQuery.isError ? (
            <Card>
              <CardContent className="flex flex-col items-start gap-3 py-8">
                <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
                  <CircleAlert aria-hidden className="size-5 shrink-0" />
                  看板数据加载失败：{dashQuery.error instanceof Error ? dashQuery.error.message : "未知错误"}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void dashQuery.refetch()}
                >
                  <RefreshCw />
                  重试
                </Button>
              </CardContent>
            </Card>
          ) : null}

          {dashQuery.data ? <Dashboard data={dashQuery.data} range={range} onRangeChange={setRange} /> : null}
        </>
      ) : null}
    </div>
  );
}

function Dashboard({
  data,
  range,
  onRangeChange,
}: {
  data: DashboardData;
  range: RangeValue;
  onRangeChange: (range: RangeValue) => void;
}) {
  const currency = data.today.currency;
  return (
    <div className="flex flex-col gap-4">
      {/* 第一行：四张等宽卡片（移动端纵向堆叠） */}
      {/* 第一屏：余额主卡（含当日/本月消耗）+ 趋势图 */}
      <div data-testid="card-balance" className="grid gap-4">
        <BalanceCard
          balance={data.balance}
          today={data.today}
          month={data.month}
          credentialId={data.credential.id}
          credentialLabel={data.credential.label}
          provider={data.credential.provider}
        />
        <TrendCard
          days={data.trend.days}
          range={range}
          currency={currency}
          onRangeChange={onRangeChange}
          className="w-full"
        />
      </div>

      {/* 第二屏：余额构成（右 1/3）+ 分模型 Token 用量（左 2/3） */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ModelUsage />
        </div>
        <BalanceComposition balance={data.balance} />
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-4" aria-hidden>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-36 rounded-xl bg-muted" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="h-72 rounded-xl bg-muted lg:col-span-2" />
        <div className="h-72 rounded-xl bg-muted" />
      </div>
      <div className="h-64 rounded-xl bg-muted" />
    </div>
  );
}
