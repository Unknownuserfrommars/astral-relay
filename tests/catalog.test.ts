import { expect, it } from "vitest";
import { fetchCatalog } from "../src/oauth/upstream";

it("reads grok model catalogue with OAuth headers and an honest user agent", async () => {
  // 用 seen 捕获而不是 vi.fn().mock.calls[0][1]：后者的参数元组会被推成 []，
  // 取 [1] 直接过不了 tsc（vitest 不做类型检查，只跑测试会漏掉）。
  let seen: { url: unknown; init: any } | undefined;
  const fetchImpl = (async (url: any, init: any) => {
    seen = { url, init };
    return new Response(JSON.stringify({ data: [{ id: "grok-test" }, { id: "grok-imagine" }] }));
  }) as unknown as typeof fetch;

  const models = await fetchCatalog(
    "grok",
    { accessToken: "secret", expiresAt: Date.now() + 3600000 },
    new AbortController().signal,
    fetchImpl,
  );

  expect(models.map((model) => model.id)).toEqual(["grok-test"]);
  expect(seen!.url).toBe("https://api.x.ai/v1/models");
  expect(seen!.init.headers.authorization).toBe("Bearer secret");
  // 不伪装官方 CLI：UA 必须自报家门，且不得再出现 grok-cli 伪装头
  expect(seen!.init.headers["user-agent"]).toContain("astral-relay");
  expect(JSON.stringify(seen!.init.headers)).not.toContain("grok-cli");
});
