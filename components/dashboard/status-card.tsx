"use client";

import { CircleAlert, CircleCheck } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ApiKeySummary, BalanceInfo } from "@/lib/api-types";
import { cn } from "@/lib/utils";

/** lastStatus 的用户可读文案（仅作展示用键名） */
const STATUS_TEXT: Record<string, string> = {
  OK: "正常",
  INVALID: "Key 无效",
  RATE_LIMITED: "接口限流",
  ERROR: "接口错误",
};

/**
 * 账户状态卡：可调用 / 余额不足（AC2-2 状态不依赖颜色——图标 + 文字）。
 * 附 Key 拉取异常（lastStatus / failCount）与停用提示。
 */
export function StatusCard({
  apiKey,
  balance,
}: {
  apiKey: ApiKeySummary;
  balance: BalanceInfo | null;
}) {
  const inactive = !apiKey.isActive;
  const unavailable = balance !== null && !balance.isAvailable;

  let label: string;
  let tone: "ok" | "bad" | "muted";
  if (inactive) {
    label = "Key 已停用";
    tone = "muted";
  } else if (unavailable) {
    label = "余额不足，无法调用";
    tone = "bad";
  } else if (balance === null) {
    label = "暂无数据";
    tone = "muted";
  } else {
    label = "可调用";
    tone = "ok";
  }

  const keyLabel = apiKey.label || `sk-…${apiKey.last4}`;

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="text-sm font-normal text-muted-foreground">
          账户状态
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2">
        <div
          className={cn(
            "flex items-center gap-2 text-lg font-medium",
            tone === "bad" && "text-destructive"
          )}
        >
          {tone === "ok" ? (
            <CircleCheck
              aria-hidden
              className="size-5 shrink-0 text-emerald-600 dark:text-emerald-500"
            />
          ) : null}
          {tone === "bad" ? (
            <CircleAlert aria-hidden className="size-5 shrink-0" />
          ) : null}
          <span>{label}</span>
        </div>
        {tone === "ok" ? (
          <p className="text-xs text-muted-foreground">
            官方接口返回可调用，余额充足
          </p>
        ) : null}
        {tone === "muted" && inactive ? (
          <p className="text-xs text-muted-foreground">
            已停止快照拉取，可到 Key 管理页重新启用
          </p>
        ) : null}
        {!inactive && apiKey.lastStatus && apiKey.failCount > 0 ? (
          <p className="text-xs text-amber-700 dark:text-amber-500">
            余额拉取异常：{STATUS_TEXT[apiKey.lastStatus] ?? apiKey.lastStatus} ·
            连续失败 {apiKey.failCount} 次
          </p>
        ) : null}
        <p className="mt-auto text-xs text-muted-foreground">Key：{keyLabel}</p>
      </CardContent>
    </Card>
  );
}
