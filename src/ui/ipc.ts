import type { PluginContext, PluginStorage } from "../types/cyrene";
import { loadConfig, mergeConfigPatch, regionOf, saveConfig } from "../config";
import { PROVIDERS, findProvider, resolveBaseUrl, secretKeyOf } from "../core/providers";
import type { Gate } from "../core/gate";
import type { ProxyHandle } from "../proxy/server";
import type { Logger } from "../logger";
import type { OAuthManager } from "../oauth/manager";
import { isOAuthProvider, type OAuthProviderId } from "../oauth/specs";
import { fetchCatalog } from "../oauth/upstream";

const GET_STATE = "get-state";
const SAVE_CONFIG = "save-config";
const SAVE_KEY = "save-key";
const CLEAR_KEY = "clear-key";
const OAUTH_CHANNELS = ["oauth-login", "oauth-cancel", "oauth-logout", "oauth-models"] as const;

export interface UiIpcDeps {
  gate: Gate;
  storage: PluginStorage;
  log: Logger;
  getProxy: () => ProxyHandle | null;
  oauth?: OAuthManager;
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
    const config = loadConfig(storage);
    const proxy = getProxy();
    const providers = [];
    for (const provider of PROVIDERS) {
      let keyConfigured = false;
      let oauthState = { connected: false, connecting: false } as { connected: boolean; connecting: boolean; expiresAt?: number };
      if (isOAuthProvider(provider.id) && deps.oauth) {
        try { oauthState = await deps.oauth.status(provider.id); } catch { /* Expose no secret-store errors. */ }
      }
      if (provider.available && ctx.deps.secrets) {
        try {
          keyConfigured = Boolean(await ctx.deps.secrets.get(secretKeyOf(provider.id)));
        } catch {
          keyConfigured = false;
        }
      }
      providers.push({
        id: provider.id,
        label: provider.label,
        kind: provider.kind,
        available: provider.available,
        auth: provider.auth ?? "key",
        protocol: provider.protocol ?? "openai",
        oauth: oauthState,
        note: provider.note,
        termsUrl: provider.termsUrl,
        keyPrefix: provider.keyPrefix ?? "",
        regions: provider.regions ?? [],
        regionId: regionOf(config, provider.id) ?? provider.regions?.[0]?.id ?? "",
        upstream: resolveBaseUrl(provider, regionOf(config, provider.id)) ?? "",
        keyConfigured,
        // 只有 available 的厂商才给 baseUrl：置灰的厂商给了也没法用
        baseUrl: proxy && provider.available ? proxy.baseUrlFor(provider.id) : "",
      });
    }
    return {
      providers,
      windowTtlMs: config.windowTtlMs,
      gate: gate.snapshot(),
      proxy: proxy ? { port: proxy.port, token: proxy.token } : null,
    };
  };

  const saveConfigPatch = (patch: unknown) => {
    try {
      const next = mergeConfigPatch(loadConfig(storage), patch);
      saveConfig(storage, next);
      return { ok: true };
    } catch (err) {
      log.warn("save-config 失败：", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "保存失败" };
    }
  };

  const saveKey = async (payload: unknown) => {
    const input = (typeof payload === "object" && payload !== null ? payload : {}) as {
      providerId?: unknown;
      key?: unknown;
    };
    const providerId = typeof input.providerId === "string" ? input.providerId : "";
    const key = typeof input.key === "string" ? input.key.trim() : "";
    const provider = findProvider(providerId);
    if (!provider) return { ok: false, error: "未知的厂商 id" };
    if (!provider.available) return { ok: false, error: `${provider.label} 当前版本未实现` };
    if (provider.auth === "oauth") return { ok: false, error: "此订阅使用浏览器登录，请点击连接" };
    if (!key) return { ok: false, error: "Key 不能为空" };
    if (!ctx.deps.secrets) return { ok: false, error: "宿主安全存储不可用" };
    // 前缀只做提醒，不做硬拦：厂商随时可能换前缀，挡死会让插件直接不可用。
    const prefixMismatch = Boolean(provider.keyPrefix) && !key.startsWith(provider.keyPrefix!);
    try {
      await ctx.deps.secrets.set(secretKeyOf(provider.id), key);
      return { ok: true, prefixMismatch, expectedPrefix: provider.keyPrefix ?? "" };
    } catch (err) {
      log.warn("保存 Key 失败：", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "安全存储写入失败" };
    }
  };

  const clearKey = async (payload: unknown) => {
    const providerId = typeof payload === "string" ? payload : "";
    const provider = findProvider(providerId);
    if (!provider || !ctx.deps.secrets) return { ok: false };
    try {
      await ctx.deps.secrets.delete(secretKeyOf(provider.id));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  };

  // 重复注册幂等：先尝试移除旧处理器（首次注册时通道不存在，吞掉失败）。
  const allChannels = [GET_STATE, SAVE_CONFIG, SAVE_KEY, CLEAR_KEY, ...OAUTH_CHANNELS];
  const oauthAction = async (id: unknown, action: (provider: OAuthProviderId, oauth: OAuthManager) => Promise<unknown>) => {
    if (typeof id !== "string" || !isOAuthProvider(id) || !deps.oauth || ctx.signal.aborted) return { ok: false, error: "订阅不可用" };
    try { return { ok: true, result: await action(id, deps.oauth) }; }
    catch { return { ok: false, error: "订阅操作失败或已取消，请检查网络、登录端口、订阅账号及安全存储后重试。" }; }
  };
  for (const channel of allChannels) {
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
    ctx.registerIpc("oauth-login", (id) => oauthAction(id, (provider, oauth) => oauth.login(provider)));
    ctx.registerIpc("oauth-cancel", (id) => oauthAction(id, async (provider, oauth) => oauth.cancel(provider)));
    ctx.registerIpc("oauth-logout", (id) => oauthAction(id, (provider, oauth) => oauth.logout(provider)));
    ctx.registerIpc("oauth-models", (id) => oauthAction(id, async (provider, oauth) => {
      const tokens = await oauth.getTokens(provider);
      if (!tokens) throw new Error("未连接");
      return fetchCatalog(provider, tokens, ctx.signal);
    }));
  } catch (err) {
    log.warn("注册面板 IPC 失败：", err instanceof Error ? err.message : String(err));
  }

  ctx.onDispose(() => {
    try {
      for (const channel of allChannels) ctx.unregisterIpc(channel);
    } catch (err) {
      log.warn("移除面板 IPC 失败：", err instanceof Error ? err.message : String(err));
    }
  });
}
