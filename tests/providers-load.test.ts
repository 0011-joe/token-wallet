/**
 * ensureProviders 幂等加载三家 adapter。
 */
import { describe, expect, it } from "vitest";

import { ensureProviders } from "@/lib/providers/load";
import { getProvider, listProviders } from "@/lib/providers/registry";

describe("ensureProviders", () => {
  it("加载后 deepseek/kimi/volcengine 均可取", () => {
    ensureProviders();
    expect(getProvider("deepseek")).toBeTruthy();
    expect(getProvider("kimi")).toBeTruthy();
    expect(getProvider("volcengine")).toBeTruthy();
    expect(listProviders().length).toBeGreaterThanOrEqual(3);
  });

  it("重复调用不抛（幂等）", () => {
    ensureProviders();
    ensureProviders();
    expect(getProvider("deepseek")).toBeTruthy();
  });
});
