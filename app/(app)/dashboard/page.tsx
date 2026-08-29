"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, KeyRound, RefreshCw } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BalanceCard } from "@/components/dashboard/balance-card";
import { MetricCard } from "@/components/dashboard/metric-card";
import { StatusCard } from "@/components/dashboard/status-card";
import { TrendCard, type RangeValue } from "@/components/dashboard/trend-chart";
import { BalanceComposition } from "@/components/dashboard/balance-composition";
import { ModelUsage } from "@/components/dashboard/model-usage";
import { fetchDashboard, fetchKeys } from "@/lib/api-client";
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
  const router = useRouter();
  const params = useSearchParams();
  const keyId = params.get("keyId");
  const [range, setRange] = useState<RangeValue>(30);

  // Key 列表：未选中时自动选第一个（选中态写入 URL query，刷新不丢）
  const keysQuery = useQuery({
    queryKey: ["keys"],
    queryFn: fetchKeys,
    retry: 0,
  });

  useEffect(() => {
    const keys = keysQuery.data?.keys;
    if (!keys || keys.length === 0) return;
    const exists = keyId !== null && keys.some((k) => k.id === keyId);
    if (!exists) {
      router.replace(`/dashboard?keyId=${encodeURIComponent(keys[0].id)}`);
    }
  }, [keysQuery.data, keyId, router]);

  const dashQuery = useQuery({
    queryKey: ["dashboard", keyId ?? "none", range],
    queryFn: () => fetchDashboard(keyId as string, range),
    // 仅当 keyId 在列表中存在时才请求（避免删除后的陈旧 URL 触发 404 闪现）
    enabled:
      keyId !== null &&
      (keysQuery.data?.keys.some((k) => k.id === keyId) ?? false),
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

      {keysQuery.isLoading ? <DashboardSkeleton /> : null}

      {keysQuery.isError ? (
        <Card>
          <CardContent className="flex items-center gap-3 py-8">
            <CircleAlert aria-hidden className="size-5 text-destructive" />
            <p className="text-sm text-destructive">Key 列表加载失败。</p>
            <Button variant="outline" size="sm" onClick={() => void keysQuery.refetch()}>
              <RefreshCw />
              重试
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {keysQuery.data && keysQuery.data.keys.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <KeyRound aria-hidden className="size-8 text-muted-foreground" />
            <div className="flex flex-col gap-1">
              <p className="font-medium">还未绑定 API Key</p>
              <p className="text-sm text-muted-foreground">
                添加一个 DeepSeek 平台创建的 Key，即可看到余额与消耗估算。
              </p>
            </div>
            <Link href="/keys" className={buttonVariants()}>
              去添加 Key
            </Link>
          </CardContent>
        </Card>
      ) : null}

      {keysQuery.data && keysQuery.data.keys.length > 0 ? (
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
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div data-testid="card-balance">
          <BalanceCard balance={data.balance} keyId={data.key.id} />
        </div>
        <div data-testid="card-today">
          <MetricCard title="今日消耗" cost={data.today} />
        </div>
        <div data-testid="card-month">
          <MetricCard title="本月消耗" cost={data.month} />
        </div>
        <div data-testid="card-status">
          <StatusCard apiKey={data.key} balance={data.balance} />
        </div>
      </div>

      {/* 第二行：趋势图（左，2/3）+ 余额构成（右，1/3） */}
      <div className="grid gap-4 lg:grid-cols-3">
        <TrendCard
          days={data.trend.days}
          range={range}
          currency={currency}
          onRangeChange={onRangeChange}
          className="lg:col-span-2"
        />
        <BalanceComposition balance={data.balance} />
      </div>

      {/* 第三行：分模型 Token 用量（可选 CSV 导入，不影响主看板） */}
      <ModelUsage />
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
