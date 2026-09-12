import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("status polling preserves entered keys, focus targets and unsaved settings", async () => {
  const elements = new Map<string, any>();
  const element = () => ({ textContent: "", value: "", appendChild: vi.fn(), addEventListener: vi.fn() });
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const state = { gate: { open: false }, providers: [], proxy: { token: "local" }, windowTtlMs: 180000 };
  const context: Record<string, any> = {
    require: () => ({ ipcRenderer: { invoke: vi.fn(async () => state) } }),
    document: { getElementById: get, createElement: element },
    setInterval: vi.fn(),
  };
  runInNewContext(readFileSync("src/ui/panel/panel.js", "utf8"), context);
  await context.refresh();
  get("providers").textContent = "existing provider inputs";
  get("ttl").value = "45000";
  state.gate.open = true;
  const poll = context.setInterval.mock.calls[0][0];
  poll();
  await vi.waitFor(() => expect(get("gate-badge").textContent).toBe("活动中"));
  expect(get("providers").textContent).toBe("existing provider inputs");
  expect(get("ttl").value).toBe("45000");
  expect(get("gate-badge").textContent).toBe("活动中");
});
