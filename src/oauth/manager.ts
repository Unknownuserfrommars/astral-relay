import { createHash, randomBytes } from "node:crypto";
import type { PluginSecrets } from "../types/cyrene";
import { electronFetch } from "../network";
import { prepareCallback } from "./callback";
import { OAUTH_SPECS, redirectUri, type OAuthProviderId } from "./specs";

export interface OAuthTokens { accessToken: string; refreshToken?: string; expiresAt: number; accountId?: string }
export const oauthSecretKey = (id: OAuthProviderId): string => `astral_relay_oauth_${id}`;
function accountId(json: Record<string, unknown>): string | undefined {
  if (typeof json.chatgpt_account_id === "string") return json.chatgpt_account_id;
  for (const token of [json.id_token, json.access_token]) {
    if (typeof token !== "string") continue;
    try {
      const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      const id = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
      if (typeof id === "string") return id;
    } catch { /* JWT claims are metadata only, never authentication. */ }
  }
  return undefined;
}

export function createOAuthManager(deps: {
  secrets?: PluginSecrets; signal: AbortSignal; fetchImpl?: typeof fetch;
  openExternal?: (url: string) => Promise<void>;
  callback?: typeof prepareCallback;
}) {
  const doFetch = deps.fetchImpl ?? electronFetch;
  const active = new Map<OAuthProviderId, AbortController>();
  const generation = new Map<OAuthProviderId, number>();
  const refreshes = new Map<OAuthProviderId, Promise<OAuthTokens | undefined>>();
  const writes = new Map<OAuthProviderId, Promise<unknown>>();
  const current = (id: OAuthProviderId) => generation.get(id) ?? 0;
  const bump = (id: OAuthProviderId) => { generation.set(id, current(id) + 1); };
  const secrets = () => {
    if (!deps.secrets) throw new Error("宿主安全存储不可用，无法连接订阅");
    return deps.secrets;
  };
  const mutate = <T>(id: OAuthProviderId, action: () => Promise<T>): Promise<T> => {
    const next = (writes.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    writes.set(id, next);
    return next;
  };
  async function read(id: OAuthProviderId): Promise<OAuthTokens | undefined> {
    const raw = await secrets().get(oauthSecretKey(id));
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw);
      if (typeof value.accessToken === "string" && value.accessToken && Number.isFinite(value.expiresAt)) return value;
    } catch { /* Corrupt data requires reconnect, never plaintext fallback. */ }
    throw new Error("订阅凭据无效，请重新连接");
  }
  async function requestTokens(id: OAuthProviderId, params: Record<string, string>, signal: AbortSignal, previous?: OAuthTokens): Promise<OAuthTokens> {
    const spec = OAUTH_SPECS[id];
    let response: Response;
    try {
      response = await doFetch(spec.tokenUrl, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...(id === "codex" ? { originator: "codex_cli_rs" } : {}) },
        body: new URLSearchParams({ client_id: spec.clientId, ...params }).toString(),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), redirect: "error",
      });
    } catch { throw new Error("订阅授权网络请求失败或已取消，请重试"); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`订阅授权失败（HTTP ${response.status}），请重新连接`); }
    let json: Record<string, unknown>;
    try { json = await response.json() as Record<string, unknown>; } catch { throw new Error("订阅授权响应不是有效 JSON"); }
    if (!json || typeof json.access_token !== "string" || !json.access_token) throw new Error("订阅授权未返回访问凭据");
    const seconds = typeof json.expires_in === "number" && Number.isFinite(json.expires_in) && json.expires_in > 0 ? json.expires_in : 3600;
    return {
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : previous?.refreshToken,
      expiresAt: Date.now() + seconds * 1000,
      accountId: id === "codex" ? accountId(json) ?? previous?.accountId : undefined,
    };
  }
  async function save(id: OAuthProviderId, value: OAuthTokens, version: number, signal: AbortSignal) {
    await mutate(id, async () => {
      signal.throwIfAborted();
      if (current(id) !== version) throw new Error("连接已改变，请重试");
      await secrets().set(oauthSecretKey(id), JSON.stringify(value));
    });
  }
  return {
    async status(id: OAuthProviderId) {
      const tokens = deps.secrets ? await read(id) : undefined;
      return { connected: Boolean(tokens), connecting: active.has(id), expiresAt: tokens?.expiresAt };
    },
    async login(id: OAuthProviderId): Promise<void> {
      secrets();
      deps.signal.throwIfAborted();
      if (active.has(id)) throw new Error("该订阅正在连接，请完成或取消当前登录");
      const controller = new AbortController();
      active.set(id, controller);
      bump(id);
      const version = current(id);
      const signal = AbortSignal.any([deps.signal, controller.signal, AbortSignal.timeout(300000)]);
      let callback: Awaited<ReturnType<typeof prepareCallback>> | undefined;
      try {
        const spec = OAUTH_SPECS[id];
        const state = randomBytes(24).toString("base64url");
        const verifier = randomBytes(32).toString("base64url");
        const url = new URL(spec.authorizeUrl);
        for (const [key, value] of Object.entries({ response_type: "code", client_id: spec.clientId,
          redirect_uri: redirectUri(spec), scope: spec.scopes.join(" "), state,
          code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", ...spec.extra })) url.searchParams.set(key, value);
        callback = await (deps.callback ?? prepareCallback)(spec, state, signal);
        await (deps.openExternal ?? ((href) => (require("electron") as typeof import("electron")).shell.openExternal(href)))(url.toString());
        const code = await callback.code;
        const tokens = await requestTokens(id, { grant_type: "authorization_code", code, redirect_uri: redirectUri(spec), code_verifier: verifier }, signal);
        await save(id, tokens, version, signal);
      } finally {
        callback?.close();
        if (active.get(id) === controller) active.delete(id);
      }
    },
    cancel(id: OAuthProviderId) { active.get(id)?.abort(); },
    async logout(id: OAuthProviderId) {
      bump(id);
      active.get(id)?.abort();
      await mutate(id, () => secrets().delete(oauthSecretKey(id)));
    },
    async getTokens(id: OAuthProviderId): Promise<OAuthTokens | undefined> {
      deps.signal.throwIfAborted();
      const version = current(id);
      const tokens = await read(id);
      if (current(id) !== version) return undefined;
      if (!tokens || tokens.expiresAt > Date.now() + 60000) return tokens;
      if (!tokens.refreshToken) throw new Error("订阅已过期，请重新连接");
      if (!refreshes.has(id)) {
        const pending = requestTokens(id, { grant_type: "refresh_token", refresh_token: tokens.refreshToken }, deps.signal, tokens)
          .then(async (next) => { await save(id, next, version, deps.signal); return next; })
          .finally(() => { if (refreshes.get(id) === pending) refreshes.delete(id); });
        refreshes.set(id, pending);
      }
      return refreshes.get(id)!;
    },
  };
}
export type OAuthManager = ReturnType<typeof createOAuthManager>;
