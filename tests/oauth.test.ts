import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOAuthManager, oauthSecretKey } from "../src/oauth/manager";
import { OAUTH_SPECS } from "../src/oauth/specs";
import { prepareCallback } from "../src/oauth/callback";
import { createMockContext } from "./helpers";
import { createHash } from "node:crypto";

describe("OAuth lifecycle", () => {
  it("grok binds callback before browser, uses PKCE and secure storage", async () => {
    const id = "grok" as const;
    const ctx = createMockContext();
    let prepared = false;
    let challenge = "";
    const doFetch = vi.fn(async (url, init) => {
      expect(url).toBe(OAUTH_SPECS[id].tokenUrl);
      const params = new URLSearchParams(String(init!.body));
      expect(params.get("code")).toBe("callback-code");
      expect(createHash("sha256").update(params.get("code_verifier")!).digest("base64url")).toBe(challenge);
      expect(init!.redirect).toBe("error");
      return new Response(JSON.stringify({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600 }));
    }) as unknown as typeof fetch;
    const manager = createOAuthManager({ secrets: ctx.deps.secrets, signal: ctx.signal, fetchImpl: doFetch,
      callback: async () => { prepared = true; return { code: Promise.resolve("callback-code"), close: () => {}, port: 12345 }; },
      openExternal: async (href) => {
        expect(prepared).toBe(true);
        const url = new URL(href);
        expect(url.origin).toBe(new URL(OAUTH_SPECS[id].authorizeUrl).origin);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("state")!.length).toBeGreaterThan(20);
        challenge = url.searchParams.get("code_challenge")!;
      },
    });
    await manager.login(id);
    expect(ctx.secretStore.get(oauthSecretKey(id))).toContain("private-access");
    expect(JSON.stringify(await manager.status(id))).not.toContain("private");
    expect(await manager.status(id)).toMatchObject({ connected: true, connecting: false });
    await manager.logout(id);
    expect(await manager.getTokens(id)).toBeUndefined();
    await ctx.dispose();
  });

  it("refreshes once for concurrent requests, preserves refresh token and account ID", async () => {
    const ctx = createMockContext();
    ctx.secretStore.set(oauthSecretKey("grok"), JSON.stringify({ accessToken: "expired", refreshToken: "refresh-original", expiresAt: 1 }));
    const doFetch = vi.fn(async () => new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 })));
    const manager = createOAuthManager({ secrets: ctx.deps.secrets, signal: ctx.signal, fetchImpl: doFetch });
    const results = await Promise.all([manager.getTokens("grok"), manager.getTokens("grok")]);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ accessToken: "new-access", refreshToken: "refresh-original" });
    expect(results[0]).toEqual(results[1]);
  });

  it("logout during refresh cannot resurrect credentials", async () => {
    const ctx = createMockContext();
    ctx.secretStore.set(oauthSecretKey("grok"), JSON.stringify({ accessToken: "expired", refreshToken: "refresh", expiresAt: 1 }));
    let resolve!: (value: Response) => void;
    const doFetch = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    const manager = createOAuthManager({ secrets: ctx.deps.secrets, signal: ctx.signal, fetchImpl: doFetch });
    const pending = manager.getTokens("grok");
    await vi.waitFor(() => expect(doFetch).toHaveBeenCalledOnce());
    await manager.logout("grok");
    const rejected = expect(pending).rejects.toThrow();
    resolve(new Response(JSON.stringify({ access_token: "late-token" })));
    await rejected;
    expect(ctx.secretStore.has(oauthSecretKey("grok"))).toBe(false);
  });

  it("no secure storage means no browser or token exchange", async () => {
    const openExternal = vi.fn();
    const fetchImpl = vi.fn();
    const manager = createOAuthManager({ signal: new AbortController().signal, openExternal, fetchImpl });
    await expect(manager.login("grok")).rejects.toThrow("安全存储");
    expect(openExternal).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("token endpoint errors never expose response secrets", async () => {
    const ctx = createMockContext();
    ctx.secretStore.set(oauthSecretKey("grok"), JSON.stringify({ accessToken: "expired", refreshToken: "refresh", expiresAt: 1 }));
    const manager = createOAuthManager({ signal: ctx.signal, secrets: ctx.deps.secrets,
      fetchImpl: async () => new Response("private-provider-error", { status: 400 }) });
    await expect(manager.getTokens("grok")).rejects.toThrow("HTTP 400");
    await expect(manager.getTokens("grok")).rejects.not.toThrow("private-provider-error");
  });
});

describe("设备码登录（实验性）", () => {
  let waited: number[] = [];
  beforeEach(() => { waited = []; });
  const deviceResponse = {
    device_code: "device-secret", user_code: "ABCD-1234",
    verification_uri: "https://x.ai/device", verification_uri_complete: "https://x.ai/device?code=ABCD-1234",
    expires_in: 600, interval: 1,
  };

  it("拿到设备码后轮询，pending 不算失败，成功后写入安全存储", async () => {
    const ctx = createMockContext();
    let calls = 0;
    const doFetch = vi.fn(async (url, init) => {
      calls += 1;
      if (String(url).endsWith("/device/code")) {
        // 设备码申请必须带 client_id 与 scope
        const params = new URLSearchParams(String(init!.body));
        expect(params.get("client_id")).toBe(OAUTH_SPECS.grok.clientId);
        expect(params.get("scope")).toContain("grok-cli:access");
        return new Response(JSON.stringify(deviceResponse));
      }
      // 第一次轮询回 authorization_pending，第二次才发 token
      const params = new URLSearchParams(String(init!.body));
      expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
      expect(params.get("device_code")).toBe("device-secret");
      if (calls === 2) return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
      return new Response(JSON.stringify({ access_token: "device-access", refresh_token: "device-refresh", expires_in: 3600 }));
    }) as unknown as typeof fetch;

    let prompt: any;
    const manager = createOAuthManager({ secrets: ctx.deps.secrets, signal: ctx.signal, fetchImpl: doFetch, sleep: async (ms) => { waited.push(ms); } });
    await manager.loginDevice("grok", (value) => { prompt = value; });

    // 面板要拿到用户码与可直接打开的链接
    expect(prompt.userCode).toBe("ABCD-1234");
    expect(prompt.verificationUriComplete).toContain("ABCD-1234");
    expect(calls).toBe(3);
    // 轮询节奏取自服务端 interval（1s），不是写死的默认值
    expect(waited).toEqual([1000, 1000]);
    expect(ctx.secretStore.get(oauthSecretKey("grok"))).toContain("device-access");
    // 状态里不得回显任何凭据
    expect(JSON.stringify(await manager.status("grok"))).not.toContain("device-access");
    await ctx.dispose();
  });

  it("设备码响应缺字段时报错，且不写入任何凭据", async () => {
    const ctx = createMockContext();
    const doFetch = vi.fn(async () => new Response(JSON.stringify({ user_code: "X" }))) as unknown as typeof fetch;
    const manager = createOAuthManager({ secrets: ctx.deps.secrets, signal: ctx.signal, fetchImpl: doFetch, sleep: async (ms) => { waited.push(ms); } });
    await expect(manager.loginDevice("grok", () => {})).rejects.toThrow("缺少必要字段");
    expect(ctx.secretStore.has(oauthSecretKey("grok"))).toBe(false);
    await ctx.dispose();
  });

  it("轮询期间取消会中止，不落盘", async () => {
    const ctx = createMockContext();
    const doFetch = vi.fn(async (url) => String(url).endsWith("/device/code")
      ? new Response(JSON.stringify(deviceResponse))
      : new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 })) as unknown as typeof fetch;
    const manager = createOAuthManager({ secrets: ctx.deps.secrets, signal: ctx.signal, fetchImpl: doFetch, sleep: async (ms) => { waited.push(ms); } });
    const pending = manager.loginDevice("grok", () => { manager.cancel("grok"); });
    await expect(pending).rejects.toThrow();
    expect(ctx.secretStore.has(oauthSecretKey("grok"))).toBe(false);
    await ctx.dispose();
  });

  it("token 端点错误码不回显响应正文", async () => {
    const ctx = createMockContext();
    const doFetch = vi.fn(async (url) => String(url).endsWith("/device/code")
      ? new Response(JSON.stringify(deviceResponse))
      : new Response(JSON.stringify({ error: "access_denied", error_description: "private-detail" }), { status: 400 })) as unknown as typeof fetch;
    const manager = createOAuthManager({ secrets: ctx.deps.secrets, signal: ctx.signal, fetchImpl: doFetch, sleep: async (ms) => { waited.push(ms); } });
    await expect(manager.loginDevice("grok", () => {})).rejects.toThrow("access_denied");
    await expect(manager.loginDevice("grok", () => {})).rejects.not.toThrow("private-detail");
    await ctx.dispose();
  });
});

describe("loopback OAuth callback", () => {
  it("ignores wrong state and unrelated requests, then accepts matching code", async () => {
    const controller = new AbortController();
    const callback = await prepareCallback({ ...OAUTH_SPECS.grok, port: 0 }, "expected-state", controller.signal);
    const base = `http://127.0.0.1:${callback.port}`;
    try {
      expect((await fetch(base + "/other")).status).toBe(404);
      expect((await fetch(base + "/callback?state=wrong&code=x")).status).toBe(400);
      const response = await fetch(base + "/callback?state=expected-state&code=accepted");
      expect(response.status).toBe(200);
      await response.text();
      expect(await callback.code).toBe("accepted");
    } finally { callback.close(); }
  });
  it("cancellation rejects waiting login and frees the listener", async () => {
    const controller = new AbortController();
    const callback = await prepareCallback({ ...OAUTH_SPECS.grok, port: 0 }, "state", controller.signal);
    controller.abort();
    await expect(callback.code).rejects.toThrow("取消");
    const replacement = await prepareCallback({ ...OAUTH_SPECS.grok, port: callback.port }, "new", new AbortController().signal);
    replacement.close();
  });
});
