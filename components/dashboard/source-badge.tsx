/**
 * 用量精度标签（红线 11）。csv_official / host_measured / derived_estimate。
 */
import { cn } from "@/lib/utils";

export type UsageSourceLabel = "csv_official" | "host_measured" | "derived_estimate";

const META: Record<
  UsageSourceLabel,
  { label: string; className: string; title: string }
> = {
  csv_official: {
    label: "官方 CSV",
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    title: "来自平台官方导出的用量文件",
  },
  host_measured: {
    label: "本机实测",
    className: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
    title: "由本地采集器按调用 usage 聚合上报",
  },
  derived_estimate: {
    label: "估算",
    className: "bg-amber-500/10 text-amber-800 dark:text-amber-300",
    title: "余额差值等估算口径，非官方账单",
  },
};

export function SourceBadge({
  source,
  className,
}: {
  source: UsageSourceLabel | string;
  className?: string;
}) {
  const meta = META[source as UsageSourceLabel];
  if (!meta) return null;
  return (
    <span
      title={meta.title}
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        meta.className,
        className
      )}
    >
      {meta.label}
    </span>
  );
}
