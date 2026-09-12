import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { createMockContext } from "./helpers";

/** 产物路径：vitest 工作目录 = 项目根。 */
const BUILT_ENTRY = path.resolve(process.cwd(), "dist/plugin/astral-relay/index.cjs");

/** 直接加载构建产物做契约测试——测的就是要发布的东西。 */
function loadPlugin(): { register: (ctx: unknown) => Promise<void>; unregister: () => Promise<void> } {
  expect(existsSync(BUILT_ENTRY), "产物不存在，先运行 npm run build").toBe(true);
  const require = createRequire(path.join(process.cwd(), "package.json"));
  return require("./dist/plugin/astral-relay/index.cjs");
}

describe("插件契约（构建产物）", () => {
  let plugin: ReturnType<typeof loadPlugin>;

  beforeAll(() => {
    plugin = loadPlugin();
  });

  it("只注册 1 个 provider，且被限定为 code 模式 + conversation 场景", async () => {
    const ctx = createMockContext();
    await plugin.register(ctx);

    expect(ctx.promptProviders).toHaveLength(1);
    const provider = ctx.promptProviders[0];
    // These filters affect only the panel activity indicator, not authorization.
    expect(provider.modes).toEqual(["code"]);
    expect(provider.sources).toEqual(["conversation"]);
    expect(typeof provider.provide).toBe("function");

    await ctx.dispose();
  });

  it("provider 不往提示词里塞内容，只用于开窗", async () => {
    const ctx = createMockContext();
    await plugin.register(ctx);
    const output = await ctx.promptProviders[0].provide({
      source: "conversation",
      mode: "code",
      userText: "写个函数",
      signal: new AbortController().signal,
    });
    expect(output).toBe("");
    await ctx.dispose();
  });

  it("注册 4 个面板 IPC，并订阅 turn:finished 用于关窗", async () => {
    const ctx = createMockContext();
    await plugin.register(ctx);
    for (const channel of ["get-state", "save-config", "save-key", "clear-key"]) {
      expect(ctx.ipcChannels.has(channel)).toBe(true);
    }
    expect(ctx.subscriptions.some((s) => s.event === "host:turn:finished")).toBe(true);
    await ctx.dispose();
  });

  it("get-state 列出全部厂商，并标出各自 kind 与可用性", async () => {
    const ctx = createMockContext();
    await plugin.register(ctx);
    const state = (await ctx.ipcChannels.get("get-state")!()) as {
      providers: Array<{ id: string; kind: string; available: boolean; baseUrl: string }>;
    };
    const byId = Object.fromEntries(state.providers.map((p) => [p.id, p]));
    expect(byId.qwen.kind).toBe("coding-only");
    expect(byId.minimax.kind).toBe("general");
    expect(byId.copilot.available).toBe(false);
    // 未启用的厂商不给 baseUrl，免得用户填进档案后一直 404
    expect(byId.copilot.baseUrl).toBe("");
    expect(byId.qwen.baseUrl).toContain("/p/qwen/v1");
    await ctx.dispose();
  });

  it("get-state 不回传订阅 Key 本身，只回传是否已配置", async () => {
    const ctx = createMockContext();
    await plugin.register(ctx);
    await ctx.ipcChannels.get("save-key")!({ providerId: "qwen", key: "sk-sp-super-secret" });

    const state = (await ctx.ipcChannels.get("get-state")!()) as Record<string, unknown>;
    // 整个状态对象里不允许出现 Key 的任何片段
    expect(JSON.stringify(state)).not.toContain("super-secret");
    const providers = (state.providers as Array<{ id: string; keyConfigured: boolean }>);
    expect(providers.find((p) => p.id === "qwen")!.keyConfigured).toBe(true);
    await ctx.dispose();
  });

  it("拒绝给未实现的厂商存 Key", async () => {
    const ctx = createMockContext();
    await plugin.register(ctx);
    const result = (await ctx.ipcChannels.get("save-key")!({
      providerId: "copilot",
      key: "whatever",
    })) as { ok: boolean };
    expect(result.ok).toBe(false);
    await ctx.dispose();
  });

  it("OAuth 通过专用 IPC 连接，面板状态不暴露 token 或账号", async () => {
    const ctx = createMockContext();
    ctx.secretStore.set("astral_relay_oauth_grok", JSON.stringify({ accessToken: "private-access", refreshToken: "private-refresh", expiresAt: Date.now() + 3600000 }));
    await plugin.register(ctx);
    try {
      for (const name of ["oauth-login", "oauth-cancel", "oauth-logout", "oauth-models"]) expect(ctx.ipcChannels.has(name)).toBe(true);
      const state = await ctx.ipcChannels.get("get-state")!() as any;
      const grok = state.providers.find((p: any) => p.id === "grok");
      expect(grok).toMatchObject({ auth: "oauth", protocol: "openai", oauth: { connected: true } });
      expect(JSON.stringify(state)).not.toContain("private-");
      expect(await ctx.ipcChannels.get("save-key")!({ providerId: "grok", key: "wrong" })).toMatchObject({ ok: false });
      expect(await ctx.ipcChannels.get("oauth-login")!("claude")).toMatchObject({ ok: false });
      await ctx.ipcChannels.get("oauth-logout")!("grok");
      expect(ctx.secretStore.has("astral_relay_oauth_grok")).toBe(false);
    } finally { await ctx.dispose(); }
  });

  it("闸门初始为关闭：启用插件不等于开窗", async () => {
    const ctx = createMockContext();
    await plugin.register(ctx);
    const state = (await ctx.ipcChannels.get("get-state")!()) as { gate: { open: boolean } };
    expect(state.gate.open).toBe(false);
    await ctx.dispose();
  });

  it("turn:finished 关窗：provider 开窗后收到轮次结束即关闭", async () => {
    const ctx = createMockContext();
    await plugin.register(ctx);
    await ctx.promptProviders[0].provide({
      source: "conversation",
      mode: "code",
      userText: "hi",
      signal: new AbortController().signal,
    });
    let state = (await ctx.ipcChannels.get("get-state")!()) as { gate: { open: boolean } };
    expect(state.gate.open).toBe(true);

    const sub = ctx.subscriptions.find((s) => s.event === "host:turn:finished")!;
    await sub.listener({ source: "desktop", mode: "code", runId: "r1", status: "success" });

    state = (await ctx.ipcChannels.get("get-state")!()) as { gate: { open: boolean } };
    expect(state.gate.open).toBe(false);
    await ctx.dispose();
  });

  it("unregister 幂等且可重复调用", async () => {
    const ctx = createMockContext();
    await plugin.register(ctx);
    await plugin.unregister();
    await plugin.unregister();
    await ctx.dispose();
  });
});
