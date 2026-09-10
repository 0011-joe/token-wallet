/**
 * Provider 注册表（DEV-GUIDE §8，AC2.1）：cron/API 只依赖 registry，不硬编码平台。
 */
import type { ProviderAdapter, ProviderId } from "./types";

const adapters = new Map<ProviderId, ProviderAdapter>();

export function registerProvider(adapter: ProviderAdapter): void {
  if (adapters.has(adapter.id)) {
    throw new Error(`Provider ${adapter.id} 已注册（重复注册为编码错误）`);
  }
  adapters.set(adapter.id, adapter);
}

export function getProvider(id: ProviderId): ProviderAdapter | undefined {
  return adapters.get(id);
}

export function getProviderOrThrow(id: ProviderId): ProviderAdapter {
  const adapter = adapters.get(id);
  if (!adapter) {
    throw new Error(`Provider ${id} 未注册`);
  }
  return adapter;
}

export function listProviders(): ProviderAdapter[] {
  return [...adapters.values()];
}

export function isProviderRegistered(id: ProviderId): boolean {
  return adapters.has(id);
}
