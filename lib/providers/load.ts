/**
 * 确保三家 adapter 已注册（副作用 import）。
 *
 * 问题：adapter 在模块底部 registerProvider；Next.js 路由若只 import registry，
 * 打包后可能树摇掉 adapter 模块 → getProvider 返回 undefined →
 * 刷新接口误报「该平台暂未支持」。凡使用 getProvider/getProviderOrThrow 的
 * 服务端入口必须先 await ensureProviders()。
 */
import "./deepseek";
import "./kimi";
import "./volcengine/adapter";

import { listProviders } from "./registry";

let loaded = false;

/** 幂等加载；已注册则直接返回 */
export function ensureProviders(): void {
  if (loaded) return;
  // import 侧已完成 register；重复 load 不会再次执行模块
  loaded = listProviders().length > 0;
  if (!loaded) {
    // 仍为空说明 import 未执行（极端打包问题），强制报错便于排查
    throw new Error("provider adapters 未注册：请检查 lib/providers/load.ts 导入链");
  }
}
