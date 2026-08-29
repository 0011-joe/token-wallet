"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, RefreshCw } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { ModelsResponse, ModelUsageRow, UsageType } from "@/lib/api-types";
import { fetchUsageModels } from "@/lib/api-client";
import { currentMonthUtc, formatAmount, formatMoney, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

import { UsageUpload } from "./usage-upload";

/** type 的用户可读标签（取值全集见 lib/usage/csv-parse.ts） */
const TYPE_LABELS: Record<UsageType, string> = {
  input_cache_hit_tokens: "输入 Token（缓存命中）",
  input_cache_miss_tokens: "输入 Token（缓存未命中）",
  output_tokens: "输出 Token",
  request_count: "请求次数",
};

const OFFICIAL_USAGE_URL = "https://platform.deepseek.com/usage";

/**
 * 分模型 Token 用量区（FR-4 / AC4-4）：
 * - 未导入（models:[]）→ 三步导出引导 + 上传区，不影响主看板其余模块；
 * - 已导入 → 模型占比（进度条）+ 明细（byType 展开）；同月重传覆盖。
 */
export function ModelUsage() {
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(currentMonthUtc());
  const maxMonth = currentMonthUtc();

  const query = useQuery({
    queryKey: ["usage", "models", month],
    queryFn: () => fetchUsageModels(month),
    retry: 0,
  });

  function invalidateModels() {
    void queryClient.invalidateQueries({ queryKey: ["usage", "models"] });
  }

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex items-center gap-2">分模型 Token 用量</span>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="text-xs">查看月份</span>
            <input
              type="month"
              value={month}
              max={maxMonth}
              aria-label="选择查看月份"
              onChange={(e) => {
                if (e.target.value) setMonth(e.target.value);
              }}
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </label>
        </CardTitle>
        <CardDescription>
          来自官方用量 CSV 的精确数据（与上方消耗估算口径不同）
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {query.isLoading ? (
          <div
            role="status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <RefreshCw aria-hidden className="size-4 animate-spin" />
            加载中…
          </div>
        ) : null}

        {query.isError ? (
          <div className="flex flex-col items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
            <p role="alert" className="text-sm text-destructive">
              用量数据加载失败，请稍后重试。
            </p>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              <RefreshCw />
              重试
            </Button>
          </div>
        ) : null}

        {query.data && query.data.models.length === 0 ? (
          <GuideBlock onImported={invalidateModels} />
        ) : null}

        {query.data && query.data.models.length > 0 ? (
          <div className="flex flex-col gap-5">
            <ModelsBlock data={query.data} />
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                重新导入同月 CSV 会覆盖更新（不翻倍）
              </p>
              <UsageUpload onImported={invalidateModels} />
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** 未导入引导（AC4-4）：三步导出说明 + 官方链接 + 上传区 */
function GuideBlock({ onImported }: { onImported: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-dashed border-border bg-muted/30 p-4">
        <p className="text-sm font-medium">
          查看分模型用量，请先导入官方用量 CSV
        </p>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>
            登录
            <a
              href={OFFICIAL_USAGE_URL}
              target="_blank"
              rel="noreferrer"
              className="mx-1 text-primary underline underline-offset-4 hover:opacity-80"
            >
              DeepSeek 开放平台「用量信息」
            </a>
            页面
          </li>
          <li>选择月份并点击「导出」，下载并解压压缩包</li>
          <li>
            将其中{" "}
            <code className="rounded-md bg-muted px-1 py-0.5 font-mono text-xs">
              amount
            </code>{" "}
            文件的 CSV 拖入下方上传区（重复上传会覆盖当月数据）
          </li>
        </ol>
      </div>
      <UsageUpload onImported={onImported} />
    </div>
  );
}

/** 已导入：占比排行（进度条）+ 明细表格（byType 展开行） */
function ModelsBlock({ data }: { data: ModelsResponse }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="font-medium">
          {data.month} 共 {data.models.length} 个模型
        </span>
        <span className="text-muted-foreground">
          合计费用{" "}
          {data.currency
            ? formatMoney(data.totalCost, data.currency)
            : formatAmount(data.totalCost)}{" "}
          · 总 Token {formatNumber(data.totalTokens)}
        </span>
        <span className="text-xs text-muted-foreground">
          {data.currency
            ? `费用为官方单价 × 用量的数值，币种 ${data.currency}`
            : "（费用为官方单价 × 用量的数值，币种信息后端暂未接入）"}
        </span>
      </div>

      <div className="flex flex-col gap-3">
        {data.models.map((m) => (
          <ModelRow
            key={m.model}
            model={m}
            currency={data.currency}
            expanded={expanded === m.model}
            onToggle={() => setExpanded((cur) => (cur === m.model ? null : m.model))}
          />
        ))}
      </div>
    </div>
  );
}
function ModelRow({
  model,
  currency,
  expanded,
  onToggle,
}: {
  model: ModelUsageRow;
  /** 当月币种（cost 文件入库）；null=未接入币种 */
  currency: string | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`model-detail-${model.model}`}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ChevronDown
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-180"
            )}
          />
          <span className="min-w-0 truncate text-sm font-medium">
            {model.model}
          </span>
        </button>
        <span className="shrink-0 text-sm tabular-nums">
          {currency ? formatMoney(model.totalCost, currency) : formatAmount(model.totalCost)}
        </span>
        <span className="w-14 shrink-0 text-right text-sm text-muted-foreground tabular-nums">
          {model.sharePct.toFixed(2)}%
        </span>
      </div>
      <div
        role="img"
        aria-label={`${model.model} 占当月费用 ${model.sharePct.toFixed(2)}%`}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-(--chart-2)"
          style={{ width: `${Math.min(model.sharePct, 100)}%` }}
        />
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Token / 请求 {formatNumber(model.totalTokens)}
      </p>
      {expanded ? (
        <div id={`model-detail-${model.model}`} className="mt-3 overflow-x-auto">
          {model.byType.length === 0 ? (
            <p className="text-xs text-muted-foreground">无明细数据</p>
          ) : (
            <table className="w-full min-w-72 text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-1.5 pr-2 font-normal">类型</th>
                  <th className="py-1.5 pr-2 text-right font-normal">数量</th>
                  <th className="py-1.5 text-right font-normal">费用</th>
                </tr>
              </thead>
              <tbody>
                {model.byType.map((t) => (
                  <tr
                    key={t.type}
                    className="border-b border-border/50 last:border-0"
                  >
                    <td className="py-1.5 pr-2">{TYPE_LABELS[t.type] ?? t.type}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {formatNumber(t.amount)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {currency ? formatMoney(t.cost, currency) : formatAmount(t.cost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </div>
  );
}
