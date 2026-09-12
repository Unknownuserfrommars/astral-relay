import { describe, expect, it } from "vitest";
import {
  PROVIDERS,
  findProvider,
  requiresCodeMode,
  resolveBaseUrl,
  secretKeyOf,
} from "../src/core/providers";

describe("厂商目录", () => {
  it("包含订阅 Key 与 OAuth 接入目录", () => {
    const ids = PROVIDERS.map((p) => p.id).sort();
    expect(ids).toEqual(["copilot", "grok", "minimax", "qwen", "tencent"]);
  });

  it("不收录 Z.ai / Anthropic / Google 订阅", () => {
    // 这条测试是条款边界的回归钉子：有人想加回来必须先改这里，
    // 改这里就会被 review 看到，而不是悄悄多一个选项。
    for (const banned of ["zai", "glm", "anthropic", "claude", "gemini", "google", "codex", "chatgpt", "openai"]) {
      expect(findProvider(banned)).toBeUndefined();
    }
  });

  it("编程套餐必须过闸门，通用套餐不过", () => {
    expect(requiresCodeMode(findProvider("qwen")!)).toBe(true);
    expect(requiresCodeMode(findProvider("tencent")!)).toBe(true);
    expect(requiresCodeMode(findProvider("minimax")!)).toBe(false);
    expect(requiresCodeMode(findProvider("grok")!)).toBe(false);
  });

  it("腾讯用的是 Coding Plan 专属端点，不是按量付费端点", () => {
    // 官方文档写明两套 Key 与 Base URL「不互通，请勿混用」；
    // 填成 /v1 会直接鉴权失败，所以钉死这条。
    const tencent = findProvider("tencent")!;
    expect(tencent.baseUrl).toBe("https://api.lkeap.cloud.tencent.com/coding/v3");
    expect(tencent.baseUrl).not.toContain("lkeap.cloud.tencent.com/v1");
  });

  it("MiniMax 按区域解析端点，未指定时取第一个", () => {
    const minimax = findProvider("minimax")!;
    expect(resolveBaseUrl(minimax, "cn")).toBe("https://api.minimaxi.com/v1");
    expect(resolveBaseUrl(minimax, "global")).toBe("https://api.minimax.io/v1");
    expect(resolveBaseUrl(minimax, undefined)).toBe("https://api.minimax.io/v1");
    // 未知区域退回第一个，而不是返回 undefined 让代理 503
    expect(resolveBaseUrl(minimax, "mars")).toBe("https://api.minimax.io/v1");
  });

  it("Copilot 已定义但本版本不可用", () => {
    const copilot = findProvider("copilot")!;
    expect(copilot.kind).toBe("agent-cli");
    expect(copilot.available).toBe(false);
  });

  it("可用厂商都带条款链接与上游端点", () => {
    for (const provider of PROVIDERS.filter((p) => p.available)) {
      expect(provider.termsUrl.startsWith("https://")).toBe(true);
      expect(resolveBaseUrl(provider, undefined)!.startsWith("https://")).toBe(true);
    }
  });

  it("secrets 键名按厂商隔离", () => {
    expect(secretKeyOf("qwen")).toBe("astral_relay_key_qwen");
    expect(secretKeyOf("qwen")).not.toBe(secretKeyOf("tencent"));
  });
});
