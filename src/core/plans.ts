/**
 * 编程套餐目录。
 *
 * 收录标准只有一条：厂商在自己的文档里把「套餐 Key 可用于编程工具」写成了
 * 开放类目（「等」/「such as」），而不是一份封闭的白名单应用列表。
 *
 * 明确不收录：
 *  - Z.ai GLM Coding Plan —— 条款点名禁止「自有应用、机器人、网站、SaaS」，
 *    且支持工具是封闭列表，Cyrene 不在其中；
 *  - Anthropic Claude 订阅 —— 第三方产品不得提供 claude.ai 登录或额度；
 *  - ChatGPT / Codex 订阅 —— 第三方客户端直连 Codex 后端没有公开契约
 *    （openai/codex#36886 仍未有官方答复）。
 */
export interface PlanSpec {
  /** 套餐 id，也是 secrets 里的键名后缀。 */
  id: string;
  /** 面板展示名。 */
  label: string;
  /** OpenAI 兼容端点（本插件只走 OpenAI 兼容协议）。 */
  baseUrl: string;
  /** 套餐 Key 前缀，仅用于面板做一次粗校验，防止贴错成按量付费 Key。 */
  keyPrefix: string;
  /** 条款出处，面板直接展示，方便用户自己复核。 */
  termsUrl: string;
}

export const PLANS: readonly PlanSpec[] = [
  {
    id: "qwen",
    label: "通义千问 Coding Plan",
    baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
    keyPrefix: "sk-sp-",
    termsUrl: "https://help.aliyun.com/zh/model-studio/coding-plan",
  },
  {
    id: "tencent",
    label: "腾讯云 Coding Plan",
    baseUrl: "https://api.lkeap.cloud.tencent.com/v1",
    keyPrefix: "sk-sp-",
    termsUrl: "https://cloud.tencent.com/document/product/1823/130092",
  },
  {
    id: "minimax",
    label: "MiniMax Token Plan",
    baseUrl: "https://api.minimax.io/v1",
    keyPrefix: "sk-cp-",
    termsUrl: "https://platform.minimax.io/docs/token-plan/intro",
  },
];

export function findPlan(id: string): PlanSpec | undefined {
  return PLANS.find((plan) => plan.id === id);
}

/** secrets 键名：按套餐隔离，换套餐不会互相覆盖。 */
export function secretKeyOf(planId: string): string {
  return `coding_plan_key_${planId}`;
}
