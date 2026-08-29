import type { ReactNode } from "react";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";

import { authOptions } from "@/auth";
import { Providers } from "@/app/providers";
import { TopBar } from "@/components/layout/topbar";

/**
 * (app) 路由组布局：登录态校验 + 客户端 Providers + 顶栏。
 * 未登录直接跳 /login（服务端校验，避免客户端渲染闪烁）。
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");

  return (
    <Providers>
      <div className="flex min-h-full flex-1 flex-col">
        {/* TopBar 内部使用 useSearchParams（需要 Suspense 边界） */}
        <Suspense fallback={<div className="h-14 border-b border-border" />}>
          <TopBar />
        </Suspense>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
          {children}
        </main>
      </div>
    </Providers>
  );
}
