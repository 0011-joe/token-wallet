"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import type { BalanceInfo } from "@/lib/api-types";
import { formatRelative } from "@/lib/format";
import {
  formatMoney,
  moneyDiv,
  moneyIsPositive,
  moneyToNumber,
} from "@/lib/money";

interface Slice {
  name: string;
  key: string;
  value: string;
  color: string;
}

/**
 * 余额构成卡（FR-3 / AC3.4）：按真实字段渲染、缺项优雅隐藏。
 * DeepSeek → 赠金/充值；Kimi → 现金/代金券/欠费；火山 → 现金/信控/冻结/欠费。
 */
export function BalanceComposition({ balance }: { balance: BalanceInfo | null }) {
  const available = balance?.available ?? "0";
  const slices: Slice[] = balance
    ? ([
        { name: "赠金", key: "granted", value: balance.breakdown.granted, color: "var(--chart-1)" },
        { name: "代金券", key: "voucher", value: balance.breakdown.voucher, color: "var(--chart-1)" },
        { name: "充值", key: "cash", value: balance.breakdown.cash, color: "var(--chart-5)" },
        { name: "信控", key: "creditLimit", value: balance.breakdown.creditLimit, color: "var(--chart-2)" },
        { name: "冻结", key: "frozen", value: balance.breakdown.frozen, color: "var(--chart-3)" },
      ].filter((s): s is Slice => typeof s.value === "string") as Slice[])
    : [];

  const hasComposition = balance !== null && moneyIsPositive(available) && slices.length > 0;

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="text-sm font-normal text-muted-foreground">
          余额构成
        </CardTitle>
        <CardDescription>
          {balance ? `可用 ${formatMoney(available, balance.currency)}` : "暂无快照数据"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {hasComposition ? (
          <>
            <div className="relative mx-auto size-40 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={slices.map((s) => ({ name: s.name, value: moneyToNumber(s.value) }))}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={54}
                    outerRadius={72}
                    paddingAngle={2}
                    strokeWidth={0}
                    isAnimationActive={false}
                  >
                    {slices.map((s) => (
                      <Cell key={s.key} fill={s.color} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-lg font-semibold tracking-tight">
                  {formatMoney(available, balance.currency)}
                </span>
                <span className="text-xs text-muted-foreground">可用</span>
              </div>
            </div>
            <ul className="flex flex-col gap-2 text-sm">
              {slices.map((s) => {
                const pct = (moneyToNumber(moneyDiv(s.value, available)) * 100).toFixed(1);
                return (
                  <li key={s.key} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <span aria-hidden className="size-2.5 rounded-full" style={{ background: s.color }} />
                      {s.name}
                    </span>
                    <span className="tabular-nums">
                      {formatMoney(s.value, balance.currency)}（{pct}%）
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {balance
              ? "余额为 0 或该平台未提供构成明细，暂无构成数据。"
              : "暂无余额快照，快照任务会按小时拉取一次。"}
          </p>
        )}
        {balance && balance.byCurrency.length > 1 ? (
          <div className="mt-auto flex flex-col gap-1 text-xs text-muted-foreground">
            <p>其他币种快照（不混算、不换算）：</p>
            {balance.byCurrency.map((c) => (
              <p key={c.currency}>
                {formatMoney(c.available, c.currency)} · 更新于{" "}
                {formatRelative(c.fetchedAt)}
              </p>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
