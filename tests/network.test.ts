import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("production fetch calls Electron net.fetch with its receiver and never falls back to Node fetch", async () => {
  const net = { fetch: vi.fn(function (this: unknown) { expect(this).toBe(net); return Promise.resolve(new Response("ok")); }) };
  const module = { exports: {} as { electronFetch: typeof fetch } };
  const nodeFetch = vi.fn(() => { throw new Error("Node fetch must not run"); });
  const code = transformSync(readFileSync("src/network.ts", "utf8"), { loader: "ts", format: "cjs" }).code;
  runInNewContext(code, { module, exports: module.exports, require: (name: string) => { expect(name).toBe("electron"); return { net }; }, fetch: nodeFetch });
  const init = { method: "POST", body: "test" };
  await module.exports.electronFetch("https://example.test", init);
  expect(net.fetch).toHaveBeenCalledWith("https://example.test", init);
  expect(nodeFetch).not.toHaveBeenCalled();
});
