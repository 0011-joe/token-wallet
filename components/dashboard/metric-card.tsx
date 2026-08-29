"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { TodayMonthCost } from "@/lib/api-types";
import { formatMoney } from "@/lib/format";

import { EstimateBadge } from "./estimate-badge";

/**
 * 今日 / 本月消耗卡（估算口径）：数字旁固定挂「估算」标识（AC3-4）。
 * 快照不足（from=no-snapshot）时明确说明，不伪装数据。
 */
export function MetricCard({
  title,
  cost,
}: {
  title: string;
  cost: TodayMonthCost;
}) {
  const noBaseline = cost.from === "no-snapshot";

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-normal text-muted-foreground">
          {title}
          <EstimateBadge />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        <div className="flex items-baseline gap-1.5">
          <span className="text-3xl font-semibold tracking-tight">
            {formatMoney(cost.cost, cost.currency)}
          </span>
          <span className="text-xs text-muted-foreground">{cost.currency}</span>
        </div>
        <p className="mt-auto pt-2 text-xs text-muted-foreground">
          {noBaseline
            ? "快照不足 2 个，暂无估算基准"
            : "由余额快照差值估算，点击「估算」查看口径"}
        </p>
      </CardContent>
    </Card>
  );
}
