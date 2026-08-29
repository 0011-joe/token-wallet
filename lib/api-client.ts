/**
 * 前端 API 客户端：统一 fetch 封装。
 * - 所有失败统一抛 ApiError（携带 HTTP 状态码与后端 error 文案）；
 * - URL 一律相对路径（同源），鉴权走 next-auth 会话 cookie。
 */
import type {
  ApiKeySummary,
  DashboardData,
  ImportUsageResponse,
  KeysResponse,
  ModelsResponse,
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

export function fetchKeys(): Promise<KeysResponse> {
  return request<KeysResponse>("/api/keys");
}

export function fetchDashboard(
  keyId: string,
  range: 7 | 30 | 90
): Promise<DashboardData> {
  return request<DashboardData>(
    `/api/dashboard?keyId=${encodeURIComponent(keyId)}&range=${range}`
  );
}

export function createKey(body: {
  label?: string;
  apiKey: string;
}): Promise<{ key: ApiKeySummary }> {
  return request("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteKey(id: string): Promise<void> {
  return request<void>(`/api/keys?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function updateKey(body: {
  id: string;
  isActive?: boolean;
  label?: string;
}): Promise<{ key: ApiKeySummary }> {
  return request("/api/keys", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function fetchUsageModels(month: string): Promise<ModelsResponse> {
  return request<ModelsResponse>(
    `/api/usage/models?month=${encodeURIComponent(month)}`
  );
}

/** multipart/form-data 上传官方 amount CSV；Content-Type 由浏览器自动带 boundary */
export function importUsageCsv(
  file: File,
  costFile?: File | null
): Promise<ImportUsageResponse> {
  const form = new FormData();
  form.append("file", file);
  // 可选：官方 cost CSV（含币种与当月总费用），后端校验月份一致后入库
  if (costFile) form.append("costFile", costFile);
  return request<ImportUsageResponse>("/api/usage/import", {
    method: "POST",
    body: form,
  });
}
