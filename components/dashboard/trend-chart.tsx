"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { TrendDay } from "@/lib/api-types";
import { formatAxisMoney, formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

import { EstimateBadge } from "./estimate-badge";
import { GapLegend } from "./gap-legend";

export const RANGES = [7, 30, 90] as const;
export type RangeValue = (typeof RANGES)[number];

// ── 图表数据映射：缺口日的 cost 从主序列切出，单独用气泡标记 ──
interface Point {
  date: string;
  cost: number | null;
  gapCost: number | null;
  hasGap: boolean;
}

function toPoints(days: TrendDay[]): Point[] {
  return days.map((d) => ({
    date: d.date,
    cost: d.hasGap ? null : d.cost,
    gapCost: d.hasGap ? d.cost : null,
    hasGap: d.hasGap,
  }));
}

function tickDay(date: string): string {
  return date.slice(5).replace("-", "/");
}

function renderGapDot(props: { cx?: number; cy?: number }) {
  const { cx, cy } = props;
  if (cx == null || cy == null) return <g />;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={4}
      fill="#f59e0b"
      stroke="var(--background)"
      strokeWidth={1.5}
    />
  );
}

interface TrendTooltipProps {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number | null; payload?: Point }>;
}

function TrendTooltip({ active, payload, currency }: TrendTooltipProps & { currency: string }) {
  if (!active || !payload || payload.length === 0) return null;
  // 从数据点对象取值：主序列 cost 优先；缺口日 cost 为 null，用 gapCost（同一数值）。
  // 取 payload 中带 date 的条目（Recharts Scatter 条目的 value 可能是对象，不能作为数字用）
  const point = payload.find((p) => p.payload?.date)?.payload;
  if (!point) return null;
  const value =
    typeof point.cost === "number"
      ? point.cost
      : typeof point.gapCost === "number"
        ? point.gapCost
        : 0;
  return (
    <div className="rounded-lg bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg ring-1 ring-foreground/10">
      <p className="font-medium">{point.date}</p>
      <p>估算消耗：{formatMoney(value, currency)}</p>
      {point.hasGap ? (
        <p className="mt-0.5 text-amber-700 dark:text-amber-500">
          该日存在快照缺口，数值为相邻快照插值估算，可能偏低
        </p>
      ) : null}
    </div>
  );
}

/**
 * 近 N 天日消耗趋势卡（AC3-3/AC3-4）：
 * - 7/30/90 切换（PRD §7.3）；
 * - 缺口日以断点（主序列断开）+ 琥珀色点标记 + 图例说明；
 * - 卡标题挂「估算」标识。
 */
export function TrendCard({
  days,
  range,
  currency,
  onRangeChange,
  className,
}: {
  days: TrendDay[];
  range: RangeValue;
  currency: string;
  onRangeChange: (range: RangeValue) => void;
  className?: string;
}) {
  const data = toPoints(days);

  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            日消耗趋势
            <EstimateBadge />
          </span>
          <div
            role="group"
            aria-label="趋势时间范围"
            className="flex items-center rounded-lg border border-border p-0.5"
          >
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={range === r}
                onClick={() => onRangeChange(r)}
                className={cn(
                  "h-6 min-w-9 rounded-md px-2 text-xs font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  range === r
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {r} 天
              </button>
            ))}
          </div>
        </CardTitle>
        <CardDescription>
          以余额快照差值估算的单位日消耗（UTC）· 单日 {currency}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="min-h-0 flex-1">
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart
              data={data}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="trend-cost-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid
                vertical={false}
                strokeDasharray="3 3"
                stroke="var(--border)"
              />
              <XAxis
                dataKey="date"
                tickFormatter={tickDay}
                tickLine={false}
                axisLine={false}
                minTickGap={24}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              />
              <YAxis
                tickFormatter={formatAxisMoney}
                tickLine={false}
                axisLine={false}
                width={44}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              />
              <Tooltip
                content={<TrendTooltip currency={currency} />}
                cursor={{ stroke: "var(--border)" }}
              />
              <Area
                name="日消耗（估算）"
                type="monotone"
                dataKey="cost"
                stroke="var(--chart-2)"
                strokeWidth={2}
                fill="url(#trend-cost-fill)"
                connectNulls={false}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
              <Scatter
                name="快照缺口"
                dataKey="gapCost"
                shape={renderGapDot}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <GapLegend />
      </CardContent>
    </Card>
  );
}
