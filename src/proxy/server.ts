/**
 * 按厂商分路、按条款分类放行的本地代理。
 *
 * 对外：只绑 127.0.0.1，说 OpenAI 兼容协议。路径里带厂商 id：
 *     http://127.0.0.1:<port>/p/<providerId>/v1/chat/completions
 * 这样一个端口服务全部厂商，模型档案的 baseUrl 自己带着路由信息，
 * 代理不需要靠模型名猜厂商（猜模型名在多厂商同名模型时必然出错）。
 *
 * 对内：放行后转发到该厂商端点，并注入用户自己的订阅 Key。
 *
 * 模式凭据检查只对 kind === "coding-only" 的厂商生效：
 * 编程套餐的条款只允许编程工具的交互式使用，而通用套餐（如 MiniMax Token Plan）
 * 没有这条限制，强行也拦会变成毫无依据的功能阉割。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { constantTimeEquals, type Gate } from "../core/gate";
import { findProvider, requiresCodeMode, type ProviderSpec } from "../core/providers";
import type { Logger } from "../logger";
import { readRelayContext } from "../core/request-auth";
import { electronFetch } from "../network";
import { isOAuthProvider, type OAuthProviderId } from "../oauth/specs";
import type { OAuthTokens } from "../oauth/manager";
import { oauthHeaders } from "../oauth/upstream";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** 请求体上限，防跑飞的 prompt 把主进程内存吃掉。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** 上游超时：比宿主聊天超时略短，让错误以可读 JSON 而不是连接中断的形式回去。 */
const UPSTREAM_TIMEOUT_MS = 180_000;

export interface ProxyHandle {
  /** 某厂商专用的 Base URL（已含 /v1），直接填进模型档案。 */
  baseUrlFor(providerId: string): string;
  token: string;
  port: number;
  close(): Promise<void>;
}

export interface ProxyDeps {
  /** Legacy activity indicator; deliberately not consulted for authorization. */
  gate: Gate;
  /** 取该厂商的上游端点；未配置/未知返回 undefined。 */
  resolveUpstream: (provider: ProviderSpec) => string | undefined;
  /** 取该厂商的订阅 Key；未配置返回 undefined。 */
  getKey: (providerId: string) => Promise<string | undefined>;
  getOAuthTokens?: (id: OAuthProviderId) => Promise<OAuthTokens | undefined>;
  signal?: AbortSignal;
  log: Logger;
  /** Test injection; production always uses Electron net.fetch. */
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
export function refusalMessage(provider: ProviderSpec, code: "closed" | "expired" | "bad_token"): string {
  if (code === "bad_token") {
    return "星驿：token 不匹配。请把模型档案里的 API Key 换成插件面板显示的 token。";
  }
  if (code === "expired") {
    return `星驿：本轮授权窗口已过期。${provider.label} 只在 Code 模式的交互式对话里可用，请回到 Code 模式重新发一条消息。`;
  }
  return (
    `星驿：当前不是 Code 模式的交互式对话，已拒绝 ${provider.label}。` +
    "该套餐条款只允许在编程工具里交互式使用，禁止用于定时任务、朋友圈发帖等非交互场景。" +
    "请切到 Code 模式，或给这些场景换一个按量付费的模型档案。"
  );
}

/** 解析 /p/<providerId>/<剩余路径>；不匹配返回 null。 */
export function parseRoute(url: string): { providerId: string; rest: string } | null {
  const match = /^\/p\/([a-z0-9-]+)(\/.*)$/.exec(url);
  if (!match) return null;
  return { providerId: match[1], rest: match[2] };
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
  const { resolveUpstream, getKey, log } = deps;
  const doFetch = deps.fetchImpl ?? electronFetch;

  if (req.method !== "POST" || !req.url) {
    sendError(res, 404, "星驿只转发 POST /p/<厂商>/v1/*。");
    return;
  }
  const route = parseRoute(req.url);
  if (!route) {
    sendError(res, 404, "星驿只转发 POST /p/<厂商>/v1/*。");
    return;
  }
  const provider = findProvider(route.providerId);
  if (!provider || !provider.available) {
    sendError(res, 404, `星驿：未知或未启用的厂商 ${route.providerId}。`);
    return;
  }

  // Verify either a static local token or a signed per-run credential.
  const credential = extractToken(req);
  const context = readRelayContext(credential, token, provider.id);
  if (!context && !constantTimeEquals(credential, token)) {
    sendError(res, 401, credential.startsWith("ar1.")
      ? "星驿：本轮模式凭据无效或已过期。请确认模型档案使用当前面板的 Base URL 和 token，再开始新轮次。"
      : refusalMessage(provider, "bad_token"));
    return;
  }

  // Coding-only plans must carry this run's mode; activity windows never authorize requests.
  if (requiresCodeMode(provider)) {
    if (!context || context.mode !== "code" || context.source !== "conversation") {
      log.warn(`模式检查拒绝 ${provider.id}`);
      sendError(res, 403, context
        ? `星驿：${provider.label} 仅限 Code 交互式会话，当前模式 ${context.mode} / 来源 ${context.source} 不支持。请切换到 Code 模式，或选择通用套餐。`
        : `星驿：${provider.label} 仅限 Code 模式。宿主未提供本轮模式凭据，请使用支持 Astral Relay 模式验证的 Cyrene 构建；旧版宿主无法使用编程套餐。`);
      return;
    }
  }

  const upstreamBase = resolveUpstream(provider);
  if (!upstreamBase) {
    sendError(res, 503, `星驿：${provider.label} 尚未配置可用端点。`);
    return;
  }
  const expectedPath = provider.protocol === "responses" ? "/v1/responses" : "/v1/chat/completions";
  if (route.rest !== expectedPath) {
    sendError(res, 400, `星驿：${provider.label} 请使用 ${provider.protocol === "responses" ? "Responses" : "OpenAI 兼容"} 协议（${expectedPath}）。`);
    return;
  }

  let body: Buffer;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 400, `请求体读取失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // rest 形如 /v1/chat/completions；厂商端点自带版本段，拼接时去掉重复的 /v1。
  const suffix = route.rest.startsWith("/v1/") ? route.rest.slice(3) : route.rest;
  const upstreamUrl = upstreamBase.replace(/\/+$/, "") + suffix;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS);
  res.on("close", () => abort.abort());
  const onStop = () => abort.abort();
  deps.signal?.addEventListener("abort", onStop, { once: true });

  try {
    if (deps.signal?.aborted || res.destroyed) abort.abort();
    abort.signal.throwIfAborted();
    let headers: Record<string, string>;
    let requestBody: string | Buffer = body;
    if (isOAuthProvider(provider.id)) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      } catch { sendError(res, 400, "请求体必须为 JSON 对象。"); return; }
      const tokens = await deps.getOAuthTokens?.(provider.id);
      if (!tokens) { sendError(res, 503, `星驿：请打开面板连接 ${provider.label}。`); return; }
      headers = oauthHeaders(provider.id, tokens);
    } else {
      const key = await getKey(provider.id);
      if (!key) { sendError(res, 503, `星驿：尚未填写 ${provider.label} 的订阅 Key。`); return; }
      headers = { authorization: `Bearer ${key}` };
    }
    abort.signal.throwIfAborted();
    const upstream = await doFetch(upstreamUrl, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        accept: req.headers.accept ?? "application/json",
      },
      body: requestBody,
      signal: abort.signal,
      redirect: "error",
    });

    if (!upstream.ok) {
      await upstream.body?.cancel();
      sendError(res, upstream.status, `星驿：${provider.label} 返回 HTTP ${upstream.status}。${upstream.status === 401 ? "请重新连接订阅。" : "请检查模型与订阅额度。"}`);
      return;
    }
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    });
    if (!upstream.body) { res.end(); return; }
    const stream = Readable.fromWeb(upstream.body as never);
    await pipeline(stream, res, { signal: abort.signal });
  } catch {
    log.warn(`上游请求失败（${provider.id}）`);
    if (res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    sendError(res, abort.signal.aborted ? 504 : 502, `星驿：${provider.label} 请求失败或超时，请检查连接并在面板重新连接订阅。`);
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onStop);
  }
}

/** 起代理。端口用 0 由内核分配，避免撞上用户机器上别的服务。 */
export function startProxy(deps: ProxyDeps, token: string): Promise<ProxyHandle> {
  const server: Server = createServer((req, res) => {
    void handle(req, res, token, deps).catch(() => {
      if (!res.headersSent) {
        sendError(res, 500, "代理内部错误，请重新启用插件。");
      } else res.destroy();
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
      const port = address.port;
      resolve({
        baseUrlFor: (providerId) => `http://127.0.0.1:${port}/p/${providerId}/v1`,
        token,
        port,
        close: () => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }),
      });
    });
  });
}
