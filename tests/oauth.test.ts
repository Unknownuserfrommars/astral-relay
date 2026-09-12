import { describe, expect, it, vi } from "vitest";
import { createOAuthManager, oauthSecretKey } from "../src/oauth/manager";
import { OAUTH_SPECS } from "../src/oauth/specs";
import { prepareCallback } from "../src/oauth/callback";
import { createMockContext } from "./helpers";
import { createHash } from "node:crypto";

describe("OAuth lifecycle", () => {
  it.each(["codex", "grok"] as const)("%s binds callback before browser, uses PKCE and secure storage", async (id) => {
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
    ctx.secretStore.set(oauthSecretKey("codex"), JSON.stringify({ accessToken: "expired", refreshToken: "refresh-original", expiresAt: 1, accountId: "account-original" }));
    const doFetch = vi.fn(async () => new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 })));
    const manager = createOAuthManager({ secrets: ctx.deps.secrets, signal: ctx.signal, fetchImpl: doFetch });
    const results = await Promise.all([manager.getTokens("codex"), manager.getTokens("codex")]);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ accessToken: "new-access", refreshToken: "refresh-original", accountId: "account-original" });
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
    await expect(manager.login("codex")).rejects.toThrow("安全存储");
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
