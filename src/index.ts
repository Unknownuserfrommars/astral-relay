import type { CyrenePlugin, PluginContext, PluginTurnFinishedEvent } from "./types/cyrene";
import { loadConfig } from "./config";
import { createGate, type Gate } from "./core/gate";
import { findPlan, secretKeyOf, type PlanSpec } from "./core/plans";
import { startProxy, type ProxyHandle } from "./proxy/server";
import { registerUiIpc } from "./ui/ipc";
import { createWindowManager, type WindowManager } from "./ui/window";
import { createLogger } from "./logger";
import { randomBytes } from "node:crypto";

/**
 * 模块级状态：宿主保证插件单实例，register 与 open/unregister
 * 之间用模块变量传递上下文与窗口管理器。
 */
let activeCtx: PluginContext | null = null;
let winManager: WindowManager | null = null;

/** provider id：框架会补全为 plugin:coding-plan-gate:<id>。 */
const PROVIDER_ID = "code-mode-gate";

const plugin: CyrenePlugin = {
  async register(ctx) {
    const log = createLogger(ctx);
    const config = loadConfig(ctx.storage);
    const gate: Gate = createGate({ ttlMs: config.windowTtlMs });

    // token 每次启动随机生成：写死等于没有 token。
    const token = randomBytes(24).toString("hex");

    const currentPlan = (): PlanSpec | null => {
      const planId = loadConfig(ctx.storage).planId;
      return planId ? (findPlan(planId) ?? null) : null;
    };

    const currentKey = async (): Promise<string | undefined> => {
      const plan = currentPlan();
      if (!plan || !ctx.deps.secrets) return undefined;
      try {
        return await ctx.deps.secrets.get(secretKeyOf(plan.id));
      } catch (err) {
        // 安全存储不可用（E_STORAGE_UNAVAILABLE）时降级为「未配置」，不抛。
        log.warn("读取订阅 Key 失败：", err instanceof Error ? err.message : String(err));
        return undefined;
      }
    };

    let proxy: ProxyHandle | null = null;
    try {
      proxy = await startProxy({ gate, getPlan: currentPlan, getKey: currentKey, log }, token);
      log.log(`代理已启动：${proxy.baseUrl}`);
    } catch (err) {
      // 起不来不阻断启用：面板会显示「代理未运行」，用户可停用再启用重试。
      log.error("代理启动失败：", err instanceof Error ? err.message : String(err));
    }

    /**
     * 闸门的开窗点。
     *
     * modes:["code"] + sources:["conversation"] 由宿主负责过滤——定时任务
     * （source:"scheduler"）与发帖决策（source:"moments-post"）根本不会调到这里，
     * 所以这个函数被调用本身就等价于「用户正在 Code 模式里交互」。
     *
     * 返回空串：本插件不往提示词里塞任何东西，只借这个回调拿到「本轮是什么」。
     * 宿主对 Provider 有 2 秒上限，这里必须是同步的纯内存操作。
     */
    ctx.registerPromptProvider({
      id: PROVIDER_ID,
      modes: ["code"],
      sources: ["conversation"],
      provide: () => {
        gate.open();
        return "";
      },
    });

    // 关窗：任何一轮结束都关。provider 入参没有 runId，turn:finished 才有，
    // 两者对不上，所以不认轮次——宁可关早（下一轮 provider 会重新开），
    // 也不能关晚，关晚等于窗口一直开着。
    ctx.events.on<PluginTurnFinishedEvent>("host:turn:finished", () => {
      gate.close();
    });

    registerUiIpc(ctx, { gate, storage: ctx.storage, log, getProxy: () => proxy });

    winManager = createWindowManager({ log });

    ctx.onDispose(async () => {
      gate.close();
      winManager?.close();
      winManager = null;
      if (proxy) {
        try {
          await proxy.close();
        } catch (err) {
          log.warn("关闭代理失败：", err instanceof Error ? err.message : String(err));
        }
        proxy = null;
      }
    });

    activeCtx = ctx;
    log.log("已启用（闸门默认关闭，只有 Code 模式的交互轮次才会开窗）");
  },

  async unregister() {
    // ctx.signal 已在 unregister 前取消，onDispose 负责收代理与闸门；
    // 这里只收窗口，保证幂等且远小于宿主 5 秒上限。
    winManager?.close();
    winManager = null;
    activeCtx = null;
  },

  async open() {
    if (activeCtx && winManager) {
      await winManager.open(activeCtx);
    }
  },
};

export = plugin;
