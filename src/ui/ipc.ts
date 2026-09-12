import type { PluginContext, PluginStorage } from "../types/cyrene";
import { loadConfig, mergeConfigPatch, saveConfig } from "../config";
import { PLANS, findPlan, secretKeyOf } from "../core/plans";
import type { Gate } from "../core/gate";
import type { ProxyHandle } from "../proxy/server";
import type { Logger } from "../logger";

const GET_STATE = "get-state";
const SAVE_CONFIG = "save-config";
const SAVE_KEY = "save-key";
const CLEAR_KEY = "clear-key";

export interface UiIpcDeps {
  gate: Gate;
  storage: PluginStorage;
  log: Logger;
  getProxy: () => ProxyHandle | null;
}

/**
 * 面板 IPC。四个 channel，全部 fail-safe：读失败返回空状态，写失败返回 ok:false。
 *
 * 安全约定：订阅 Key 只进 ctx.deps.secrets，get-state 绝不回传 Key 本身，
 * 只回传「有没有配」这个布尔值。
 */
export function registerUiIpc(ctx: PluginContext, deps: UiIpcDeps): void {
  const { gate, storage, log, getProxy } = deps;

  const getState = async () => {
    try {
      const config = loadConfig(storage);
      const proxy = getProxy();
      let keyConfigured = false;
      if (config.planId && ctx.deps.secrets) {
        try {
          keyConfigured = Boolean(await ctx.deps.secrets.get(secretKeyOf(config.planId)));
        } catch {
          keyConfigured = false;
        }
      }
      return {
        plans: PLANS.map((p) => ({ id: p.id, label: p.label, keyPrefix: p.keyPrefix, termsUrl: p.termsUrl })),
        config,
        keyConfigured,
        gate: gate.snapshot(),
        proxy: proxy ? { baseUrl: proxy.baseUrl, token: proxy.token, port: proxy.port } : null,
      };
    } catch (err) {
      log.warn("get-state 失败：", err instanceof Error ? err.message : String(err));
      return { plans: [], config: loadConfig(storage), keyConfigured: false, gate: gate.snapshot(), proxy: null };
    }
  };

  const saveConfigPatch = (patch: unknown) => {
    try {
      const next = mergeConfigPatch(loadConfig(storage), patch);
      if (next.planId && !findPlan(next.planId)) return { ok: false, error: "未知的套餐 id" };
      saveConfig(storage, next);
      return { ok: true, config: next };
    } catch (err) {
      log.warn("save-config 失败：", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "保存失败" };
    }
  };

  const saveKey = async (payload: unknown) => {
    const input = (typeof payload === "object" && payload !== null ? payload : {}) as {
      planId?: unknown;
      key?: unknown;
    };
    const planId = typeof input.planId === "string" ? input.planId : "";
    const key = typeof input.key === "string" ? input.key.trim() : "";
    const plan = findPlan(planId);
    if (!plan) return { ok: false, error: "未知的套餐 id" };
    if (!key) return { ok: false, error: "Key 不能为空" };
    // 前缀只做提醒，不做硬拦：厂商随时可能换前缀，挡死会让插件直接不可用。
    const prefixMismatch = !key.startsWith(plan.keyPrefix);
    if (!ctx.deps.secrets) return { ok: false, error: "宿主安全存储不可用" };
    try {
      await ctx.deps.secrets.set(secretKeyOf(plan.id), key);
      return { ok: true, prefixMismatch, expectedPrefix: plan.keyPrefix };
    } catch (err) {
      log.warn("保存 Key 失败：", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "安全存储写入失败" };
    }
  };

  const clearKey = async (payload: unknown) => {
    const planId = typeof payload === "string" ? payload : "";
    const plan = findPlan(planId);
    if (!plan || !ctx.deps.secrets) return { ok: false };
    try {
      await ctx.deps.secrets.delete(secretKeyOf(plan.id));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  };

  // 重复注册幂等：先尝试移除旧处理器（首次注册时通道不存在，吞掉失败）。
  for (const channel of [GET_STATE, SAVE_CONFIG, SAVE_KEY, CLEAR_KEY]) {
    try {
      ctx.unregisterIpc(channel);
    } catch {
      /* 尚未注册，忽略 */
    }
  }
  try {
    ctx.registerIpc(GET_STATE, () => getState());
    ctx.registerIpc(SAVE_CONFIG, (patch) => saveConfigPatch(patch));
    ctx.registerIpc(SAVE_KEY, (payload) => saveKey(payload));
    ctx.registerIpc(CLEAR_KEY, (payload) => clearKey(payload));
  } catch (err) {
    log.warn("注册面板 IPC 失败：", err instanceof Error ? err.message : String(err));
  }

  ctx.onDispose(() => {
    try {
      for (const channel of [GET_STATE, SAVE_CONFIG, SAVE_KEY, CLEAR_KEY]) ctx.unregisterIpc(channel);
    } catch (err) {
      log.warn("移除面板 IPC 失败：", err instanceof Error ? err.message : String(err));
    }
  });
}
