"use client";

import { KeyRound } from "lucide-react";

import { PROVIDER_META } from "@/lib/providers/meta";
import type { CredentialSummary } from "@/lib/api-types";

interface CredSwitcherProps {
  credentials: CredentialSummary[];
  /** 当前选中的凭证 id（来自 /dashboard?credentialId=）；非仪表盘页面为 null */
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** 凭证切换下拉（顶栏）：选择后跳转 /dashboard?credentialId=xxx。 */
export function CredSwitcher({ credentials, selectedId, onSelect }: CredSwitcherProps) {
  return (
    <label className="flex min-w-0 items-center gap-1.5">
      <span className="sr-only">切换凭证</span>
      <KeyRound aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <select
        value={selectedId ?? ""}
        onChange={(e) => {
          if (e.target.value) onSelect(e.target.value);
        }}
        disabled={credentials.length === 0}
        aria-label="切换凭证"
        className="h-8 w-fit min-w-0 max-w-52 cursor-pointer rounded-lg border border-input bg-transparent px-2 pr-6 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50 sm:max-w-64"
      >
        {credentials.length === 0 ? (
          <option value="">暂无凭证</option>
        ) : (
          <>
            <option value="">总览（全部凭证）</option>
            <option value="" disabled>
              选择凭证
            </option>
            {credentials.map((c) => (
              <option key={c.id} value={c.id}>
                {(PROVIDER_META[c.provider]?.label ?? c.provider)} ·{" "}
                {c.label || c.hint} · {c.isActive ? "启用中" : "已停用"}
              </option>
            ))}
          </>
        )}
      </select>
    </label>
  );
}
