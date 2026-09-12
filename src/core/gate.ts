/**
 * 闸门：本插件唯一的合规执行点，纯逻辑 + 一个内存状态机，单独可测。
 *
 * 为什么需要它：三家套餐的条款都只允许「编程工具里的交互式使用」，明确禁止
 * 自动化脚本、应用后端与非交互批量调用。Cyrene 除了用户敲字的 Code 模式，
 * 还有定时任务、朋友圈发帖、渠道消息这些无人值守路径——它们共用同一套模型档案，
 * 光靠用户自觉选档案挡不住。
 *
 * 怎么挡住：宿主在「构建请求选项」阶段调用 prompt provider，并按 modes /
 * sources 过滤。声明 modes:["code"] + sources:["conversation"] 的 provider，
 * 只会在 Code 模式的会话轮次被调用，定时任务（source:"scheduler"）与发帖决策
 * （source:"moments-post"）根本进不来。于是 provider 被调用 = 本轮确实是
 * 「用户在 Code 模式里交互」，此时开窗；代理只在开窗期间放行。
 *
 * 已知边界（如实写出来，不假装严密）：
 *
 * 1. 这是「时间窗」而不是「逐请求绑定」。模型档案里的 apiKey 是静态的，宿主也
 *    不会把轮次标识带进 HTTP 头，所以代理无法把某个请求认到某一轮。开窗期间
 *    另一个窗口手动发起的 Chat 轮次若恰好选了同一个档案，请求会被放行。
 * 2. provider 的入参里没有 runId（只有 source/mode/userText/conversationId），
 *    而 runId 只出现在 turn:finished。两者无法对应，所以关窗不认轮次：
 *    任何一次 turn:finished 都关窗。宁可关早（下一轮 provider 会重新开），
 *    也不能关晚——关晚等于窗口一直开着。
 *
 * 两条都靠「窗口尽量短」缓解，消不掉。想彻底消掉需要宿主把轮次上下文带进请求，
 * 那是上游 API 的事。
 */

/** 开窗后的最长存活时间：turn:finished 丢失（崩溃/超时）时的兜底。 */
export const DEFAULT_WINDOW_TTL_MS = 180_000;

export type GateRefusal = "closed" | "expired" | "bad_token";
export type GateDecision = { allowed: true } | { allowed: false; code: GateRefusal };

export interface GateSnapshot {
  open: boolean;
  openedAt: number;
}

export interface GateOptions {
  ttlMs?: number;
  now?: () => number;
}

export interface Gate {
  /** Code 模式会话轮次开窗；重复调用只是刷新开窗时刻。 */
  open(): void;
  /** 关窗。任何 turn:finished 与插件停用都走这里。 */
  close(): void;
  /** 代理放行判定。 */
  check(token: string, expectedToken: string): GateDecision;
  snapshot(): GateSnapshot;
}

export function createGate(options: GateOptions = {}): Gate {
  const ttlMs = options.ttlMs ?? DEFAULT_WINDOW_TTL_MS;
  const now = options.now ?? (() => Date.now());
  let openedAt = 0;

  const isExpired = (): boolean => openedAt !== 0 && now() - openedAt > ttlMs;

  return {
    open() {
      openedAt = now();
    },
    close() {
      openedAt = 0;
    },
    check(token, expectedToken) {
      // 先验 token 再看窗：token 不对说明来的根本不是宿主，不该泄露闸门状态。
      if (!constantTimeEquals(token, expectedToken)) return { allowed: false, code: "bad_token" };
      if (openedAt === 0) return { allowed: false, code: "closed" };
      if (isExpired()) {
        openedAt = 0;
        return { allowed: false, code: "expired" };
      }
      return { allowed: true };
    },
    snapshot() {
      if (isExpired()) return { open: false, openedAt: 0 };
      return { open: openedAt !== 0, openedAt };
    },
  };
}

/** 定长比较，避免把 token 比较写成可计时的短路比较。 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
