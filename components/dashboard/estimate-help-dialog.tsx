"use client";

import { X } from "lucide-react";

import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogPortal,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * 「估算」口径说明弹层（AC3-4）：快照差值估算口径 + 免责说明。
 * 由 EstimateBadge 触发打开。
 */
export function EstimateHelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup>
          <div className="flex items-start justify-between gap-4">
            <DialogTitle>「估算」口径说明</DialogTitle>
            <DialogClose aria-label="关闭">
              <X />
            </DialogClose>
          </div>
          <div className="mt-3 flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">
            <p>
              这些数字由「余额快照差值」推算，属于估算，不是官方账单。
            </p>
            <p>
              系统默认每 1 小时调用一次官方余额接口并存快照；相邻两期快照的消耗为：
              <span className="mx-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs whitespace-nowrap">
                Δcost = 上一期总余额 - 本期总余额（同币种，取正）
              </span>
              ，Δcost &gt; 0 才记为消耗（充值 / 赠金到账会使总余额上升，不会被误计为消耗）。
            </p>
            <p>
              「今日」为当日首个快照至最新快照的累计消耗，「本月」为当月 1
              日起累计；快照不足 2 个的时段没有基准，显示为 0。
            </p>
            <p>
              拉取失败造成的快照缺口期间，消耗可能被低估；趋势图中以断点 / 浅色样式标出缺口日。
            </p>
            <p>
              需要精确的分模型费用，请在下方「分模型 Token 用量」导入官方导出的用量 CSV。
            </p>
          </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
