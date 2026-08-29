"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Power, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { ApiKeySummary } from "@/lib/api-types";
import { deleteKey, updateKey } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** lastStatus 的用户可读状态标签（状态不只靠颜色，配文字） */
function statusInfo(lastStatus: string | null, failCount: number): {
  text: string;
  className: string;
} | null {
  if (lastStatus === null) return null;
  switch (lastStatus) {
    case "OK":
      return { text: "正常", className: "text-emerald-700 dark:text-emerald-500" };
    case "INVALID":
      return { text: failCount > 0 ? `Key 无效（连续失败 ${failCount} 次）` : "Key 无效", className: "text-destructive" };
    case "RATE_LIMITED":
      return { text: failCount > 0 ? `拉取限流（连续失败 ${failCount} 次）` : "拉取限流", className: "text-amber-700 dark:text-amber-500" };
    case "ERROR":
      return { text: failCount > 0 ? `拉取失败（连续失败 ${failCount} 次）` : "拉取失败", className: "text-destructive" };
    default:
      return { text: lastStatus, className: "text-muted-foreground" };
  }
}

/** Key 列表：last4 掩码展示、启停开关（PATCH isActive）、删除（confirm 二次确认）。 */
export function KeyList({ keys }: { keys: ApiKeySummary[] }) {
  const queryClient = useQueryClient();

  const toggle = useMutation({
    mutationFn: (vars: { id: string; isActive: boolean }) =>
      updateKey({ id: vars.id, isActive: vars.isActive }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const remove = useMutation({
    mutationFn: deleteKey,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  function handleDelete(item: ApiKeySummary) {
    const name = item.label || `sk-…${item.last4}`;
    const ok = window.confirm(
      `确认删除 Key「${name}」？其余额快照历史将一并删除，此操作不可恢复。`
    );
    if (ok) remove.mutate(item.id);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>已绑定 Key</CardTitle>
        <CardDescription>
          共 {keys.length} 个 · 删除后快照历史一并清除（不可恢复）
        </CardDescription>
      </CardHeader>
      <CardContent>
        {keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            还没有 Key，请先在上方添加。
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {keys.map((item) => {
              const status = statusInfo(item.lastStatus, item.failCount);
              return (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {item.label || "未命名 Key"}
                      {!item.isActive ? (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          已停用
                        </span>
                      ) : null}
                      {status ? (
                        <span className={cn("text-xs", status.className)}>
                          {status.text}
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 font-mono text-sm text-muted-foreground">
                      sk-••••{item.last4}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      添加于 {formatDateTime(item.createdAt)}
                      {item.failCount > 0
                        ? ` · 最近拉取连续失败 ${item.failCount} 次`
                        : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{item.isActive ? "启用" : "停用"}</span>
                      <Switch
                        checked={item.isActive}
                        disabled={toggle.isPending}
                        onCheckedChange={(checked) =>
                          toggle.mutate({ id: item.id, isActive: checked })
                        }
                        aria-label={`${item.isActive ? "停用" : "启用"} ${item.label || item.last4}`}
                      />
                    </label>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`删除 ${item.label || `sk-…${item.last4}`}`}
                      title="删除 Key"
                      disabled={remove.isPending}
                      onClick={() => handleDelete(item)}
                    >
                      {remove.isPending ? (
                        <Power aria-hidden className="animate-pulse text-destructive" />
                      ) : (
                        <Trash2 aria-hidden className="text-destructive" />
                      )}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {remove.isError ? (
          <p role="alert" className="mt-3 flex items-center gap-1.5 text-sm text-destructive">
            <CircleAlert aria-hidden className="size-4 shrink-0" />
            删除失败：{remove.error instanceof Error ? remove.error.message : "未知错误"}
          </p>
        ) : null}
        {toggle.isError ? (
          <p role="alert" className="mt-3 flex items-center gap-1.5 text-sm text-destructive">
            <CircleAlert aria-hidden className="size-4 shrink-0" />
            启停失败：{toggle.error instanceof Error ? toggle.error.message : "未知错误"}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
