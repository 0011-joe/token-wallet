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
import type { ModelsResponse, ModelUsageRow, ProviderId, UsageType } from "@/lib/api-types";
import { fetchUsageModels } from "@/lib/api-client";
import { currentMonthUtc } from "@/lib/format";
import { formatAmount, formatMoney, formatNumber } from "@/lib/money";
import { cn } from "@/lib/utils";

import { UsageUpload } from "./usage-upload";
import { UsagePullButton } from "./usage-pull-button";
import { SourceBadge } from "./source-badge";

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
 * - 平台切换：DeepSeek（官方 CSV 精确）/ Kimi·豆包（一键拉取估算）
 * - 未导入（models:[]）→ 引导 + 上传/拉取区，不影响主看板其余模块；
 * - 已导入 → 模型占比（进度条）+ 明细（byType 展开）；同月重传/拉取覆盖。
 */
const USAGE_PROVIDERS: Array<{ id: ProviderId; label: string }> = [
  { id: "deepseek", label: "DeepSeek" },
  { id: "kimi", label: "Kimi" },
  { id: "volcengine", label: "豆包" },
];

export function ModelUsage({
  provider: initialProvider = "deepseek",
  credentialId,
}: {
  provider?: ProviderId;
  /** 限定某把凭证做估算拉取（多 Key 同平台时避免混算） */
  credentialId?: string | null;
}) {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<ProviderId>(initialProvider);
  const [month, setMonth] = useState(currentMonthUtc());
  const maxMonth = currentMonthUtc();

  const query = useQuery({
    queryKey: ["usage", "models", provider, month],
    queryFn: () => fetchUsageModels(month, provider),
    retry: 0,
  });

  function invalidateModels() {
    void queryClient.invalidateQueries({ queryKey: ["usage", "models"] });
  }

  const isEstimateSource = provider !== "deepseek";

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex items-center gap-2">分模型 Token 用量</span>
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="tablist"
              aria-label="用量平台"
              className="inline-flex rounded-lg border border-border p-0.5"
            >
              {USAGE_PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  aria-selected={provider === p.id}
                  onClick={() => {
                    if (provider === p.id) return;
                    setProvider(p.id);
                  }}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    provider === p.id
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
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
          </div>
        </CardTitle>
        <CardDescription>
          {isEstimateSource
            ? "Kimi / 豆包：余额快照差值估算（非官方账单）；与上方消耗估算同口径"
            : "来自官方用量 CSV 的精确数据（与上方消耗估算口径不同）"}
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
          <GuideBlock
            onImported={invalidateModels}
            provider={provider}
            credentialId={credentialId}
          />
        ) : null}

        {query.data && query.data.models.length > 0 ? (
          <div className="flex flex-col gap-5">
            <ModelsBlock
              data={query.data}
              source={isEstimateSource ? "derived_estimate" : "csv_official"}
            />
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                重新导入同月 CSV 会覆盖更新（不翻倍）；一键拉取与 CSV 共用同月幂等，互相覆盖
                {isEstimateSource ? "。估算结果请以平台控制台账单为准" : ""}
              </p>
              <UsagePullButton
                provider={provider}
                credentialId={credentialId}
                onPulled={invalidateModels}
              />
              <UsageUpload onImported={invalidateModels} provider={provider} />
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** 未导入引导（AC4-4）：按平台给出 CSV / 一键拉取路径 */
function GuideBlock({
  onImported,
  provider,
  credentialId,
}: {
  onImported: () => void;
  provider: ProviderId;
  credentialId?: string | null;
}) {
  const isDeepseek = provider === "deepseek";
  const platformLabel = provider === "kimi" ? "Kimi" : provider === "volcengine" ? "豆包（火山引擎）" : "DeepSeek";

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-dashed border-border bg-muted/30 p-4">
        <p className="text-sm font-medium">
          {isDeepseek
            ? "查看分模型用量，请先导入官方用量 CSV，或使用一键拉取"
            : `查看 ${platformLabel} 用量，请使用一键拉取（余额差值估算）`}
        </p>
        {isDeepseek ? (
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
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            官方未开放模型 Key 用量明细 API，或本仓库未确认字段映射。
            一键拉取会基于余额快照差值给出
            <span className="mx-1 font-medium text-foreground">估算</span>
            消耗（非官方账单）。
            <br />
            需先绑定该平台凭证，并完成{" "}
            <span className="font-medium text-foreground">至少 2 次成功余额快照</span>
            （可到「凭证管理」点「立即刷新」，或等待每小时定时任务）。
          </p>
        )}
      </div>
      <UsagePullButton
        provider={provider}
        credentialId={credentialId}
        onPulled={onImported}
      />
      <UsageUpload onImported={onImported} provider={provider} />
    </div>
  );
}

/** 已导入：占比排行（进度条）+ 明细表格（byType 展开行） */
function ModelsBlock({
  data,
  source,
}: {
  data: ModelsResponse;
  source?: "csv_official" | "host_measured" | "derived_estimate";
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="font-medium">
          {data.month} 共 {data.models.length} 个模型
        </span>
        {source ? <SourceBadge source={source} /> : null}
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
