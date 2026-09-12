"use client";

import { useState } from "react";
import { RefreshCw, X } from "lucide-react";

import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const STORAGE_PREFIX = "dashboard-stale-banner-dismissed";

function isDismissed(signature: string): boolean {
  try {
    return sessionStorage.getItem(`${STORAGE_PREFIX}:${signature}`) === "1";
  } catch {
    return false;
  }
}

/**
 * 数据新鲜度横幅（仪表盘顶部）：
 * - 任一凭证 stale 或拉取失败时显示琥珀色警告；
 * - 可关闭：关闭态绑定 overview.generatedAt；刷新后新签名会重新显示。
 * 父组件请传入 key={signature}，签名变化时整组件重挂载，避免 effect 同步 setState。
 */
export function StaleBanner({
  hasIssue,
  latestSuccessAt,
  signature,
  className,
}: {
  hasIssue: boolean;
  latestSuccessAt: string | null;
  /** 数据签名（如 overview.generatedAt） */
  signature: string;
  className?: string;
}) {
  const [dismissed, setDismissed] = useState(() => isDismissed(signature));

  if (!hasIssue || dismissed) return null;

  function dismiss() {
    try {
      sessionStorage.setItem(`${STORAGE_PREFIX}:${signature}`, "1");
    } catch {
      // 隐私模式写入失败时仅本次关闭
    }
    setDismissed(true);
  }

  return (
    <div
      role="status"
      data-testid="stale-banner"
      className={cn(
        "flex items-start gap-3 rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-amber-900 dark:text-amber-100",
        className
      )}
    >
      <RefreshCw
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-medium">
          部分平台余额数据已过期或拉取失败，数字可能不是最新
        </p>
        {latestSuccessAt ? (
          <p className="text-xs text-amber-800/80 dark:text-amber-100/70">
            最近成功时间：{formatDateTime(latestSuccessAt)}（北京时间）
          </p>
        ) : (
          <p className="text-xs text-amber-800/80 dark:text-amber-100/70">
            暂无成功快照记录，可到凭证页手动「立即刷新」。
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="关闭数据过期提示"
        className="shrink-0 rounded-md p-1 text-amber-700/80 transition-colors hover:bg-amber-500/20 hover:text-amber-900 dark:text-amber-200/80 dark:hover:text-amber-50"
      >
        <X aria-hidden className="size-4" />
      </button>
    </div>
  );
}
