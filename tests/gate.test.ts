import { describe, expect, it } from "vitest";
import { constantTimeEquals, createGate } from "../src/core/gate";

const TOKEN = "abc123";

describe("闸门", () => {
  it("默认关闭：没开窗一律拒绝", () => {
    const gate = createGate();
    expect(gate.check(TOKEN, TOKEN)).toEqual({ allowed: false, code: "closed" });
    expect(gate.snapshot().open).toBe(false);
  });

  it("开窗后放行，关窗后立即拒绝", () => {
    const gate = createGate();
    gate.open();
    expect(gate.check(TOKEN, TOKEN)).toEqual({ allowed: true });
    gate.close();
    expect(gate.check(TOKEN, TOKEN)).toEqual({ allowed: false, code: "closed" });
  });

  it("token 不匹配优先于闸门状态：开窗也不放行，且回 bad_token", () => {
    const gate = createGate();
    gate.open();
    expect(gate.check("wrong!", TOKEN)).toEqual({ allowed: false, code: "bad_token" });
  });

  it("超过 TTL 自动过期，过期后状态被清掉", () => {
    let clock = 1000;
    const gate = createGate({ ttlMs: 100, now: () => clock });
    gate.open();
    clock += 101;
    expect(gate.check(TOKEN, TOKEN)).toEqual({ allowed: false, code: "expired" });
    expect(gate.check(TOKEN, TOKEN)).toEqual({ allowed: false, code: "closed" });
  });

  it("snapshot 在过期后报告 open=false", () => {
    let clock = 1000;
    const gate = createGate({ ttlMs: 100, now: () => clock });
    gate.open();
    expect(gate.snapshot().open).toBe(true);
    clock += 101;
    expect(gate.snapshot().open).toBe(false);
  });

  it("定长比较对长度不同与内容不同都返回 false", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abd")).toBe(false);
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
  });
});
