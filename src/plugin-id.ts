/**
 * 插件 id 单一事实源。
 * IPC channel、存储目录、安装目录都从此派生，不要硬编码。
 */
export const PLUGIN_ID = "astral-relay" as const;
export type PluginId = typeof PLUGIN_ID;
