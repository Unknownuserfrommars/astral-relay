import { electronFetch } from "../network";
import type { OAuthTokens } from "./manager";
import type { OAuthProviderId } from "./specs";

/**
 * 上游请求头。
 *
 * user-agent 如实标明自己是 Astral Relay：xAI 的订阅额度本来就允许第三方工具使用，
 * 没有伪装成官方 CLI 的理由。若 xAI 拒绝该 UA，再按实测结果调整并在此写明原因。
 */
export function oauthHeaders(_id: OAuthProviderId, tokens: OAuthTokens): Record<string, string> {
  return {
    authorization: `Bearer ${tokens.accessToken}`,
    "user-agent": "astral-relay/0.4.0",
  };
}

export interface CatalogModel { id: string; name: string }

export async function fetchCatalog(
  id: OAuthProviderId,
  tokens: OAuthTokens,
  signal: AbortSignal,
  doFetch = electronFetch,
): Promise<CatalogModel[]> {
  const response = await doFetch("https://api.x.ai/v1/models", {
    headers: { ...oauthHeaders(id, tokens), accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    redirect: "error",
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`读取模型目录失败（HTTP ${response.status}）`); }
  const json = await response.json() as Record<string, unknown>;
  if (!Array.isArray(json.data)) throw new Error("模型目录格式无效");
  const result = new Map<string, CatalogModel>();
  for (const row of json.data) {
    if (!row || typeof row !== "object") continue;
    const modelId = (row as Record<string, unknown>).id;
    // 过滤掉图像/视频/向量这类不能当聊天模型用的条目
    if (typeof modelId !== "string" || !modelId || /imagine|image-|video|embed/i.test(modelId)) continue;
    result.set(modelId, { id: modelId, name: modelId });
  }
  if (!result.size) throw new Error("订阅没有返回可用模型");
  return [...result.values()];
}
