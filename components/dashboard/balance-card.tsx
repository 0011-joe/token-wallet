"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, RefreshCw } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { BalanceInfo } from "@/lib/api-types";
import { formatMoney, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * 账户总余额卡（AC2-1/2/3）：
 * - AC2-1：主数字 + 币种 + 数据更新时间（fetchedAt 相对时间）；
 * - AC2-2：isAvailable=false → 整卡警示态 + “余额不足，无法调用”；
 * - AC2-3：stale=true → 保留最后成功值，明示“当前获取失败”，不伪装实时。
 * 余额为官方精确值，不挂估算标识。
 */
export function BalanceCard({ balance, keyId }: { balance: BalanceInfo | null; keyId?: string }) {
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
        "flex flex-col",
        unavailable && "bg-destructive/5 ring-destructive/60"
      )}
      aria-invalid={unavailable || undefined}
    >
      <CardHeader>
        <CardTitle className="text-sm font-normal text-muted-foreground">
          账户总余额
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2">
        {balance ? (
          <>
            <div className="flex items-baseline gap-1.5">
              <span
                className={cn(
                  "text-3xl font-semibold tracking-tight",
                  unavailable && "text-destructive"
                )}
              >
                {formatMoney(balance.total, balance.currency)}
              </span>
              <span className="text-xs text-muted-foreground">
                {balance.currency}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>赠金 {formatMoney(balance.granted, balance.currency)}</span>
              <span>充值 {formatMoney(balance.toppedUp, balance.currency)}</span>
            </div>
            {balance.byCurrency.length > 1 ? (
              <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                {balance.byCurrency.map((c) => (
                  <span
                    key={c.currency}
                    className="rounded-md bg-muted px-1.5 py-0.5"
                  >
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
                <RefreshCw aria-hidden className={cn("size-3.5", refreshing && "animate-spin")} />
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
          <p className="mt-auto text-sm text-muted-foreground">
            暂无余额快照。快照任务会按小时拉取一次。
          </p>
        )}
      </CardContent>
      {unavailable ? (
        <div
          role="alert"
          className="mx-(--card-spacing) mb-(--card-spacing) flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
        >
          <CircleAlert aria-hidden className="size-4 shrink-0" />
          余额不足，无法调用
        </div>
      ) : null}
    </Card>
  );
}
