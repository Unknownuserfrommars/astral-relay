import { createServer } from "node:http";
import type { OAuthSpec } from "./specs";

/** Bind loopback BEFORE opening the browser. Unrelated/mismatched callbacks cannot end login. */
export async function prepareCallback(spec: OAuthSpec, state: string, signal: AbortSignal) {
  signal.throwIfAborted();
  let resolveCode!: (value: string) => void;
  let rejectCode!: (reason: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // The browser may be opening when cancellation arrives; keep rejection handled until awaited.
  void code.catch(() => {});
  let settled = false;
  const server = createServer((req, res) => {
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://127.0.0.1"); }
    catch { res.writeHead(400).end("Invalid request"); return; }
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    if (req.method !== "GET" || url.pathname !== spec.pathname) { res.writeHead(404).end("Not found"); return; }
    if (url.searchParams.get("state") !== state) { res.writeHead(400).end("Invalid OAuth state"); return; }
    if (url.searchParams.has("error")) {
      res.writeHead(400).end("Authorization declined. Return to Astral Relay.");
      finish(new Error("授权被拒绝，请重试"));
      return;
    }
    const value = url.searchParams.get("code");
    if (!value || value.length > 4096) { res.writeHead(400).end("Missing authorization code"); return; }
    res.end("Authorization received. Return to Astral Relay to check connection status.");
    finish(undefined, value);
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  function finish(error?: Error, value?: string) {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", onAbort);
    server.close();
    server.closeIdleConnections();
    if (error) rejectCode(error); else resolveCode(value!);
  }
  const onAbort = () => { finish(new Error("登录已取消或超时")); server.closeAllConnections(); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(spec.port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    server.on("error", () => finish(new Error("登录回调连接失败")));
    if (signal.aborted) onAbort();
    signal.throwIfAborted();
  } catch {
    onAbort();
    throw new Error(`无法监听登录端口 ${spec.port}，请关闭占用端口的登录窗口后重试`);
  }
  return { code, close: onAbort, port: (server.address() as { port: number }).port };
}
