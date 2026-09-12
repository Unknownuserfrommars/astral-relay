/**
 * 自包含的 Code 轮次绑定。
 *
 * 目的：让编程套餐的「仅 Code 模式」限制在**不依赖任何宿主改动**的前提下成立。
 * 插件只是一个 ZIP，装上就该能用；要求用户去改宿主源码再重新构建，是把插件
 * 变成了补丁，这不是插件该有的样子。
 *
 * 机制：
 *
 * 1. 宿主按 modes / sources 过滤 prompt provider。声明
 *    modes:["code"] + sources:["conversation"] 的 provider，只会在 Code 模式的
 *    会话轮次被调用；定时任务（source:"scheduler"）与发帖决策（"moments-post"）
 *    根本进不来。provider 入参里带着本轮的 mode、source 和 userText。
 * 2. provider 被调用时（再显式核对一次 mode === "code" && source === "conversation"，
 *    不把过滤这件事全押在宿主身上），把 userText 的指纹登记下来。
 * 3. 代理收到编程套餐请求时，从请求体里取出最后一条 user 消息，算同样的指纹。
 *    登记过 = 这段输入确实来自一次 Code 模式的交互式会话，放行；否则拒绝。
 *
 * provider 在宿主构建请求之前就被 await，userText 又会原样出现在出站请求体里，
 * 所以「登记」必然早于「验证」，顺序上不存在竞态。
 *
 * 安全属性（如实写出来，不假装严密）：
 *
 * - 这证明的是「这段用户输入在 TTL 内确实发生过一次 Code 交互」，**不是**
 *   「这个 HTTP 请求由那一轮发出」。在同一台机器上拿到本地 token 的程序，
 *   只要重放同样的文本就能通过。插件的信任模型本来就不防本机恶意进程。
 * - 同一段文本在 Code 模式发过之后，TTL 内在 Chat 模式再发一次也会通过。
 *   要堵这个缺口需要逐请求凭据，那必须由宿主签名（见 request-auth.ts 的 ar1）。
 * - 登记不在轮次结束时清除：清除要认 runId，而 provider 入参里没有 runId。
 *   宁可靠 TTL 与条目上限收口，也不要让另一轮结束打断本轮的工具续轮。
 *
 * 它挡住的是真实存在的那类误用：定时任务、朋友圈发帖、连接测试，以及
 * Chat / Work / Learn 里随手拿编程套餐档案发消息——这正是条款关心的场景。
 */
import { createHash } from "node:crypto";

/** 登记存活时间：要盖住一次 Code 轮次里的全部重试与工具续轮。 */
export const DEFAULT_BINDING_TTL_MS = 2 * 60 * 60 * 1000;
/** 条目上限：超出后淘汰最旧的，防止长会话把内存吃掉。 */
export const DEFAULT_BINDING_MAX = 64;

export interface TurnBindingOptions {
  ttlMs?: number;
  max?: number;
  now?: () => number;
}

export interface TurnBindingInput {
  mode?: string;
  source?: string;
  userText?: string;
}

export interface TurnBinding {
  /** 登记一次 Code 会话轮次的用户输入；非 Code / 非会话来源返回 false。 */
  register(input: TurnBindingInput): boolean;
  /** 任一候选文本命中未过期的登记即放行。 */
  matchesAny(texts: readonly string[]): boolean;
  size(): number;
  clear(): void;
}

/**
 * 文本指纹。
 *
 * 折叠空白再哈希：宿主把多段内容拼成纯文本时用什么分隔符不在插件 API 契约里，
 * 折叠之后分隔符是空格还是换行就不影响结果了。空文本不登记——绑不住空内容。
 */
export function fingerprint(text: string): string | null {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) return null;
  return createHash("sha256").update(normalized).digest("hex");
}

export function createTurnBinding(options: TurnBindingOptions = {}): TurnBinding {
  const ttlMs = options.ttlMs ?? DEFAULT_BINDING_TTL_MS;
  const max = options.max ?? DEFAULT_BINDING_MAX;
  const now = options.now ?? (() => Date.now());
  /** hash -> 登记时刻。Map 的插入序就是最近使用序，淘汰时取最旧的。 */
  const entries = new Map<string, number>();

  // 边界与 gate.ts 一致：正好 ttlMs 仍然有效，超过才失效。
  const sweep = (): void => {
    const cutoff = now() - ttlMs;
    for (const [hash, at] of entries) {
      if (at < cutoff) entries.delete(hash);
    }
  };

  return {
    register(input) {
      // 显式核对：宿主的 modes / sources 过滤是第一道，这里是第二道。
      // 只有 Code 模式的交互式会话才登记，其余一律不登记。
      if (input.mode !== "code" || input.source !== "conversation") return false;
      const hash = fingerprint(typeof input.userText === "string" ? input.userText : "");
      if (!hash) return false;
      sweep();
      entries.delete(hash);
      entries.set(hash, now());
      while (entries.size > max) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      return true;
    },
    matchesAny(texts) {
      sweep();
      for (const text of texts) {
        const hash = fingerprint(text);
        if (hash && entries.has(hash)) return true;
      }
      return false;
    },
    size() {
      sweep();
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}

/**
 * 从 OpenAI 兼容请求体里取最后一条 user 消息的候选文本。
 *
 * 返回数组而不是单个字符串：多段 content 被宿主拼成纯文本时的分隔符不在契约里，
 * 换行拼与直接相接两种都给出来，任一命中即可。纯字符串 content（绝大多数情况）
 * 两种结果相同。
 */
export function lastUserTexts(body: Buffer | string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];

  let content: unknown;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && typeof message === "object" && (message as { role?: unknown }).role === "user") {
      content = (message as { content?: unknown }).content;
      break;
    }
  }
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (part && typeof part === "object") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  if (parts.length === 0) return [];
  return [parts.join("\n"), parts.join("")];
}
