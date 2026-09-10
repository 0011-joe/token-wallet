/**
 * Provider 前端元数据（纯常量，前后端共用；不含任何密钥逻辑）。
 * 用于凭证表单/列表/看板的展示与引导文案。
 */
import type { CredentialKind, ProviderId } from "./types";

export interface ProviderMeta {
  id: ProviderId;
  /** 展示名 */
  label: string;
  kind: CredentialKind;
  /** 凭证字段说明 */
  credentialHint: string;
  /** 获取指引（录入页展示） */
  guide: string;
  /** 是否已实现（v2.0 三家均实现；预留未注册平台时置 false） */
  implemented: boolean;
}

export const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    kind: "bearer",
    credentialHint: "API Key（sk- 开头）",
    guide: "在 platform.deepseek.com → API Keys 创建。",
    implemented: true,
  },
  kimi: {
    id: "kimi",
    label: "Kimi（国内站）",
    kind: "bearer",
    credentialHint: "API Key（sk- 开头，国内站）",
    guide:
      "在 platform.moonshot.cn → API Key 管理创建。国内站与国际站 Key 不通用；国际站 v2.1 支持。",
    implemented: true,
  },
  volcengine: {
    id: "volcengine",
    label: "豆包（火山引擎）",
    kind: "aksk",
    credentialHint: "AccessKey ID（AKLT 开头）+ Secret AccessKey",
    guide:
      "必须使用「费用中心只读」IAM 子用户的 AK/SK（推荐绑定系统策略 BillingCenterReadOnlyAccess）；" +
      "禁止使用主账号密钥或 ARK 推理 Key。查余额走费用中心 QueryBalanceAcct，不属于推理 API。",
    implemented: true,
  },
};

export const PROVIDER_ORDER: ProviderId[] = ["deepseek", "kimi", "volcengine"];

export function providerLabel(id: ProviderId): string {
  return PROVIDER_META[id]?.label ?? id;
}
