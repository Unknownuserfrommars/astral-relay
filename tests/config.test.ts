import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeConfigPatch } from "../src/config";

describe("配置合并", () => {
  it("忽略非对象补丁", () => {
    expect(mergeConfigPatch(DEFAULT_CONFIG, null)).toEqual(DEFAULT_CONFIG);
    expect(mergeConfigPatch(DEFAULT_CONFIG, "x")).toEqual(DEFAULT_CONFIG);
  });

  it("类型不符的键被跳过", () => {
    const next = mergeConfigPatch(DEFAULT_CONFIG, { planId: 42, windowTtlMs: "长一点" });
    expect(next).toEqual(DEFAULT_CONFIG);
  });

  it("TTL 收敛到 10s..600s 区间", () => {
    expect(mergeConfigPatch(DEFAULT_CONFIG, { windowTtlMs: 1 }).windowTtlMs).toBe(10000);
    expect(mergeConfigPatch(DEFAULT_CONFIG, { windowTtlMs: 9999999 }).windowTtlMs).toBe(600000);
    expect(mergeConfigPatch(DEFAULT_CONFIG, { windowTtlMs: 60000 }).windowTtlMs).toBe(60000);
  });

  it("白名单外的键不会进配置", () => {
    const next = mergeConfigPatch(DEFAULT_CONFIG, { planId: "qwen", bogus: "越界" });
    expect(next.planId).toBe("qwen");
    expect(next).not.toHaveProperty("bogus");
  });
});
