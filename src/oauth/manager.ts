import { createHash, randomBytes } from "node:crypto";
import type { PluginSecrets } from "../types/cyrene";
import { electronFetch } from "../network";
import { prepareCallback } from "./callback";
import { DEVICE_CODE_GRANT_TYPE, OAUTH_SPECS, redirectUri, type OAuthProviderId } from "./specs";

export interface OAuthTokens { accessToken: string; refreshToken?: string; expiresAt: number }
/** 设备码轮询节奏，遵循 RFC 8628：默认 5s，服务端要求 slow_down 时每次 +5s。 */
const DEVICE_POLL_DEFAULT_MS = 5000;
const DEVICE_POLL_MIN_MS = 1000;
const DEVICE_SLOW_DOWN_STEP_MS = 5000;

/** 面板展示用的设备码信息；verificationUriComplete 可直接打开，无需手输。 */
export interface DevicePrompt {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
}

export const oauthSecretKey = (id: OAuthProviderId): string => `astral_relay_oauth_${id}`;

export function createOAuthManager(deps: {
  secrets?: PluginSecrets; signal: AbortSignal; fetchImpl?: typeof fetch;
  openExternal?: (url: string) => Promise<void>;
  callback?: typeof prepareCallback;
  /** 测试注入点：设备码轮询的等待实现。生产用真实定时器。 */
  sleep?: (ms: number) => Promise<void>;
}) {
  const doFetch = deps.fetchImpl ?? electronFetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
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
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ client_id: spec.clientId, ...params }).toString(),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), redirect: "error",
      });
    } catch { throw new Error("订阅授权网络请求失败或已取消，请重试"); }
    if (!response.ok) {
      // 设备码轮询要靠 OAuth error 码区分「还没批准」与「真失败」，
      // 所以这里读出 error 字段；只取错误码本身，不回显响应正文（可能含敏感信息）。
      let code = "";
      try { const body = await response.json() as Record<string, unknown>; if (typeof body.error === "string") code = body.error; }
      catch { /* 非 JSON 错误体：按普通失败处理 */ }
      throw new Error(code ? `订阅授权失败（${code}）` : `订阅授权失败（HTTP ${response.status}），请重新连接`);
    }
    let json: Record<string, unknown>;
    try { json = await response.json() as Record<string, unknown>; } catch { throw new Error("订阅授权响应不是有效 JSON"); }
    if (!json || typeof json.access_token !== "string" || !json.access_token) throw new Error("订阅授权未返回访问凭据");
    const seconds = typeof json.expires_in === "number" && Number.isFinite(json.expires_in) && json.expires_in > 0 ? json.expires_in : 3600;
    return {
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : previous?.refreshToken,
      expiresAt: Date.now() + seconds * 1000,
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
    /**
     * 设备码登录（实验性）。
     *
     * 端点与 grant type 来自 xAI 自己发布的 OIDC discovery，不是从别人的构建里扒的常量。
     * 但本机没有 SuperGrok / X Premium 账号可完成一次真实授权，因此这条路径
     * 只有单元测试覆盖，没有端到端验证——面板上标注为实验性即为此意。
     *
     * 与 login() 并存而不是替换：login() 的回环回调流程有 7 条测试覆盖且能跑通，
     * 用未经实测的实现去换掉能跑的实现是倒退。
     */
    async loginDevice(id: OAuthProviderId, onPrompt: (prompt: DevicePrompt) => void): Promise<void> {
      secrets();
      deps.signal.throwIfAborted();
      if (active.has(id)) throw new Error("该订阅正在连接，请完成或取消当前登录");
      const controller = new AbortController();
      active.set(id, controller);
      bump(id);
      const version = current(id);
      const signal = AbortSignal.any([deps.signal, controller.signal, AbortSignal.timeout(300000)]);
      try {
        const spec = OAUTH_SPECS[id];
        let response: Response;
        try {
          response = await doFetch(spec.deviceCodeUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: new URLSearchParams({ client_id: spec.clientId, scope: spec.scopes.join(" ") }).toString(),
            signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
            redirect: "error",
          });
        } catch { throw new Error("设备码请求失败或已取消，请重试"); }
        if (!response.ok) { await response.body?.cancel(); throw new Error(`设备码申请失败（HTTP ${response.status}）`); }
        let json: Record<string, unknown>;
        try { json = await response.json() as Record<string, unknown>; } catch { throw new Error("设备码响应不是有效 JSON"); }
        const deviceCode = typeof json.device_code === "string" ? json.device_code : "";
        const userCode = typeof json.user_code === "string" ? json.user_code : "";
        const verificationUri = typeof json.verification_uri === "string" ? json.verification_uri : "";
        if (!deviceCode || !userCode || !verificationUri) throw new Error("设备码响应缺少必要字段");
        const lifetime = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 600;
        onPrompt({
          userCode,
          verificationUri,
          verificationUriComplete: typeof json.verification_uri_complete === "string" ? json.verification_uri_complete : undefined,
          expiresAt: Date.now() + lifetime * 1000,
        });

        let intervalMs = typeof json.interval === "number" && json.interval > 0
          ? Math.max(json.interval * 1000, DEVICE_POLL_MIN_MS)
          : DEVICE_POLL_DEFAULT_MS;
        const deadline = Date.now() + lifetime * 1000;
        for (;;) {
          signal.throwIfAborted();
          if (Date.now() > deadline) throw new Error("设备码已过期，请重新连接");
          await sleep(intervalMs);
          signal.throwIfAborted();
          try {
            const tokens = await requestTokens(id, { grant_type: DEVICE_CODE_GRANT_TYPE, device_code: deviceCode }, signal);
            await save(id, tokens, version, signal);
            return;
          } catch (error) {
            // authorization_pending / slow_down 是正常轮询状态，不是失败。
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("slow_down")) { intervalMs += DEVICE_SLOW_DOWN_STEP_MS; continue; }
            if (message.includes("authorization_pending")) continue;
            throw error;
          }
        }
      } finally {
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
