"use client";

/**
 * 手动刷新余额：按凭证 id 串行调官方接口，再失效看板查询。
 * 供余额主卡 / 平台卡 / 币种合计卡共用。
 */
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { refreshCredential } from "@/lib/api-client";

export interface RefreshBalancesResult {
  ok: number;
  failed: number;
  /** 第一条失败原因（脱敏文案） */
  firstError: string | null;
}

export function useRefreshBalances() {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const refreshBalances = useCallback(
    async (credentialIds: string[]): Promise<RefreshBalancesResult> => {
      if (credentialIds.length === 0) {
        return { ok: 0, failed: 0, firstError: null };
      }
      setRefreshing(true);
      let ok = 0;
      let failed = 0;
      let firstError: string | null = null;
      try {
        // 串行：避免同平台限频
        for (const id of credentialIds) {
          try {
            await refreshCredential(id);
            ok += 1;
          } catch (err) {
            failed += 1;
            if (firstError === null) {
              firstError =
                err instanceof Error ? err.message : "刷新失败，请稍后重试";
            }
          }
        }
        await queryClient.invalidateQueries({ queryKey: ["credentials"] });
        await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
        return { ok, failed, firstError };
      } finally {
        setRefreshing(false);
      }
    },
    [queryClient]
  );

  return { refreshing, refreshBalances };
}
