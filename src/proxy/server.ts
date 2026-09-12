/**
 * 受闸门约束的本地代理。
 *
 * 对外：只绑 127.0.0.1，说 OpenAI 兼容协议（POST /v1/chat/completions）。
 * 对内：闸门放行后，把请求原样转发到所选套餐的官方端点，并注入用户自己的订阅 Key。
 *
 * 为什么要有这层代理，而不是直接把官方端点写进模型档案：
 * 直接写档案的话，这个档案在 Chat / 定时任务里同样可选，等于没有任何约束。
 * 代理存在的全部意义就是让闸门有一个能拒绝的位置。
 *
 * 鉴权：回环地址本身出不了网，token 是防同机其它进程乱打这个端口。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Gate } from "../core/gate";
import type { PlanSpec } from "../core/plans";
import type { Logger } from "../logger";

/** 请求体上限，防跑飞的 prompt 把主进程内存吃掉。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** 上游超时：比宿主的聊天超时略短，让错误以可读 JSON 而不是连接中断的形式回去。 */
const UPSTREAM_TIMEOUT_MS = 180_000;

export interface ProxyHandle {
  /** 填进模型档案的 Base URL（已含 /v1）。 */
  baseUrl: string;
  /** 填进模型档案 API Key 位置的 token。 */
  token: string;
  port: number;
  close(): Promise<void>;
}

export interface ProxyDeps {
  gate: Gate;
  /** 当前套餐；null = 未配置，代理一律回 503。 */
  getPlan: () => PlanSpec | null;
  /** 取订阅 Key；未配置返回 undefined。 */
  getKey: () => Promise<string | undefined>;
  log: Logger;
  /** 注入点，测试用；缺省走全局 fetch。 */
  fetchImpl?: typeof fetch;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** OpenAI 的错误信封，宿主 adapter 的报错路径能直接读出文案。 */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { message, type: "invalid_request_error" } });
}

/** 闸门拒绝时的文案：必须说清为什么被拒、该怎么办，否则用户只会以为插件坏了。 */
export function refusalMessage(code: "closed" | "expired" | "bad_token"): string {
  if (code === "bad_token") {
    return "编程套餐直通：token 不匹配。请把模型档案里的 API Key 换成插件面板显示的 token。";
  }
  if (code === "expired") {
    return "编程套餐直通：本轮授权窗口已过期。请回到 Code 模式重新发一条消息。";
  }
  return (
    "编程套餐直通：当前不是 Code 模式的交互式对话，已拒绝。" +
    "编程套餐的条款只允许在编程工具里交互式使用，禁止用于定时任务、朋友圈发帖等" +
    "非交互场景。请切到 Code 模式，或给这些场景换一个按量付费的模型档案。"
  );
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求体超过 8MB 上限"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function extractToken(req: IncomingMessage): string {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey) return apiKey;
  return "";
}

async function handle(req: IncomingMessage, res: ServerResponse, token: string, deps: ProxyDeps): Promise<void> {
  const { gate, getPlan, getKey, log } = deps;
  const doFetch = deps.fetchImpl ?? fetch;

  if (req.method !== "POST" || !req.url || !req.url.startsWith("/v1/")) {
    sendError(res, 404, "编程套餐直通只转发 POST /v1/*。");
    return;
  }

  const decision = gate.check(extractToken(req), token);
  if (!decision.allowed) {
    // 403 而不是 401：token 对但闸门关着时，401 会让宿主以为是凭据问题去重试。
    const status = decision.code === "bad_token" ? 401 : 403;
    log.warn("闸门拒绝：", decision.code);
    sendError(res, status, refusalMessage(decision.code));
    return;
  }

  const plan = getPlan();
  if (!plan) {
    sendError(res, 503, "编程套餐直通：尚未选择套餐，请先在插件面板配置。");
    return;
  }
  const key = await getKey();
  if (!key) {
    sendError(res, 503, `编程套餐直通：尚未填写 ${plan.label} 的订阅 Key。`);
    return;
  }

  let body: Buffer;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 400, `请求体读取失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 路径原样透传（/v1/chat/completions 等），只换主机与凭据。
  const upstreamUrl = plan.baseUrl.replace(/\/v1$/, "") + req.url;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS);
  res.on("close", () => abort.abort());

  try {
    const upstream = await doFetch(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        accept: req.headers.accept ?? "application/json",
      },
      body,
      signal: abort.signal,
    });

    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  } catch (err) {
    if (abort.signal.aborted) return; // 调用方已断开或已超时，没人等这个响应
    // 注意只打印错误消息，不打印请求体与 Key。
    log.warn("上游请求失败：", err instanceof Error ? err.message : String(err));
    sendError(res, 502, `编程套餐直通：上游请求失败（${plan.label}）。`);
  } finally {
    clearTimeout(timer);
  }
}

/** 起代理。端口用 0 由内核分配，避免撞上用户机器上别的服务。 */
export function startProxy(deps: ProxyDeps, token: string): Promise<ProxyHandle> {
  const server: Server = createServer((req, res) => {
    void handle(req, res, token, deps).catch((err) => {
      if (!res.headersSent) {
        sendError(res, 500, `代理内部错误：${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("拿不到监听端口"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        token,
        port: address.port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
