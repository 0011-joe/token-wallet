"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, createCredential } from "@/lib/api-client";
import { PROVIDER_META, PROVIDER_ORDER } from "@/lib/providers/meta";
import { formatMoney } from "@/lib/money";
import type { ProviderId } from "@/lib/api-types";

/** 前端预校验（AC1.2 后端兜底）：bearer=sk- 前缀；aksk=AKLT 前缀 */
const BEARER_RE = /^sk-[A-Za-z0-9_-]{8,}$/;
const VOLC_AK_RE = /^AKLT[A-Za-z0-9]{8,}$/;

/** 添加凭证表单（FR-1 / AC1.1-1.4）：选平台 → 按 kind 渲染字段 → 提交即实测 + 首余额。 */
export function CredAddForm() {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<ProviderId>("deepseek");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [ak, setAk] = useState("");
  const [sk, setSk] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const meta = PROVIDER_META[provider];
  const isAksk = meta.kind === "aksk";

  const mutation = useMutation({
    mutationFn: createCredential,
    onSuccess: (res) => {
      setError(null);
      const first = res.firstBalance.balances[0];
      const firstText = first
        ? `，当前可用 ${formatMoney(first.available, first.currency)}`
        : "";
      setSuccess(
        `已添加并校验通过：${res.credential.label}${firstText}`
      );
      setLabel("");
      setApiKey("");
      setAk("");
      setSk("");
      void queryClient.invalidateQueries({ queryKey: ["credentials"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err) => {
      setSuccess(null);
      setError(err instanceof ApiError ? err.message : "添加失败，请稍后重试");
    },
  });

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (isAksk) {
      const trimmedAk = ak.trim();
      const trimmedSk = sk.trim();
      if (!VOLC_AK_RE.test(trimmedAk)) {
        setError(
          "AccessKey ID 格式不正确：应以 AKLT 开头（费用中心只读 IAM 子用户，不是 ARK 推理 Key 或主账号）"
        );
        return;
      }
      if (trimmedSk === "") {
        setError("请填写 Secret AccessKey");
        return;
      }
      mutation.mutate({
        provider,
        kind: "aksk",
        label: label.trim() || undefined,
        secret: { ak: trimmedAk, sk: trimmedSk },
      });
      return;
    }

    const trimmed = apiKey.trim();
    if (!BEARER_RE.test(trimmed)) {
      setError("Key 格式不正确：应以 sk- 开头，后接至少 8 位字母 / 数字 / - / _");
      return;
    }
    mutation.mutate({
      provider,
      kind: "bearer",
      region: provider === "kimi" ? "cn" : undefined,
      label: label.trim() || undefined,
      secret: { key: trimmed },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>添加凭证</CardTitle>
        <CardDescription>
          先选平台，再按该平台的凭证形态填写。保存前会调用对应平台接口实测校验（通过后立即写入首份余额）。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="cred-provider">平台</Label>
            <select
              id="cred-provider"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as ProviderId);
                setError(null);
                setSuccess(null);
              }}
              className="h-9 w-full cursor-pointer rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {PROVIDER_ORDER.map((id) => (
                <option key={id} value={id}>
                  {PROVIDER_META[id].label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{meta.guide}</p>
            {provider === "kimi" ? (
              <p className="text-xs text-muted-foreground">
                站点固定为国内站（api.moonshot.cn，CNY）；国际站（api.moonshot.ai）v2.1 支持。
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="cred-label">备注名（可选）</Label>
            <Input
              id="cred-label"
              placeholder="例如：正式服务 / 备用账号"
              value={label}
              maxLength={50}
              autoComplete="off"
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          {isAksk ? (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="cred-ak">AccessKey ID</Label>
                <Input
                  id="cred-ak"
                  placeholder="AKLT…"
                  value={ak}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={error !== null || undefined}
                  onChange={(e) => setAk(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="cred-sk">Secret AccessKey</Label>
                <Input
                  id="cred-sk"
                  type="password"
                  placeholder="••••••••"
                  value={sk}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={error !== null || undefined}
                  onChange={(e) => setSk(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  AK/SK 与模型 Key 同等级加密落库，仅展示 AK 前缀与尾 4 位；Secret
                  永不回显。请确认使用「费用中心只读」子用户：主账号密钥权限过大，会被拒绝或带来风险。
                </p>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="cred-key">API Key</Label>
              <Input
                id="cred-key"
                type="password"
                placeholder="sk-…"
                value={apiKey}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={error !== null || undefined}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                凭证仅用于实测校验并加密入库，前端不保存；列表只显示末 4 位掩码。
              </p>
            </div>
          )}

          {error !== null ? (
            <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              {error}
            </p>
          ) : null}
          {success !== null ? (
            <p role="status" className="flex items-start gap-2 text-sm text-emerald-600 dark:text-emerald-400">
              <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
              {success}
            </p>
          ) : null}

          <Button type="submit" disabled={mutation.isPending} className="self-start">
            {mutation.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
            {mutation.isPending ? "校验中…" : "添加并校验"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
