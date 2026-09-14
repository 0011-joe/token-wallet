"use client";

/**
 * 预算管理（M11 UI）：列表 + 新建 + 停用。
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/money";

interface BudgetItem {
  id: string;
  amount: string;
  currency: string;
  period: string;
  scope: string;
  provider: string | null;
  warnPct: number;
  criticalPct: number;
  runwayAlertDays: number | null;
}

async function fetchBudgets(): Promise<BudgetItem[]> {
  const res = await fetch("/api/budgets");
  if (!res.ok) throw new Error("加载失败");
  const body = (await res.json()) as { budgets: BudgetItem[] };
  return body.budgets;
}

export function BudgetSettings() {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("CNY");
  const [warnPct, setWarnPct] = useState("80");
  const [criticalPct, setCriticalPct] = useState("100");
  const [runwayDays, setRunwayDays] = useState("3");
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["budgets"],
    queryFn: fetchBudgets,
    retry: 0,
  });

  const createMut = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/budgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount,
          currency: currency.toUpperCase(),
          period: "month",
          scope: "global",
          warnPct: Number(warnPct),
          criticalPct: Number(criticalPct),
          runwayAlertDays: runwayDays === "" ? null : Number(runwayDays),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "创建失败");
      return body;
    },
    onSuccess: () => {
      setError(null);
      setAmount("");
      void queryClient.invalidateQueries({ queryKey: ["budgets"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const delMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/budgets/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("停用失败");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["budgets"] });
    },
  });

  return (
    <section aria-label="预算设置">
      <Card>
        <CardHeader>
          <CardTitle>预算</CardTitle>
          <CardDescription>
            按月预算；达到 80%/100% 触发预警（仅提醒，不拦截调用）。runway 用于提醒余额还能撑几天。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {query.data?.length ? (
            <ul className="flex flex-col gap-2">
              {query.data.map((b) => (
                <li
                  key={b.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 text-sm"
                >
                  <span>
                    {formatMoney(b.amount, b.currency)} / 月 · 预警 {b.warnPct}% · 超支{" "}
                    {b.criticalPct}%
                    {b.runwayAlertDays != null
                      ? ` · runway<${b.runwayAlertDays}天`
                      : ""}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="停用预算"
                    onClick={() => delMut.mutate(b.id)}
                    disabled={delMut.isPending}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">尚未设置预算。</p>
          )}

          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              createMut.mutate();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="budget-amount">月预算金额</Label>
                <Input
                  id="budget-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="budget-currency">币种</Label>
                <Input
                  id="budget-currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  maxLength={3}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="budget-warn">预警 %</Label>
                <Input
                  id="budget-warn"
                  type="number"
                  min={0}
                  max={99}
                  value={warnPct}
                  onChange={(e) => setWarnPct(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="budget-crit">超支 %</Label>
                <Input
                  id="budget-crit"
                  type="number"
                  min={1}
                  max={200}
                  value={criticalPct}
                  onChange={(e) => setCriticalPct(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="budget-runway">runway 告警天数（可空）</Label>
                <Input
                  id="budget-runway"
                  type="number"
                  min={0}
                  value={runwayDays}
                  onChange={(e) => setRunwayDays(e.target.value)}
                />
              </div>
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={createMut.isPending} className="w-fit">
              {createMut.isPending ? "保存中…" : "添加月预算"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}
