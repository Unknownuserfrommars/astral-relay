import type { PluginStorage } from "./types/cyrene";
import { DEFAULT_WINDOW_TTL_MS } from "./core/gate";

const CONFIG_KEY = "config";

export interface PluginConfig {
  /** 选用的套餐 id，见 core/plans.ts；空串 = 尚未配置。 */
  planId: string;
  /** 开窗存活上限（ms）。调小更严格，调大更宽松。 */
  windowTtlMs: number;
}

export const DEFAULT_CONFIG: PluginConfig = {
  planId: "",
  windowTtlMs: DEFAULT_WINDOW_TTL_MS,
};

export function loadConfig(storage: PluginStorage): PluginConfig {
  const saved = storage.get<Partial<PluginConfig>>(CONFIG_KEY) ?? {};
  return { ...DEFAULT_CONFIG, ...saved };
}

export function saveConfig(storage: PluginStorage, config: PluginConfig): void {
  storage.set(CONFIG_KEY, config);
}

/** 面板保存时的白名单合并：键与类型都要对得上，半填表单写不坏配置。 */
export function mergeConfigPatch(current: PluginConfig, patch: unknown): PluginConfig {
  if (typeof patch !== "object" || patch === null) return current;
  const incoming = patch as Record<string, unknown>;
  const next: PluginConfig = { ...current };
  if (typeof incoming.planId === "string") next.planId = incoming.planId;
  if (typeof incoming.windowTtlMs === "number" && Number.isFinite(incoming.windowTtlMs)) {
    // 下限 10 秒：再短会让正常一轮请求还没发出去就过期。
    next.windowTtlMs = Math.min(Math.max(Math.floor(incoming.windowTtlMs), 10_000), 600_000);
  }
  return next;
}
