import { expect, it, vi } from "vitest";
import { fetchCatalog } from "../src/oauth/upstream";

it.each(["codex", "grok"] as const)("reads %s model catalogue with OAuth headers", async (id) => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(id === "codex"
    ? { models: [{ slug: "gpt-test", display_name: "Test" }, { slug: "hidden", visibility: "hide" }] }
    : { data: [{ id: "grok-test" }, { id: "grok-imagine" }] })));
  const models = await fetchCatalog(id, { accessToken: "secret", expiresAt: Date.now() + 3600000 }, new AbortController().signal, fetchImpl);
  expect(models.map((model) => model.id)).toEqual([id === "codex" ? "gpt-test" : "grok-test"]);
  expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer secret" }) }));
});
