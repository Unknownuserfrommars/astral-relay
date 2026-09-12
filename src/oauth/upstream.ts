import { electronFetch } from "../network";
import type { OAuthTokens } from "./manager";
import type { OAuthProviderId } from "./specs";

export function oauthHeaders(id: OAuthProviderId, tokens: OAuthTokens): Record<string, string> {
  return {
    authorization: `Bearer ${tokens.accessToken}`,
    ...(id === "codex" ? {
      originator: "codex_cli_rs", "user-agent": "codex_cli_rs/0.147.0", "openai-beta": "responses=experimental",
      ...(tokens.accountId ? { "chatgpt-account-id": tokens.accountId } : {}),
    } : { "user-agent": "grok-build-cli/0.1", "x-xai-token-auth": "xai-grok-cli" }),
  };
}

export function codexBody(input: Record<string, unknown>): Record<string, unknown> {
  const body = structuredClone(input);
  body.store = false;
  body.stream = true; // Codex is SSE-only; the proxy can collect a JSON response for non-stream callers.
  body.instructions ??= "";
  for (const field of ["max_output_tokens", "max_tokens", "temperature", "top_p", "truncation"]) delete body[field];
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item?.role !== "assistant" || !Array.isArray(item.content)) continue;
      for (const part of item.content) if (part?.type === "input_text") part.type = "output_text";
    }
  }
  return body;
}

export interface CatalogModel { id: string; name: string }
export async function fetchCatalog(id: OAuthProviderId, tokens: OAuthTokens, signal: AbortSignal, doFetch = electronFetch): Promise<CatalogModel[]> {
  const url = id === "codex" ? "https://chatgpt.com/backend-api/codex/models?client_version=0.147.0" : "https://api.x.ai/v1/models";
  const response = await doFetch(url, { headers: { ...oauthHeaders(id, tokens), accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: "error" });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`读取模型目录失败（HTTP ${response.status}）`); }
  const json = await response.json() as Record<string, unknown>;
  const rows = id === "codex" ? json.models : json.data;
  if (!Array.isArray(rows)) throw new Error("模型目录格式无效");
  const result = new Map<string, CatalogModel>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const modelId = id === "codex" ? row.slug : row.id;
    if (typeof modelId !== "string" || !modelId || row.visibility === "hide" || row.visibility === "none" || /imagine|image-|video|embed/i.test(modelId)) continue;
    result.set(modelId, { id: modelId, name: typeof row.display_name === "string" ? row.display_name : modelId });
  }
  if (!result.size) throw new Error("订阅没有返回可用模型");
  return [...result.values()];
}
