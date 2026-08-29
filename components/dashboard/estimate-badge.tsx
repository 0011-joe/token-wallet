"use client";

import { useState } from "react";
import { Info } from "lucide-react";

import { EstimateHelpDialog } from "./estimate-help-dialog";

/**
 * 「估算」标识（AC3-4）：标注所有快照差值估算的数字；
 * 点击打开口径说明弹层。
 */
export function EstimateBadge() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="查看估算口径说明"
        title="估算口径说明"
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed border-border bg-muted/50 px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        估算
        <Info aria-hidden className="size-3" />
      </button>
      <EstimateHelpDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
