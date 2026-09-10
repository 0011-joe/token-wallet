/**
 * 前端 API 客户端：统一 fetch 封装（v2：凭证/多 Provider；金额走 Decimal 字符串）。
 * - 所有失败统一抛 ApiError（携带 HTTP 状态码与后端 error 文案）；
 * - URL 一律相对路径（同源），鉴权走 next-auth 会话 cookie。
 */
import type {
  AlertsResponse,
  AlertSettings,
  CreateCredentialResponse,
  CredentialsResponse,
  DashboardData,
  ImportUsageResponse,
  ModelsResponse,
  ProviderId,
  RefreshResponse,
} from "./api-types";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function readError(res: Response, fallback: string): Promise<ApiError> {
  let message = fallback;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (body && typeof body.error === "string" && body.error !== "") {
      message = body.error;
    }
  } catch {
    // 响应无 JSON 体，使用 fallback
  }
  return new ApiError(res.status, message);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw await readError(res, `请求失败（HTTP ${res.status}）`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── 凭证（FR-1） ──

export function fetchCredentials(): Promise<CredentialsResponse> {
  return request<CredentialsResponse>("/api/credentials");
}

export function createCredential(body: {
  provider: ProviderId;
  kind: "bearer" | "aksk";
  region?: string | null;
  label?: string;
  /** bearer: { key }；aksk: { ak, sk } */
  secret: { key?: string; ak?: string; sk?: string };
}): Promise<CreateCredentialResponse> {
  return request<CreateCredentialResponse>("/api/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function updateCredential(
  id: string,
  body: { isActive?: boolean; label?: string }
): Promise<{ credential: CredentialsResponse["credentials"][number] }> {
  return request(`/api/credentials/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteCredential(id: string): Promise<void> {
  return request<void>(`/api/credentials/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function refreshCredential(id: string): Promise<RefreshResponse> {
  return request<RefreshResponse>(
    `/api/credentials/${encodeURIComponent(id)}/refresh`,
    { method: "POST" }
  );
}

// ── 看板（FR-3） ──

export function fetchOverview(): Promise<import("./api-types").DashboardOverview> {
  return request("/api/dashboard");
}

export function fetchDashboard(
  credentialId: string,
  range: 7 | 30 | 90
): Promise<DashboardData> {
  return request<DashboardData>(
    `/api/dashboard?credentialId=${encodeURIComponent(credentialId)}&range=${range}`
  );
}

// ── 用量（FR-4） ──

export function fetchUsageModels(
  month: string,
  provider: ProviderId
): Promise<ModelsResponse> {
  return request<ModelsResponse>(
    `/api/usage/models?month=${encodeURIComponent(month)}&provider=${encodeURIComponent(provider)}`
  );
}

/** multipart/form-data 上传官方 amount CSV；Content-Type 由浏览器自动带 boundary */
export function importUsageCsv(
  provider: ProviderId,
  file: File,
  costFile?: File | null
): Promise<ImportUsageResponse> {
  const form = new FormData();
  form.append("provider", provider);
  form.append("file", file);
  // 可选：官方 cost CSV（含币种与当月总费用），后端校验月份一致后入库
  if (costFile) form.append("costFile", costFile);
  return request<ImportUsageResponse>("/api/usage/import", {
    method: "POST",
    body: form,
  });
}

// ── 告警（FR-5） ──

export function fetchAlerts(): Promise<AlertsResponse> {
  return request<AlertsResponse>("/api/alerts");
}

export function updateAlerts(
  body: Partial<AlertSettings>
): Promise<{ settings: AlertSettings }> {
  return request("/api/alerts", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── 账户（FR-6） ──

export function deleteAccount(): Promise<void> {
  return request<void>("/api/account", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  });
}
