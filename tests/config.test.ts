import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeConfigPatch, regionOf } from "../src/config";

describe("配置合并", () => {
  it("忽略非对象补丁", () => {
    expect(mergeConfigPatch(DEFAULT_CONFIG, null)).toEqual(DEFAULT_CONFIG);
    expect(mergeConfigPatch(DEFAULT_CONFIG, "x")).toEqual(DEFAULT_CONFIG);
  });

  it("TTL 收敛到 10s..600s 区间", () => {
    expect(mergeConfigPatch(DEFAULT_CONFIG, { windowTtlMs: 1 }).windowTtlMs).toBe(10000);
    expect(mergeConfigPatch(DEFAULT_CONFIG, { windowTtlMs: 9999999 }).windowTtlMs).toBe(600000);
    expect(mergeConfigPatch(DEFAULT_CONFIG, { windowTtlMs: 60000 }).windowTtlMs).toBe(60000);
  });

  it("类型不符的 TTL 被跳过", () => {
    expect(mergeConfigPatch(DEFAULT_CONFIG, { windowTtlMs: "长一点" }).windowTtlMs).toBe(
      DEFAULT_CONFIG.windowTtlMs,
    );
  });

  it("记录合法厂商的区域选择", () => {
    const next = mergeConfigPatch(DEFAULT_CONFIG, { providerId: "minimax", regionId: "cn" });
    expect(regionOf(next, "minimax")).toBe("cn");
  });

  it("未知厂商与未知区域一律丢弃", () => {
    // 存进去会让代理解析不出端点，只能 503，不如在入口挡掉
    expect(regionOf(mergeConfigPatch(DEFAULT_CONFIG, { providerId: "nope", regionId: "cn" }), "nope")).toBeUndefined();
    expect(
      regionOf(mergeConfigPatch(DEFAULT_CONFIG, { providerId: "minimax", regionId: "mars" }), "minimax"),
    ).toBeUndefined();
  });

  it("单区域厂商不接受区域设置", () => {
    const next = mergeConfigPatch(DEFAULT_CONFIG, { providerId: "qwen", regionId: "cn" });
    expect(regionOf(next, "qwen")).toBeUndefined();
  });
});
