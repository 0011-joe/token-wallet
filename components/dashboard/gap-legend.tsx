"use client";

/**
 * 趋势图图例说明（AC3-3）：正常日与快照缺口日的图例，保证缺口
 * 标记不依赖颜色也能理解（配文字说明）。
 */
export function GapLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-0.5 w-4 rounded bg-(--chart-2)" />
        正常日（快照差值估算）
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="inline-block size-2.5 rounded-full bg-amber-500" />
        快照缺口日（区间不完整，数值可能偏低）
      </span>
    </div>
  );
}
