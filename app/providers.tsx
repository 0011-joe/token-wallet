"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * 客户端 Provider：TanStack Query。
 * 挂在 app/(app) 布局内（仅包裹需登录的页面）。
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // 仪表盘数据 30s 内视为新鲜，避免 Key 切换 / 页面往返的重复请求
            staleTime: 30_000,
            retry: 1,
          },
        },
      })
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
