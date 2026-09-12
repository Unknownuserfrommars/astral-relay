/**
 * 订阅厂商目录。
 *
 * 同时记录套餐范围与技术接入方式。OAuth 兼容接入不等于厂商公开 API 保证；
 * Grok 走 xAI 共享 OAuth 客户端（xAI 文档明示第三方工具可用订阅额度），支持全部 Cyrene 模式。
 *
 * kind 决定闸门是否介入：
 *  - "general"      插件不增加模式限制，全模式可用；不代表厂商公开 API 保证；
 *  - "coding-only"  条款明确「仅限编程工具的交互式使用」，必须过闸门，
 *                   只有 Code 模式的会话轮次放行；
 *  - "agent-cli"    需要驱动厂商自己的本地 CLI（不是 HTTP 直连），当前未实现。
 *
 * 明确不收录，且不接受 PR 添加：
 *  - ChatGPT / Codex 订阅 —— chatgpt.com/backend-api/codex 是私有后端，没有面向第三方的公开契约
 *    （openai/codex#36886 至今无官方答复）；需要 Codex 时请改用宿主 MCP 接入本机 codex CLI；
 *  - Z.ai GLM Coding Plan —— 条款点名禁止用于「自有应用、机器人、网站、SaaS」，
 *    且支持工具是封闭列表，Cyrene 不在其中；
 *  - Anthropic Claude 订阅 —— 第三方产品不得提供 claude.ai 登录或额度；
 *  - Google Gemini —— 官方文档点名禁止第三方软件复用 Gemini CLI 的 OAuth。
 */

export type ProviderKind = "general" | "coding-only" | "agent-cli";

export interface ProviderRegion {
  id: string;
  label: string;
  baseUrl: string;
}

export interface ProviderSpec {
  id: string;
  label: string;
  kind: ProviderKind;
  /** 实验性：功能已实现但未经端到端实测，面板需明确标注。 */
  experimental?: boolean;
  /** 可用性：false 表示目录里有定义但本版本不提供（面板置灰并说明原因）。 */
  available: boolean;
  auth?: "key" | "oauth";
  protocol?: "openai" | "responses";
  /** OpenAI 兼容端点；多区域厂商用 regions 覆盖。 */
  baseUrl?: string;
  regions?: ProviderRegion[];
  /** 套餐 Key 前缀，仅用于面板粗校验，防止贴成按量付费 Key。 */
  keyPrefix?: string;
  /** 条款出处，面板直接展示，方便用户自己复核。 */
  termsUrl: string;
  /** 面板上的一句话说明（含限制）。 */
  note: string;
}

export const PROVIDERS: readonly ProviderSpec[] = [
  {
    id: "grok", label: "xAI Grok（订阅 OAuth）", kind: "general", available: true, experimental: true,
    auth: "oauth", protocol: "openai", baseUrl: "https://api.x.ai/v1",
    termsUrl: "https://x.ai/news/grok-opencode",
    note: "使用 Grok OAuth 连接订阅；支持 Chat、Work、Learn、Code 全模式。",
  },
  {
    id: "minimax",
    label: "MiniMax Token Plan",
    kind: "general",
    available: true,
    regions: [
      { id: "global", label: "国际站", baseUrl: "https://api.minimax.io/v1" },
      { id: "cn", label: "中国大陆", baseUrl: "https://api.minimaxi.com/v1" },
    ],
    keyPrefix: "sk-cp-",
    termsUrl: "https://platform.minimax.io/docs/token-plan/intro",
    note: "订阅 Key 可用于任意 OpenAI 兼容工具，未把场景限定在编程工具，因此全模式可用。",
  },
  {
    id: "qwen",
    label: "通义千问 Coding Plan",
    kind: "coding-only",
    available: true,
    baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
    keyPrefix: "sk-sp-",
    termsUrl: "https://help.aliyun.com/zh/model-studio/coding-plan",
    note: "条款：仅限在编程工具中交互式使用，禁止自动化脚本与应用后端。只在 Code 模式放行。",
  },
  {
    id: "tencent",
    label: "腾讯云 Coding Plan",
    kind: "coding-only",
    available: true,
    // Coding Plan 专属端点，与按量付费的 api.lkeap.cloud.tencent.com/v1 不互通，
    // 官方文档明确写了「请勿混用」。填错会直接鉴权失败。
    baseUrl: "https://api.lkeap.cloud.tencent.com/coding/v3",
    keyPrefix: "sk-sp-",
    termsUrl: "https://cloud.tencent.com/document/product/1823/130092",
    note: "条款：仅限指定编程工具的交互式场景，禁止批量与后端调用。只在 Code 模式放行。",
  },
  {
    id: "copilot",
    label: "GitHub Copilot（本地 CLI）",
    kind: "agent-cli",
    // 未实现：Copilot 的 SDK 依赖 koffi 原生模块并自带 CLI 二进制，
    // 与「插件自包含 + 零运行时依赖」冲突。可行路线是驱动用户自己安装并登录的
    // copilot CLI（copilot --headless --port N，走 JSON-RPC），
    // 但本机没装 CLI，协议没法实测，不带未验证的实现上线。
    available: false,
    termsUrl: "https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate",
    note: "计划中：驱动你自己安装并登录的 copilot CLI。当前版本未实现，面板置灰。",
  },
];

export function findProvider(id: string): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** 该厂商是否必须过闸门（只有编程套餐需要）。 */
export function requiresCodeMode(provider: ProviderSpec): boolean {
  return provider.kind === "coding-only";
}

/** 解析实际使用的上游端点：多区域厂商按 regionId 选，缺省取第一个。 */
export function resolveBaseUrl(provider: ProviderSpec, regionId?: string): string | undefined {
  if (provider.regions && provider.regions.length > 0) {
    const picked = provider.regions.find((r) => r.id === regionId);
    return (picked ?? provider.regions[0]).baseUrl;
  }
  return provider.baseUrl;
}

/** secrets 键名：按厂商隔离，换厂商不会互相覆盖。 */
export function secretKeyOf(providerId: string): string {
  return `astral_relay_key_${providerId}`;
}
