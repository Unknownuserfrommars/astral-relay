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
