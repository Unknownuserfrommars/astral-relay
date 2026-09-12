import { afterEach, describe, expect, it } from "vitest";
import { createGate } from "../src/core/gate";
import { parseRoute, startProxy, type ProxyHandle } from "../src/proxy/server";
import { findProvider, resolveBaseUrl } from "../src/core/providers";
import { silentLog } from "./helpers";
import { createHmac } from "node:crypto";
import type { OAuthTokens } from "../src/oauth/manager";

const TOKEN = "test-token-0123456789";
function credential(provider: string, mode = "code", source = "conversation", issuedAt = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ provider, mode, source, issuedAt, nonce: "test-run" })).toString("base64url");
  const signed = `ar1.${payload}`;
  return `${signed}.${createHmac("sha256", TOKEN).update(signed).digest("hex")}`;
}
let handle: ProxyHandle | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
});

async function startWith(opts: { open: boolean; key?: string; fetchImpl?: typeof fetch; oauth?: () => Promise<OAuthTokens | undefined> }) {
  const gate = createGate();
  if (opts.open) gate.open();
  handle = await startProxy(
    {
      gate,
      resolveUpstream: (provider) => resolveBaseUrl(provider, undefined),
      getKey: async () => (opts.key === undefined ? "sk-sp-secret" : opts.key),
      log: silentLog,
      fetchImpl: opts.fetchImpl,
      getOAuthTokens: opts.oauth,
    },
    TOKEN,
  );
  return handle;
}

function call(baseUrl: string, token: string) {
  return fetch(baseUrl + "/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
  });
}

function okFetch(seen: { url: string; auth: string | null }) {
  return (async (url: any, init: any) => {
    seen.url = String(url);
    seen.auth = new Headers(init.headers).get("authorization");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("路由解析", () => {
  it("解析 /p/<厂商>/<剩余>", () => {
    expect(parseRoute("/p/qwen/v1/chat/completions")).toEqual({
      providerId: "qwen",
      rest: "/v1/chat/completions",
    });
  });
  it("非 /p/ 前缀返回 null", () => {
    expect(parseRoute("/v1/chat/completions")).toBeNull();
    expect(parseRoute("/admin")).toBeNull();
  });
});

describe("OAuth native transports", () => {
  const tokens = { accessToken: "private-oauth-access", expiresAt: Date.now() + 3600000, accountId: "account-123" };
  const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
  const post = (base: string, key: string, body: unknown, path = "/responses") => fetch(base + path, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });

  it("grok accepts all modes and legacy host tokens while still requiring authentication", async () => {
    const id = "grok";
    let calls = 0;
    const h = await startWith({ open: false, oauth: async () => tokens, fetchImpl: (async () => {
      calls += 1;
      return new Response('{"choices":[]}');
    }) as typeof fetch });
    const path = "/chat/completions";
    for (const mode of ["chat", "work", "learn", "code"]) {
      const response = await post(h.baseUrlFor(id), credential(id, mode), {}, path);
      expect(response.status).toBe(200);
      await response.text();
    }
    for (const key of [TOKEN, credential(id, "work", "scheduler")]) {
      const response = await post(h.baseUrlFor(id), key, {}, path);
      expect(response.status).toBe(200);
      await response.text();
    }
    expect((await post(h.baseUrlFor(id), "invalid-local-token", {}, path)).status).toBe(401);
    expect(calls).toBe(6);
  });

  it("Grok forwards tools and tool messages with subscription headers", async () => {
    let seen: any;
    const h = await startWith({ open: false, oauth: async () => tokens, fetchImpl: (async (url, init) => {
      seen = { url, init };
      return new Response('{"choices":[]}');
    }) as typeof fetch });
    const body = { model: "grok-test", messages: [{ role: "tool", tool_call_id: "c1", content: "result" }], tools: [{ type: "function", function: { name: "test" } }] };
    expect((await post(h.baseUrlFor("grok"), credential("grok"), body, "/chat/completions")).status).toBe(200);
    expect(seen.url).toBe("https://api.x.ai/v1/chat/completions");
    // 不伪装官方 CLI：UA 自报家门，且不得再出现 grok-cli 伪装头
    expect(seen.init.headers["user-agent"]).toContain("astral-relay");
    expect(JSON.stringify(seen.init.headers)).not.toContain("grok-cli");
    expect(JSON.parse(seen.init.body.toString())).toEqual(body);
  });

  it("streams bytes before upstream completes", async () => {
    let finish!: () => void;
    let closed = false;
    const h = await startWith({ open: false, oauth: async () => tokens, fetchImpl: (async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\n")); finish = () => { if (!closed) { closed = true; controller.close(); } }; },
    }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch });
    try {
      const response = await post(h.baseUrlFor("grok"), credential("grok"), { stream: true }, "/chat/completions");
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("first");
      finish();
      expect((await reader.read()).done).toBe(true);
    } finally { finish?.(); }
  });

  it("未连接 OAuth 时直接 503，不发任何上游请求", async () => {
    // 注：移除 Codex 后，protocol 不匹配的 400 分支在 server.ts 里已无厂商可覆盖
    //（Grok 是唯一 OAuth 厂商且 protocol 为 openai）。该分支仍保留给将来的 responses 厂商。
    const h = await startWith({ open: false });
    expect((await post(h.baseUrlFor("grok"), credential("grok"), {}, "/chat/completions")).status).toBe(503);
  });
});

describe("按厂商分类放行", () => {
  it("编程套餐：闸门关闭时 403，并说明原因", async () => {
    const h = await startWith({ open: false });
    const res = await call(h.baseUrlFor("qwen"), TOKEN);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Code 模式");
    expect(body.error.message).toContain("通义千问");
  });

  it("通用套餐：闸门关闭也放行（条款没有这条限制）", async () => {
    const seen = { url: "", auth: null as string | null };
    const h = await startWith({ open: false, key: "sk-cp-abc", fetchImpl: okFetch(seen) });
    const res = await call(h.baseUrlFor("minimax"), TOKEN);
    expect(res.status).toBe(200);
    expect(seen.url).toBe("https://api.minimax.io/v1/chat/completions");
    expect(seen.auth).toBe("Bearer sk-cp-abc");
  });

  it("编程套餐：开窗后转发到 Coding Plan 专属端点", async () => {
    const seen = { url: "", auth: null as string | null };
    const h = await startWith({ open: true, key: "sk-sp-abc", fetchImpl: okFetch(seen) });
    const res = await call(h.baseUrlFor("tencent"), credential("tencent"));
    expect(res.status).toBe(200);
    expect(seen.url).toBe("https://api.lkeap.cloud.tencent.com/coding/v3/chat/completions");
    expect(seen.auth).toBe("Bearer sk-sp-abc");
  });

  it("token 不对时 401", async () => {
    const h = await startWith({ open: true });
    const res = await call(h.baseUrlFor("qwen"), "wrong-token-000000000");
    expect(res.status).toBe(401);
  });

  it("通用厂商 token 不对时也要 401（不因为不过闸门就放行）", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const h = await startWith({ open: false, key: "sk-cp-abc", fetchImpl: fakeFetch });
    const res = await call(h.baseUrlFor("minimax"), "wrong-token-000000000");
    expect(res.status).toBe(401);
    expect(called).toBe(false);
  });
  it("未启用的厂商（Copilot）一律 404", async () => {
    const h = await startWith({ open: true });
    expect(findProvider("copilot")!.available).toBe(false);
    const res = await call(h.baseUrlFor("copilot"), TOKEN);
    expect(res.status).toBe(404);
  });

  it("未配置 Key 时 503，不把空 Key 发给上游", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const h = await startWith({ open: true, key: "", fetchImpl: fakeFetch });
    const res = await call(h.baseUrlFor("qwen"), credential("qwen"));
    expect(res.status).toBe(503);
    expect(called).toBe(false);
  });

  it("未知路径 404", async () => {
    const h = await startWith({ open: true });
    const res = await fetch("http://127.0.0.1:" + h.port + "/admin", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("Code 活动期间，并发 Chat/Work/Learn 与后台请求仍被拒绝", async () => {
    let calls = 0;
    const h = await startWith({ open: true, fetchImpl: (async () => {
      calls += 1;
      return new Response("{}");
    }) as typeof fetch });
    const credentials = [credential("qwen"), credential("qwen", "chat"), credential("qwen", "work"),
      credential("qwen", "learn"), credential("qwen", "code", "scheduler"),
      credential("qwen", "code", "moments-post"), TOKEN];
    const responses = await Promise.all(credentials.map((key) => call(h.baseUrlFor("qwen"), key)));
    expect(responses.map((r) => r.status)).toEqual([200, 403, 403, 403, 403, 403, 403]);
    expect(calls).toBe(1);
  });

  it("有效 Code 请求不依赖全局活动窗口，另一轮结束不会使它失效", async () => {
    const h = await startWith({ open: false, fetchImpl: (async () => new Response("{}")) as typeof fetch });
    expect((await call(h.baseUrlFor("qwen"), credential("qwen"))).status).toBe(200);
  });

  it("伪造、过期、未来与其它厂商的模式凭据均拒绝", async () => {
    const h = await startWith({ open: true });
    for (const key of [credential("tencent"), credential("qwen", "code", "conversation", Date.now() - 86400000),
      credential("qwen", "code", "conversation", Date.now() + 60000), credential("qwen") + "x", "ar1.invalid.invalid"]) {
      expect((await call(h.baseUrlFor("qwen"), key)).status).toBe(401);
    }
  });

  it.each(["chat", "work", "learn", "code"])("通用套餐接受 %s 模式签名", async (mode) => {
    const h = await startWith({ open: false, fetchImpl: (async () => new Response("{}")) as typeof fetch });
    expect((await call(h.baseUrlFor("minimax"), credential("minimax", mode))).status).toBe(200);
  });
});
