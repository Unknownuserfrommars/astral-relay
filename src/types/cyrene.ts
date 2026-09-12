/**
 * Cyrene 插件 API 的最小类型面。
 *
 * 刻意不依赖 @playa0v0/cyrene-plugin-sdk：本插件运行时零依赖，编译期也只用到
 * 下面这几个形状。宿主升级新增字段不会影响这里；真实契约以宿主
 * docs/plugins/plugin-authoring.md 为准。
 */

export type PluginPromptMode = "chat" | "work" | "learn" | "code";
export type PluginPromptSource = "conversation" | "scheduler" | "moments-post";

export interface PluginStorage {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  rootDir(): string;
}

export interface PluginSecrets {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

export interface PluginDeps {
  secrets?: PluginSecrets;
}

export interface PluginPromptProviderInput {
  source: PluginPromptSource;
  mode?: PluginPromptMode;
  userText: string;
  conversationId?: string;
  channel?: string;
  readonly signal: AbortSignal;
}

export interface PluginPromptProvider {
  id: string;
  modes?: PluginPromptMode[];
  sources?: PluginPromptSource[];
  provide(input: PluginPromptProviderInput): string | Promise<string>;
}

/** turn:finished 只用到这几个字段；其余宿主字段这里不声明。 */
export interface PluginTurnFinishedEvent {
  source: "desktop" | "channel" | "scheduler";
  mode: PluginPromptMode;
  runId: string;
  status: "success" | "cancelled" | "timeout" | "runtime_error";
}

export interface PluginEvents {
  on<T = unknown>(event: string, listener: (payload: T) => void | Promise<void>): () => void;
  emit<T = unknown>(event: string, payload: T): Promise<void>;
}

export interface PluginContext {
  id: string;
  readonly signal: AbortSignal;
  onDispose(cleanup: () => void | Promise<void>): void;
  events: PluginEvents;
  registerPromptProvider(provider: PluginPromptProvider): void;
  unregisterPromptProvider(providerId: string): void;
  registerIpc(channel: string, handler: (...args: unknown[]) => unknown): void;
  unregisterIpc(channel: string): void;
  storage: PluginStorage;
  deps: PluginDeps;
  log(...args: unknown[]): void;
}

export interface CyrenePlugin {
  register(ctx: PluginContext): Promise<void>;
  unregister?(): Promise<void>;
  open?(): Promise<void>;
}
