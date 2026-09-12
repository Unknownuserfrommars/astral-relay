import { describe, expect, it } from "vitest";
import {
  DEFAULT_BINDING_MAX,
  createTurnBinding,
  fingerprint,
  lastUserTexts,
} from "../src/core/turn-binding";
import { createNonceStore } from "../src/core/request-auth";

const CODE_TURN = { mode: "code", source: "conversation", userText: "帮我重构这个函数" };

describe("Code 轮次绑定", () => {
  it("登记后能匹配到同一段输入", () => {
    const binding = createTurnBinding();
    expect(binding.register(CODE_TURN)).toBe(true);
    expect(binding.matchesAny([CODE_TURN.userText])).toBe(true);
    expect(binding.size()).toBe(1);
  });

  it("没登记过的输入不匹配", () => {
    const binding = createTurnBinding();
    binding.register(CODE_TURN);
    expect(binding.matchesAny(["完全不同的另一句话"])).toBe(false);
  });

  it.each([
    ["chat", "conversation"],
    ["work", "conversation"],
    ["learn", "conversation"],
    ["code", "scheduler"],
    ["code", "moments-post"],
  ])("mode=%s source=%s 一律不登记", (mode, source) => {
    const binding = createTurnBinding();
    expect(binding.register({ mode, source, userText: CODE_TURN.userText })).toBe(false);
    expect(binding.matchesAny([CODE_TURN.userText])).toBe(false);
    expect(binding.size()).toBe(0);
  });

  it("mode 缺失时不登记：拿不到模式就不该放行", () => {
    const binding = createTurnBinding();
    expect(binding.register({ source: "conversation", userText: "x" })).toBe(false);
  });

  it("空文本与纯空白不登记", () => {
    const binding = createTurnBinding();
    expect(binding.register({ ...CODE_TURN, userText: "" })).toBe(false);
    expect(binding.register({ ...CODE_TURN, userText: "   \n\t " })).toBe(false);
    expect(binding.matchesAny([""])).toBe(false);
    expect(binding.size()).toBe(0);
  });

  it("折叠空白：换行与空格的差异不影响匹配", () => {
    const binding = createTurnBinding();
    binding.register({ ...CODE_TURN, userText: "第一行\n第二行" });
    expect(binding.matchesAny(["第一行 第二行"])).toBe(true);
    expect(binding.matchesAny(["  第一行\n\n第二行  "])).toBe(true);
    // 折叠空白不等于忽略内容
    expect(binding.matchesAny(["第一行第二行"])).toBe(false);
  });

  it("超过 TTL 后失效", () => {
    let clock = 1000;
    const binding = createTurnBinding({ ttlMs: 100, now: () => clock });
    binding.register(CODE_TURN);
    clock += 100;
    expect(binding.matchesAny([CODE_TURN.userText])).toBe(true);
    clock += 1;
    expect(binding.matchesAny([CODE_TURN.userText])).toBe(false);
    expect(binding.size()).toBe(0);
  });

  it("重复登记刷新时间戳，不产生第二条", () => {
    let clock = 1000;
    const binding = createTurnBinding({ ttlMs: 100, now: () => clock });
    binding.register(CODE_TURN);
    clock += 80;
    binding.register(CODE_TURN);
    clock += 80;
    expect(binding.matchesAny([CODE_TURN.userText])).toBe(true);
    expect(binding.size()).toBe(1);
  });

  it("条目数封顶，淘汰最旧的", () => {
    const binding = createTurnBinding({ max: 3 });
    for (const text of ["一", "二", "三", "四"]) binding.register({ ...CODE_TURN, userText: text });
    expect(binding.size()).toBe(3);
    expect(binding.matchesAny(["一"])).toBe(false);
    expect(binding.matchesAny(["四"])).toBe(true);
  });

  it("默认上限是有限值，长会话不会无界增长", () => {
    const binding = createTurnBinding();
    for (let i = 0; i < DEFAULT_BINDING_MAX + 20; i += 1) {
      binding.register({ ...CODE_TURN, userText: `第 ${i} 句` });
    }
    expect(binding.size()).toBe(DEFAULT_BINDING_MAX);
  });

  it("clear 清空全部登记", () => {
    const binding = createTurnBinding();
    binding.register(CODE_TURN);
    binding.clear();
    expect(binding.matchesAny([CODE_TURN.userText])).toBe(false);
  });

  it("指纹不是明文：登记内容不可从指纹还原", () => {
    const hash = fingerprint(CODE_TURN.userText)!;
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain("重构");
  });
});

describe("从请求体里取最后一条 user 消息", () => {
  const body = (value: unknown) => JSON.stringify(value);

  it("取最后一条 user 消息，而不是最后一条消息", () => {
    expect(lastUserTexts(body({
      messages: [
        { role: "user", content: "第一问" },
        { role: "assistant", content: "回答" },
        { role: "user", content: "第二问" },
        { role: "assistant", content: "再回答" },
        { role: "tool", tool_call_id: "c1", content: "工具结果" },
      ],
    }))).toEqual(["第二问"]);
  });

  it("多段 content 给出两种拼法作为候选", () => {
    expect(lastUserTexts(body({
      messages: [{ role: "user", content: [{ type: "text", text: "甲" }, { type: "text", text: "乙" }] }],
    }))).toEqual(["甲\n乙", "甲乙"]);
  });

  it("忽略图片等非文本段", () => {
    expect(lastUserTexts(body({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:..." } }, { type: "text", text: "看图" }] }],
    }))).toEqual(["看图", "看图"]);
  });

  it.each([
    ["不是 JSON", "{ 坏掉的"],
    ["JSON 数组", "[]"],
    ["没有 messages", '{"model":"m"}'],
    ["messages 不是数组", '{"messages":"x"}'],
    ["没有 user 消息", '{"messages":[{"role":"system","content":"s"}]}'],
    ["content 是数字", '{"messages":[{"role":"user","content":42}]}'],
  ])("%s 时返回空候选，绝不放行", (_label, raw) => {
    expect(lastUserTexts(raw)).toEqual([]);
    expect(createTurnBinding().matchesAny(lastUserTexts(raw))).toBe(false);
  });

  it("接受 Buffer 输入", () => {
    expect(lastUserTexts(Buffer.from(body({ messages: [{ role: "user", content: "你好" }] })))).toEqual(["你好"]);
  });
});

describe("nonce 首用计时", () => {
  it("首次使用被接受，窗口内可重复使用（工具续轮不断）", () => {
    let clock = 1000;
    const store = createNonceStore({ windowMs: 100, now: () => clock });
    expect(store.accept("n1")).toBe(true);
    clock += 50;
    expect(store.accept("n1")).toBe(true);
    clock += 50;
    expect(store.accept("n1")).toBe(true);
  });

  it("超过首用窗口后拒绝", () => {
    let clock = 1000;
    const store = createNonceStore({ windowMs: 100, now: () => clock });
    store.accept("n1");
    clock += 101;
    expect(store.accept("n1")).toBe(false);
  });

  it("超窗后不会因为遗忘又被当成首次使用", () => {
    let clock = 1000;
    // 保留期是凭据自身的最长寿命（24h），远长于首用窗口
    const store = createNonceStore({ windowMs: 100, now: () => clock });
    store.accept("n1");
    clock += 3 * 60 * 60 * 1000;
    expect(store.accept("n1")).toBe(false);
  });

  it("不同 nonce 互不影响", () => {
    const store = createNonceStore({ windowMs: 100 });
    expect(store.accept("a")).toBe(true);
    expect(store.accept("b")).toBe(true);
  });

  it("条目数封顶", () => {
    const store = createNonceStore({ max: 2 });
    for (const nonce of ["a", "b", "c"]) store.accept(nonce);
    expect(store.size()).toBe(2);
  });
});
