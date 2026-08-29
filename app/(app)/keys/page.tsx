"use client";

import { useQuery } from "@tanstack/react-query";
import { CircleAlert, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { KeyAddForm } from "@/components/keys/key-add-form";
import { KeyList } from "@/components/keys/key-list";
import { fetchKeys } from "@/lib/api-client";

/** Key 管理页（T2.2/T2.3 + AC1-2/4）：列表 + 添加表单 + 启停删除。 */
export default function KeysPage() {
  const query = useQuery({
    queryKey: ["keys"],
    queryFn: fetchKeys,
    retry: 0,
  });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Key 管理</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          绑定、启停与删除 DeepSeek API Key（添加时即实测校验）
        </p>
      </div>

      <KeyAddForm />

      {query.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          加载中…
        </p>
      ) : null}

      {query.isError ? (
        <Card>
          <CardContent className="flex items-center gap-3 py-8">
            <CircleAlert aria-hidden className="size-5 text-destructive" />
            <p className="text-sm text-destructive">Key 列表加载失败。</p>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              <RefreshCw />
              重试
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {query.data ? <KeyList keys={query.data.keys} /> : null}
    </div>
  );
}
