"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarDays, CircleAlert, RefreshCw, Sun, Wallet } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { BalanceInfo, TodayMonthCost } from "@/lib/api-types";
import { formatMoney, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

import { EstimateBadge } from "./estimate-badge";

/**
 * 账户总余额主卡（对齐参考图的 Hero 卡）：
 * - 超大余额数字（渐变），右上「可用 / 余额不足」状态徽章（AC2-2，文字+颜色双编码）；
 * - 卡内并入「当日消耗」与「本月消耗」两个小卡（估算标识，AC3-4）；
 * - 底部：赠金/充值构成、多币种、更新时间、刷新余额按钮（手动实时拉取）。
 * 余额为官方精确值；AC2-3 stale 时保留最后成功值并明示失败。
 */
export function BalanceCard({
  balance,
  today,
  month,
  keyId,
  keyLabel,
}: {
  balance: BalanceInfo | null;
  today: TodayMonthCost;
  month: TodayMonthCost;
  keyId?: string;
  keyLabel?: string;
}) {
  const unavailable = balance !== null && !balance.isAvailable;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  /** 手动触发：实时调官方余额接口 → 写快照 → 刷新看板数据 */
  async function handleRefresh() {
    if (!keyId || refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const res = await fetch(`/api/keys/${keyId}/refresh`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setRefreshError(body?.error ?? "刷新失败，请稍后重试");
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["keys"] });
    } catch {
      setRefreshError("网络错误，请稍后重试");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Card
      className={cn(
        "relative overflow-hidden border-white/10 bg-gradient-to-b from-sky-500/10 via-card to-indigo-500/15 shadow-lg backdrop-blur-xl dark:from-sky-400/15 dark:via-card/60 dark:to-indigo-500/20",
        unavailable && "from-rose-500/10 to-rose-500/15 ring-1 ring-destructive/40"
      )}
      aria-invalid={unavailable || undefined}
    >
      {/* 氛围高光（深色主题下更明显，呼应参考图） */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 right-[-10%] h-56 w-56 rounded-full bg-sky-400/20 blur-3xl dark:bg-sky-400/25"
      />
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
          <span className="grid size-7 place-items-center rounded-lg bg-primary/10 text-primary">
            <Wallet aria-hidden className="size-4" />
          </span>
          账户总余额
        </CardTitle>
        {balance ? (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
              unavailable
                ? "bg-destructive/15 text-destructive"
                : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                unavailable ? "bg-destructive" : "bg-emerald-500"
              )}
            />
            {unavailable ? "余额不足，无法调用" : "可用"}
          </span>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {balance ? (
          <>
            {/* 超大余额数字（渐变） */}
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span
                className={cn(
                  "bg-gradient-to-r bg-clip-text text-5xl font-bold tracking-tight text-transparent sm:text-6xl",
                  "from-sky-500 via-blue-600 to-indigo-600 dark:from-sky-300 dark:via-blue-400 dark:to-indigo-400"
                )}
              >
                {formatMoney(balance.total, balance.currency)}
              </span>
              <span className="text-sm text-muted-foreground">{balance.currency}</span>
            </div>

            {/* 当日 / 本月消耗（并入主卡，估算标识） */}
            <div className="grid gap-3 sm:grid-cols-2">
              <SubUsageCard
                icon={<Sun aria-hidden className="size-4" />}
                title="当日消耗"
                cost={today}
              />
              <SubUsageCard
                icon={<CalendarDays aria-hidden className="size-4" />}
                title="本月消耗"
                cost={month}
              />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>赠金 {formatMoney(balance.granted, balance.currency)}</span>
              <span>充值 {formatMoney(balance.toppedUp, balance.currency)}</span>
              <span>Key：{keyLabel ?? "—"}</span>
            </div>
            {balance.byCurrency.length > 1 ? (
              <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                其他币种快照（不混算、不换算）：
                {balance.byCurrency.map((c) => (
                  <span key={c.currency} className="rounded-md bg-muted px-1.5 py-0.5">
                    {formatMoney(c.total, c.currency)}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="mt-auto flex items-center justify-between gap-2">
              <p
                className={cn(
                  "flex items-center gap-1 text-xs",
                  balance.stale
                    ? "text-amber-700 dark:text-amber-500"
                    : "text-muted-foreground"
                )}
              >
                {balance.stale ? <CircleAlert aria-hidden className="size-3.5" /> : null}
                {balance.stale
                  ? `最后成功值 · 更新于 ${formatRelative(balance.fetchedAt)} · 当前获取失败`
                  : `更新于 ${formatRelative(balance.fetchedAt)}`}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={refreshing}
                aria-label="立即刷新余额"
              >
                <RefreshCw
                  aria-hidden
                  className={cn("size-3.5", refreshing && "animate-spin")}
                />
                刷新余额
              </Button>
            </div>
            {refreshError ? (
              <p role="alert" className="text-xs text-destructive">
                {refreshError}
              </p>
            ) : null}
          </>
        ) : (
          <div className="flex flex-col gap-3 py-4">
            <p className="text-sm text-muted-foreground">
              暂无余额快照。快照任务会按小时拉取一次，也可以点「立即刷新余额」手动获取。
            </p>
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={handleRefresh}
              disabled={refreshing}
              aria-label="立即刷新余额"
            >
              <RefreshCw
                aria-hidden
                className={cn("size-3.5", refreshing && "animate-spin")}
              />
              刷新余额
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** 主卡内的小消耗卡（参考图「当日消耗 / 本月消耗」样式：橙色数值 + 估算标识） */
function SubUsageCard({
  icon,
  title,
  cost,
}: {
  icon: React.ReactNode;
  title: string;
  cost: TodayMonthCost;
}) {
  const noBaseline = cost.from === "no-snapshot";
  return (
    <div
      data-testid={title === "当日消耗" ? "card-today" : "card-month"}
      className="rounded-xl border border-white/10 bg-card/50 p-3 backdrop-blur-sm dark:bg-white/5"
    >
      <div className="flex items-center justify-between gap-1.5">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {icon}
          {title}
        </span>
        <EstimateBadge />
      </div>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight text-amber-600 dark:text-amber-400">
        {formatMoney(cost.cost, cost.currency)}
      </p>
      {noBaseline ? (
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          快照不足 2 个，暂无估算基准
        </p>
      ) : null}
    </div>
  );
}
