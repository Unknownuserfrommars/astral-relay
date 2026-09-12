import { describe, expect, it } from "vitest";
import { PLANS, findPlan, secretKeyOf } from "../src/core/plans";

describe("套餐目录", () => {
  it("只收录条款允许第三方编程工具的套餐", () => {
    const ids = PLANS.map((p) => p.id).sort();
    expect(ids).toEqual(["minimax", "qwen", "tencent"]);
  });

  it("不收录 Z.ai / Anthropic / OpenAI 订阅", () => {
    // 这条测试是条款边界的回归钉子：有人想加回来必须先改这里，
    // 改这里就会被 review 看到，而不是悄悄多一个选项。
    for (const banned of ["zai", "glm", "anthropic", "claude", "openai", "codex", "chatgpt"]) {
      expect(findPlan(banned)).toBeUndefined();
    }
  });

  it("每个套餐都带条款链接与 Key 前缀", () => {
    for (const plan of PLANS) {
      expect(plan.termsUrl.startsWith("https://")).toBe(true);
      expect(plan.keyPrefix.length).toBeGreaterThan(0);
      expect(plan.baseUrl.startsWith("https://")).toBe(true);
    }
  });

  it("secrets 键名按套餐隔离", () => {
    expect(secretKeyOf("qwen")).toBe("coding_plan_key_qwen");
    expect(secretKeyOf("qwen")).not.toBe(secretKeyOf("tencent"));
  });
});
