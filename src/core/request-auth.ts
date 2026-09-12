import { createHmac, timingSafeEqual } from "node:crypto";

/** Wire contract shared with Cyrene's astral-relay-auth.ts. Never send upstream. */
export interface RelayContext {
  provider: string;
  mode: string;
  source: string;
  issuedAt: number;
  nonce: string;
}

export const CONTEXT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 首次使用后的可用时长。
 *
 * 为什么不是「一个 nonce 只许用一次」：宿主每轮构建一次请求选项，
 * 同一轮里的流式重试与工具续轮共用同一个凭据，也就共用同一个 nonce。
 * 严格去重会把工具续轮打断，那是把可用性换成了一个假的严密性。
 * 折中做法是**首次使用即开始计时**：nonce 第一次出现时记下时刻，
 * 超过这个窗口就不再接受，把 issuedAt 给出的 24 小时重放窗口收缩到首用后的两小时。
 */
export const NONCE_USE_WINDOW_MS = 2 * 60 * 60 * 1000;
/** 记忆上限：满了淘汰最旧的。淘汰意味着那个 nonce 会被当成首次使用，见下方说明。 */
export const NONCE_STORE_MAX = 512;

export interface NonceStore {
  /** 首次使用记录时刻并返回 true；超过首用窗口返回 false。 */
  accept(nonce: string): boolean;
  size(): number;
}

export function createNonceStore(options: { windowMs?: number; max?: number; now?: () => number } = {}): NonceStore {
  const windowMs = options.windowMs ?? NONCE_USE_WINDOW_MS;
  const max = options.max ?? NONCE_STORE_MAX;
  const now = options.now ?? (() => Date.now());
  /** nonce -> 首次使用时刻。 */
  const seen = new Map<string, number>();

  // 保留到 CONTEXT_MAX_AGE_MS 而不是 windowMs：只留到首用窗口就忘掉的话，
  // 忘掉之后同一个 nonce 又会被当成「首次使用」，等于白记。凭据本身最长 24 小时，
  // 留满 24 小时就不存在这个漏洞。上限淘汰仍可能提前遗忘，这是内存与严密性的取舍。
  const sweep = (): void => {
    const cutoff = now() - CONTEXT_MAX_AGE_MS;
    for (const [nonce, at] of seen) {
      if (at < cutoff) seen.delete(nonce);
    }
  };

  return {
    accept(nonce) {
      sweep();
      const firstSeen = seen.get(nonce);
      if (firstSeen !== undefined) return now() - firstSeen <= windowMs;
      seen.set(nonce, now());
      while (seen.size > max) {
        const oldest = seen.keys().next();
        if (oldest.done) break;
        seen.delete(oldest.value);
      }
      return true;
    },
    size() {
      sweep();
      return seen.size;
    },
  };
}

export function readRelayContext(credential: string, secret: string, provider: string, now = Date.now()): RelayContext | null {
  if (credential.length > 2048) return null;
  const parts = credential.split(".");
  if (parts.length !== 3 || parts[0] !== "ar1" || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2])) return null;
  const expected = createHmac("sha256", secret).update(`ar1.${parts[1]}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(parts[2], "hex"))) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!value || value.provider !== provider || typeof value.mode !== "string" ||
        typeof value.source !== "string" || typeof value.nonce !== "string" || !value.nonce ||
        !Number.isSafeInteger(value.issuedAt) || value.issuedAt > now || now - value.issuedAt >= CONTEXT_MAX_AGE_MS) return null;
    return value;
  } catch {
    return null;
  }
}
