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
import { ApiError, createKey } from "@/lib/api-client";

/** 前端预校验格式（AC1-2）：sk- 开头 + 至少 8 位字母/数字/-/_，非法即时拦截 */
const API_KEY_RE = /^sk-[A-Za-z0-9_-]{8,}$/;

/** 添加 API Key 表单：label 可选；提交即实测校验（后端），失败提示原因。 */
export function KeyAddForm() {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: createKey,
    onSuccess: (res) => {
      setError(null);
      setSuccess(`已添加并校验通过：${res.key.label || `sk-…${res.key.last4}`}`);
      setLabel("");
      setApiKey("");
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err) => {
      setSuccess(null);
      setError(
        err instanceof ApiError
          ? err.message
          : "添加失败，请稍后重试"
      );
    },
  });

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const trimmed = apiKey.trim();
    if (!API_KEY_RE.test(trimmed)) {
      // AC1-2：非法格式即时拦截，不发起请求
      setError("Key 格式不正确：应以 sk- 开头，后接至少 8 位字母 / 数字 / - / _");
      return;
    }
    mutation.mutate({ apiKey: trimmed, label: label.trim() || undefined });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>添加 API Key</CardTitle>
        <CardDescription>
          粘贴 DeepSeek 平台创建的 API Key。保存前会调用官方余额接口实测校验（通过后生成首个余额快照）。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="key-label">备注名（可选）</Label>
            <Input
              id="key-label"
              placeholder="例如：测试环境 / 正式服务"
              value={label}
              maxLength={50}
              autoComplete="off"
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="key-api-key">API Key</Label>
            <Input
              id="key-api-key"
              type="password"
              placeholder="sk-…"
              value={apiKey}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error !== null || undefined}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Key 仅用于实测校验并加密入库，前端不保存；列表只显示末 4 位掩码。
            </p>
          </div>
          {error ? (
            <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
              <CircleAlert aria-hidden className="size-4 shrink-0" />
              {error}
            </p>
          ) : null}
          {success ? (
            <p role="status" className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-500">
              <CircleCheck aria-hidden className="size-4 shrink-0" />
              {success}
            </p>
          ) : null}
          <Button type="submit" disabled={mutation.isPending} className="w-fit">
            {mutation.isPending ? <Loader2 aria-hidden className="animate-spin" /> : <Plus aria-hidden />}
            {mutation.isPending ? "校验中…" : "添加 Key"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
