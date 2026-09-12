import type { PluginContext } from "./types/cyrene";

export interface Logger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * 统一日志前缀。
 * 注意：订阅 Key 绝不允许进日志——本插件所有日志点只打印 provider id 与端口。
 */
export function createLogger(raw: Pick<PluginContext, "log">): Logger {
  const prefix = "[编程套餐直通]";
  const log = raw.log.bind(raw);
  return {
    log: (...args) => log(prefix, ...args),
    warn: (...args) => log(prefix, "[warn]", ...args),
    error: (...args) => log(prefix, "[error]", ...args),
  };
}
