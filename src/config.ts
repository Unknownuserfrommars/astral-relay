import type { PluginStorage } from "./types/cyrene";
import { DEFAULT_WINDOW_TTL_MS } from "./core/gate";
import { findProvider } from "./core/providers";

const CONFIG_KEY = "config";

export interface ProviderConfig {
  /** 多区域厂商选定的区域 id；单区域厂商忽略。 */
  regionId?: string;
}

export interface PluginConfig {
  /** 各厂商的独立配置；没出现的厂商按默认值处理。 */
  providers: Record<string, ProviderConfig>;
  /** 闸门开窗存活上限（ms）。只影响 coding-only 厂商。 */
  windowTtlMs: number;
}

export const DEFAULT_CONFIG: PluginConfig = {
  providers: {},
  windowTtlMs: DEFAULT_WINDOW_TTL_MS,
};

export function loadConfig(storage: PluginStorage): PluginConfig {
  const saved = storage.get<Partial<PluginConfig>>(CONFIG_KEY) ?? {};
  return {
    providers:
      typeof saved.providers === "object" && saved.providers !== null ? { ...saved.providers } : {},
    windowTtlMs:
      typeof saved.windowTtlMs === "number" && Number.isFinite(saved.windowTtlMs)
        ? saved.windowTtlMs
        : DEFAULT_CONFIG.windowTtlMs,
  };
}

export function saveConfig(storage: PluginStorage, config: PluginConfig): void {
  storage.set(CONFIG_KEY, config);
}

/**
 * 面板保存时的白名单合并：键与类型都要对得上，半填表单写不坏配置。
 * 未知厂商 id 与未知区域 id 一律丢弃——否则代理会拿到一个解析不出端点的配置。
 */
export function mergeConfigPatch(current: PluginConfig, patch: unknown): PluginConfig {
  if (typeof patch !== "object" || patch === null) return current;
  const incoming = patch as Record<string, unknown>;
  const next: PluginConfig = {
    providers: { ...current.providers },
    windowTtlMs: current.windowTtlMs,
  };

  if (typeof incoming.windowTtlMs === "number" && Number.isFinite(incoming.windowTtlMs)) {
    // 下限 10 秒：再短会让正常一轮请求还没发出去就过期。
    next.windowTtlMs = Math.min(Math.max(Math.floor(incoming.windowTtlMs), 10_000), 600_000);
  }

  if (typeof incoming.providerId === "string" && typeof incoming.regionId === "string") {
    const provider = findProvider(incoming.providerId);
    const known = provider?.regions?.some((r) => r.id === incoming.regionId) ?? false;
    if (provider && known) {
      next.providers[provider.id] = { ...next.providers[provider.id], regionId: incoming.regionId };
    }
  }

  return next;
}

/** 取某厂商的区域选择；没配过返回 undefined（由 resolveBaseUrl 兜底取第一个）。 */
export function regionOf(config: PluginConfig, providerId: string): string | undefined {
  return config.providers[providerId]?.regionId;
}
