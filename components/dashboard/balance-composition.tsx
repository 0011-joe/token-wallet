"use client";

import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { BalanceInfo } from "@/lib/api-types";
import { formatMoney, formatRelative } from "@/lib/format";

/**
 * 余额构成卡：赠金 / 充值环形图 + 明细（PRD §7.3）。
 * 蓝系双色（chart-1 赠金 / chart-5 充值），取色走 CSS 变量随主题切换。
 */
export function BalanceComposition({ balance }: { balance: BalanceInfo | null }) {
  const total = balance?.total ?? 0;
  const granted = balance?.granted ?? 0;
  const toppedUp = balance?.toppedUp ?? 0;
  const pieData = balance
    ? [
        { name: "赠金", value: granted },
        { name: "充值", value: toppedUp },
      ]
    : [];

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="text-sm font-normal text-muted-foreground">
          余额构成
        </CardTitle>
        <CardDescription>
          {balance ? `赠金 / 充值（${balance.currency}）` : "暂无快照数据"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {balance && total > 0 ? (
          <>
            <div className="relative mx-auto size-40 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={54}
                    outerRadius={72}
                    paddingAngle={2}
                    strokeWidth={0}
                    isAnimationActive={false}
                  >
                    <Cell fill="var(--chart-1)" />
                    <Cell fill="var(--chart-5)" />
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-lg font-semibold tracking-tight">
                  {formatMoney(total, balance.currency)}
                </span>
                <span className="text-xs text-muted-foreground">总额</span>
              </div>
            </div>
            <ul className="flex flex-col gap-2 text-sm">
              <li className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <span
                    aria-hidden
                    className="size-2.5 rounded-full"
                    style={{ background: "var(--chart-1)" }}
                  />
                  赠金
                </span>
                <span className="tabular-nums">
                  {formatMoney(granted, balance.currency)}（
                  {((granted / total) * 100).toFixed(1)}%）
                </span>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <span
                    aria-hidden
                    className="size-2.5 rounded-full"
                    style={{ background: "var(--chart-5)" }}
                  />
                  充值
                </span>
                <span className="tabular-nums">
                  {formatMoney(toppedUp, balance.currency)}（
                  {((toppedUp / total) * 100).toFixed(1)}%）
                </span>
              </li>
            </ul>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {balance
              ? "余额为 0，暂无构成数据。"
              : "暂无余额快照，快照任务会按小时拉取一次。"}
          </p>
        )}
        {balance && balance.byCurrency.length > 1 ? (
          <div className="mt-auto flex flex-col gap-1 text-xs text-muted-foreground">
            <p>其他币种快照（不混算、不换算）：</p>
            {balance.byCurrency.map((c) => (
              <p key={c.currency}>
                {formatMoney(c.total, c.currency)} · 更新于{" "}
                {formatRelative(c.fetchedAt)}
              </p>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
