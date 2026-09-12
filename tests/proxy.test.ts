import { afterEach, describe, expect, it } from "vitest";
import { createGate } from "../src/core/gate";
import { startProxy, type ProxyHandle } from "../src/proxy/server";
import { PLANS } from "../src/core/plans";
import { silentLog } from "./helpers";

const TOKEN = "test-token-0123456789";
const PLAN = PLANS[0];

let handle: ProxyHandle | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
});

async function startWith(opts: { open: boolean; key?: string; fetchImpl?: typeof fetch }) {
  const gate = createGate();
  if (opts.open) gate.open();
  handle = await startProxy(
    {
      gate,
      getPlan: () => PLAN,
      getKey: async () => (opts.key === undefined ? "sk-sp-secret" : opts.key),
      log: silentLog,
      fetchImpl: opts.fetchImpl,
    },
    TOKEN,
  );
  return handle;
}

function call(baseUrl: string, token: string) {
  return fetch(baseUrl + "/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen3.7-plus", messages: [{ role: "user", content: "hi" }] }),
  });
}

describe("受闸门约束的代理", () => {
  it("闸门关闭时回 403，并在文案里说明原因", async () => {
    const h = await startWith({ open: false });
    const res = await call(h.baseUrl, TOKEN);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Code 模式");
  });

  it("token 不对时回 401，而不是 403", async () => {
    const h = await startWith({ open: true });
    const res = await call(h.baseUrl, "wrong-token-000000000");
    expect(res.status).toBe(401);
  });

  it("开窗时转发到上游，并注入订阅 Key", async () => {
    const seen: { url: string; auth: string | null } = { url: "", auth: null };
    const fakeFetch = (async (url: any, init: any) => {
      seen.url = String(url);
      seen.auth = new Headers(init.headers).get("authorization");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const h = await startWith({ open: true, key: "sk-sp-abc", fetchImpl: fakeFetch });
    const res = await call(h.baseUrl, TOKEN);
    expect(res.status).toBe(200);
    expect(seen.url).toBe("https://coding.dashscope.aliyuncs.com/v1/chat/completions");
    // 注入的是订阅 Key，不是代理 token
    expect(seen.auth).toBe("Bearer sk-sp-abc");
  });

  it("未配置 Key 时回 503，不把空 Key 发给上游", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const h = await startWith({ open: true, key: "", fetchImpl: fakeFetch });
    const res = await call(h.baseUrl, TOKEN);
    expect(res.status).toBe(503);
    expect(called).toBe(false);
  });

  it("非 /v1 路径一律 404", async () => {
    const h = await startWith({ open: true });
    const res = await fetch("http://127.0.0.1:" + h.port + "/admin", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
