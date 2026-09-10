"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ApiError, deleteCredential, refreshCredential, updateCredential } from "@/lib/api-client";
import { PROVIDER_META } from "@/lib/providers/meta";
import type { CredentialSummary } from "@/lib/api-types";

const STATUS_TEXT: Record<string, string> = {
  OK: "正常",
  INVALID: "凭证无效",
  FORBIDDEN_SCOPE: "权限不足",
  RATE_LIMITED: "限流中",
  ERROR: "拉取失败",
};

const STATUS_DOT: Record<string, string> = {
  OK: "bg-emerald-500",
  INVALID: "bg-destructive",
  FORBIDDEN_SCOPE: "bg-destructive",
  RATE_LIMITED: "bg-amber-500",
  ERROR: "bg-amber-500",
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 凭证列表（FR-1 / AC1.4/1.5）：脱敏展示、启停、立即刷新、删除（二次确认）。 */
export function CredList({ credentials }: { credentials: CredentialSummary[] }) {
  const queryClient = useQueryClient();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["credentials"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      updateCredential(id, { isActive }),
    onSuccess: invalidate,
    onError: (err) => setActionError(err instanceof ApiError ? err.message : "操作失败"),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteCredential,
    onSuccess: () => {
      setConfirmingId(null);
      invalidate();
    },
    onError: (err) => setActionError(err instanceof ApiError ? err.message : "删除失败"),
  });

  const refreshMutation = useMutation({
    mutationFn: refreshCredential,
    onSuccess: invalidate,
    onError: (err) => setActionError(err instanceof ApiError ? err.message : "刷新失败"),
  });

  if (credentials.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          还没有凭证。添加一个平台凭证，即可开始自动余额监控。
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {actionError !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}
      {credentials.map((c) => {
        const meta = PROVIDER_META[c.provider];
        const status = c.lastStatus ?? "—";
        return (
          <Card key={c.id}>
            <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium">
                    {meta?.label ?? c.provider}
                  </span>
                  <span className="truncate text-sm font-medium">{c.label}</span>
                  {!c.isActive ? (
                    <span className="text-xs text-muted-foreground">（已停用）</span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-mono">
                    {c.kind === "bearer" ? `sk-••••${c.hint}` : c.hint}
                  </span>
                  <span className="flex items-center gap-1">
                    <span
                      aria-hidden
                      className={`inline-block size-1.5 rounded-full ${STATUS_DOT[status] ?? "bg-muted-foreground"}`}
                    />
                    {STATUS_TEXT[status] ?? status}
                    {c.failCount > 0 ? `（连续失败 ${c.failCount} 次）` : ""}
                  </span>
                  <span>最近成功：{fmtTime(c.lastSuccessAt)}</span>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!c.isActive || refreshMutation.isPending}
                  onClick={() => {
                    setActionError(null);
                    refreshMutation.mutate(c.id);
                  }}
                >
                  {refreshMutation.isPending && refreshMutation.variables === c.id ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <RefreshCw />
                  )}
                  立即刷新
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={toggleMutation.isPending}
                  onClick={() => {
                    setActionError(null);
                    toggleMutation.mutate({ id: c.id, isActive: !c.isActive });
                  }}
                >
                  {c.isActive ? "停用" : "启用"}
                </Button>
                {confirmingId === c.id ? (
                  <>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={deleteMutation.isPending}
                      onClick={() => {
                        setActionError(null);
                        deleteMutation.mutate(c.id);
                      }}
                    >
                      确认删除
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmingId(null)}>
                      取消
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`删除 ${c.label || c.hint}`}
                    title="删除（含其全部快照）"
                    onClick={() => setConfirmingId(c.id)}
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
      <p className="text-xs text-muted-foreground">
        删除凭证会同时删除其全部历史快照（级联），不影响其他平台。
      </p>
    </div>
  );
}
