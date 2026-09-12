import type { PluginContext, PluginPromptProvider } from "../src/types/cyrene";

export const silentLog = { log: () => {}, warn: () => {}, error: () => {} };

export interface MockContext extends PluginContext {
  promptProviders: PluginPromptProvider[];
  ipcChannels: Map<string, (...args: unknown[]) => unknown>;
  subscriptions: Array<{ event: string; listener: (payload: any) => unknown }>;
  secretStore: Map<string, string>;
  dispose: () => Promise<void>;
}

/** 插件契约测试用的最小 PluginContext 假实现。 */
export function createMockContext(options: { pluginId?: string; withSecrets?: boolean } = {}): MockContext {
  const id = options.pluginId ?? "astral-relay";
  const controller = new AbortController();
  const promptProviders: PluginPromptProvider[] = [];
  const ipcChannels = new Map<string, (...args: unknown[]) => unknown>();
  const subscriptions: Array<{ event: string; listener: (payload: any) => unknown }> = [];
  const cleanups: Array<() => void | Promise<void>> = [];
  const storageMap = new Map<string, unknown>();
  const secretStore = new Map<string, string>();
  let disposed = false;

  const secrets = {
    get: async (name: string) => secretStore.get(name),
    set: async (name: string, value: string) => {
      secretStore.set(name, value);
    },
    delete: async (name: string) => secretStore.delete(name),
  };

  const ctx: MockContext = {
    id,
    signal: controller.signal,
    deps: options.withSecrets === false ? {} : { secrets },
    promptProviders,
    ipcChannels,
    subscriptions,
    secretStore,
    onDispose: (cleanup) => {
      cleanups.push(cleanup);
    },
    events: {
      on: (event, listener) => {
        subscriptions.push({ event, listener: listener as (payload: any) => unknown });
        return () => {};
      },
      emit: async () => {},
    },
    registerPromptProvider: (provider) => {
      promptProviders.push(provider);
    },
    unregisterPromptProvider: () => {},
    registerIpc: (channel, handler) => {
      ipcChannels.set(channel, handler);
    },
    unregisterIpc: (channel) => {
      if (!ipcChannels.has(channel)) throw new Error("channel 未注册");
      ipcChannels.delete(channel);
    },
    storage: {
      get: (key) => storageMap.get(key) as never,
      set: (key, value) => {
        storageMap.set(key, value);
      },
      rootDir: () => "/mock/plugin-data",
    },
    log: () => {},
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      controller.abort();
      for (const cleanup of [...cleanups].reverse()) await cleanup();
    },
  };
  return ctx;
}
