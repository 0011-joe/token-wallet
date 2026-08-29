"use client";

import { KeyRound } from "lucide-react";

import type { ApiKeySummary } from "@/lib/api-types";

interface KeySwitcherProps {
  keys: ApiKeySummary[];
  /** 当前选中的 Key id（来自 /dashboard?keyId=）；非仪表盘页面为 null */
  selectedKeyId: string | null;
  onSelect: (id: string) => void;
}

/** Key 切换下拉（顶栏）：选择后跳转 /dashboard?keyId=xxx。 */
export function KeySwitcher({ keys, selectedKeyId, onSelect }: KeySwitcherProps) {
  return (
    <label className="flex min-w-0 items-center gap-1.5">
      <span className="sr-only">切换 Key</span>
      <KeyRound aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <select
        value={selectedKeyId ?? ""}
        onChange={(e) => {
          if (e.target.value) onSelect(e.target.value);
        }}
        disabled={keys.length === 0}
        aria-label="切换 Key"
        className="h-8 w-fit min-w-0 max-w-44 cursor-pointer rounded-lg border border-input bg-transparent px-2 pr-6 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50 sm:max-w-56"
      >
        {keys.length === 0 ? (
          <option value="">暂无 Key</option>
        ) : (
          <>
            <option value="" disabled>
              选择 Key
            </option>
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label || `sk-…${k.last4}`} · {k.isActive ? "启用中" : "已停用"}
              </option>
            ))}
          </>
        )}
      </select>
    </label>
  );
}
