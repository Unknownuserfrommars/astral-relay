import { afterEach, describe, expect, it } from "vitest";
import { createGate } from "../src/core/gate";
import { createTurnBinding, type TurnBinding } from "../src/core/turn-binding";
import { createNonceStore, type NonceStore } from "../src/core/request-auth";
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

async function startWith(opts: {
  open: boolean;
  key?: string;
  fetchImpl?: typeof fetch;
  oauth?: () => Promise<OAuthTokens | undefined>;
  binding?: TurnBinding;
  nonces?: NonceStore;
}) {
  const gate = createGate();
  if (opts.open) gate.open();
  handle = await startProxy(
    {
      gate,
      binding: opts.binding,
      nonces: opts.nonces,
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

/**
 * 这一组是 0.5.0 的核心：装一个 ZIP 就能用，不需要用户去改宿主源码。
 * 宿主只要实现了插件 API v1 的 prompt provider（modes / sources / userText），
 * 编程套餐的「仅 Code 模式」限制就成立。
 */
describe("自包含的 Code 轮次绑定（不依赖任何宿主改动）", () => {
  const CODE_TEXT = "帮我重构 parseRoute 这个函数";
  const okResponse = (counter?: { calls: number }) => (async () => {
    if (counter) counter.calls += 1;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  /** 模拟宿主：Code 会话轮次调用 provider，插件登记本轮输入。 */
  function codeTurn(text: string): TurnBinding {
    const binding = createTurnBinding();
    binding.register({ mode: "code", source: "conversation", userText: text });
    return binding;
  }

  function post(baseUrl: string, token: string, messages: unknown) {
    return fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages }),
    });
  }

  it("登记过的 Code 输入：普通静态 token 也放行", async () => {
    const counter = { calls: 0 };
    const h = await startWith({ open: false, key: "sk-sp-abc", binding: codeTurn(CODE_TEXT), fetchImpl: okResponse(counter) });
    const res = await post(h.baseUrlFor("qwen"), TOKEN, [{ role: "user", content: CODE_TEXT }]);
    expect(res.status).toBe(200);
    expect(counter.calls).toBe(1);
  });

  it("没登记过的输入：静态 token 一律 403，且不碰上游", async () => {
    const counter = { calls: 0 };
    const h = await startWith({ open: false, binding: codeTurn(CODE_TEXT), fetchImpl: okResponse(counter) });
    const res = await post(h.baseUrlFor("qwen"), TOKEN, [{ role: "user", content: "今天天气怎么样" }]);
    expect(res.status).toBe(403);
    expect((await res.json() as any).error.message).toContain("Code 模式");
    expect(counter.calls).toBe(0);
  });

  it("完全没有 Code 轮次时，编程套餐一律 403", async () => {
    const h = await startWith({ open: false, binding: createTurnBinding(), fetchImpl: okResponse() });
    expect((await post(h.baseUrlFor("qwen"), TOKEN, [{ role: "user", content: CODE_TEXT }])).status).toBe(403);
  });

  it.each([
    ["chat", "conversation"],
    ["work", "conversation"],
    ["learn", "conversation"],
    ["code", "scheduler"],
    ["code", "moments-post"],
  ])("非 Code 交互式轮次（mode=%s source=%s）不登记，同样的话也进不来", async (mode, source) => {
    const binding = createTurnBinding();
    binding.register({ mode, source, userText: CODE_TEXT });
    const h = await startWith({ open: false, binding, fetchImpl: okResponse() });
    expect((await post(h.baseUrlFor("qwen"), TOKEN, [{ role: "user", content: CODE_TEXT }])).status).toBe(403);
  });

  it("工具续轮：assistant / tool 消息追加后仍认最后一条 user 消息", async () => {
    const h = await startWith({ open: false, key: "sk-sp-abc", binding: codeTurn(CODE_TEXT), fetchImpl: okResponse() });
    const res = await post(h.baseUrlFor("qwen"), TOKEN, [
      { role: "system", content: "你是助手" },
      { role: "user", content: CODE_TEXT },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "文件内容" },
    ]);
    expect(res.status).toBe(200);
  });

  it("多段 content 的用户消息也能匹配", async () => {
    const h = await startWith({ open: false, key: "sk-sp-abc", binding: codeTurn("看这段代码 然后改一下"), fetchImpl: okResponse() });
    const res = await post(h.baseUrlFor("qwen"), TOKEN, [
      { role: "user", content: [{ type: "text", text: "看这段代码" }, { type: "text", text: "然后改一下" }] },
    ]);
    expect(res.status).toBe(200);
  });

  it("空 messages、空请求体与非 JSON 请求体都不放行", async () => {
    const h = await startWith({ open: false, binding: codeTurn(CODE_TEXT), fetchImpl: okResponse() });
    const base = h.baseUrlFor("qwen") + "/chat/completions";
    for (const body of ["{}", '{"messages":[]}', "", "not json"]) {
      const res = await fetch(base, {
        method: "POST",
        headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
        body,
      });
      expect(res.status).toBe(403);
    }
  });

  it("绑定过期后拒绝", async () => {
    let clock = Date.now();
    const binding = createTurnBinding({ ttlMs: 1000, now: () => clock });
    binding.register({ mode: "code", source: "conversation", userText: CODE_TEXT });
    const h = await startWith({ open: false, key: "sk-sp-abc", binding, fetchImpl: okResponse() });
    expect((await post(h.baseUrlFor("qwen"), TOKEN, [{ role: "user", content: CODE_TEXT }])).status).toBe(200);
    clock += 1001;
    expect((await post(h.baseUrlFor("qwen"), TOKEN, [{ role: "user", content: CODE_TEXT }])).status).toBe(403);
  });

  it("宿主签名存在时以签名为准，内容匹配不能推翻它", async () => {
    // 登记过这段 Code 输入，但宿主明说本轮是 chat：必须拒绝
    const h = await startWith({ open: false, binding: codeTurn(CODE_TEXT), fetchImpl: okResponse() });
    const res = await post(h.baseUrlFor("qwen"), credential("qwen", "chat"), [{ role: "user", content: CODE_TEXT }]);
    expect(res.status).toBe(403);
    expect((await res.json() as any).error.message).toContain("chat");
  });

  it("通用套餐不受绑定影响，任意内容放行", async () => {
    const h = await startWith({ open: false, key: "sk-cp-abc", binding: createTurnBinding(), fetchImpl: okResponse() });
    expect((await post(h.baseUrlFor("minimax"), TOKEN, [{ role: "user", content: "随便聊聊" }])).status).toBe(200);
  });

  it("绑定不替代 token：token 不对仍然 401", async () => {
    const h = await startWith({ open: false, binding: codeTurn(CODE_TEXT), fetchImpl: okResponse() });
    expect((await post(h.baseUrlFor("qwen"), "wrong-token-000000000", [{ role: "user", content: CODE_TEXT }])).status).toBe(401);
  });
});

describe("签名凭据的 nonce 首用计时", () => {
  it("首用窗口内可重复使用，超窗后 401", async () => {
    let clock = Date.now();
    const nonces = createNonceStore({ windowMs: 1000, now: () => clock });
    const h = await startWith({ open: false, key: "sk-sp-abc", nonces, fetchImpl: (async () => new Response("{}")) as typeof fetch });
    const key = credential("qwen");
    expect((await call(h.baseUrlFor("qwen"), key)).status).toBe(200);
    clock += 500;
    expect((await call(h.baseUrlFor("qwen"), key)).status).toBe(200);
    clock += 501;
    const res = await call(h.baseUrlFor("qwen"), key);
    expect(res.status).toBe(401);
    expect((await res.json() as any).error.message).toContain("时限");
  });
});
