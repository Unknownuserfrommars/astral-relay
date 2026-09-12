import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { createMockContext } from "./helpers";

/** 产物路径：vitest 工作目录 = 项目根。 */
const BUILT_ENTRY = path.resolve(process.cwd(), "dist/plugin/coding-plan-gate/index.cjs");

/** 直接加载构建产物做契约测试——测的就是要发布的东西。 */
function loadPlugin(): { register: (ctx: unknown) => Promise<void>; unregister: () => Promise<void> } {
  expect(existsSync(BUILT_ENTRY), "产物不存在，先运行 npm run build").toBe(true);
  const require = createRequire(path.join(process.cwd(), "package.json"));
  return require("./dist/plugin/coding-plan-gate/index.cjs");
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
    // 这三条是整个插件的合规基础，任何一条被改掉都必须让测试红
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

  it("get-state 不回传订阅 Key 本身，只回传是否已配置", async () => {
    const ctx = createMockContext();
    await plugin.register(ctx);
    ctx.ipcChannels.get("save-config")!({ planId: "qwen" });
    await ctx.ipcChannels.get("save-key")!({ planId: "qwen", key: "sk-sp-super-secret" });

    const state = (await ctx.ipcChannels.get("get-state")!()) as Record<string, unknown>;
    expect(state.keyConfigured).toBe(true);
    // 整个状态对象里不允许出现 Key 的任何片段
    expect(JSON.stringify(state)).not.toContain("super-secret");
    await ctx.dispose();
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
