"use client";

import { useQuery } from "@tanstack/react-query";
import { CircleAlert, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CredAddForm } from "@/components/credentials/cred-add-form";
import { CredList } from "@/components/credentials/cred-list";
import { fetchCredentials } from "@/lib/api-client";

/** 凭证管理页（FR-1）：多平台列表 + 添加表单（提交即测）+ 启停/刷新/删除。 */
export default function CredentialsPage() {
  const query = useQuery({
    queryKey: ["credentials"],
    queryFn: fetchCredentials,
    retry: 0,
  });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">凭证管理</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          DeepSeek / Kimi / 豆包 三平台凭证统一管理（添加时即实测校验，密文落库，仅展示脱敏标识）
        </p>
      </div>

      <CredAddForm />

      {query.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          加载中…
        </p>
      ) : null}

      {query.isError ? (
        <Card>
          <CardContent className="flex items-center gap-3 py-8">
            <CircleAlert aria-hidden className="size-5 text-destructive" />
            <p className="text-sm text-destructive">凭证列表加载失败。</p>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              <RefreshCw />
              重试
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {query.data ? <CredList credentials={query.data.credentials} /> : null}
    </div>
  );
}
