// OAuth wire details for xAI Grok.
//
// 客户端 id 与 scope 来自 xAI 的共享 OAuth 客户端：xAI 明确支持第三方工具复用
// 用户自己的 SuperGrok / X Premium 订阅额度，并且不提供第三方自建 client 的注册入口，
// 共享客户端就是官方路径（因此授权页可能显示 Grok Build，这是已知且有文档的行为）。
// 端点取自 xAI 自己发布的 OIDC discovery：https://auth.x.ai/.well-known/openid-configuration
export type OAuthProviderId = "grok";
export interface OAuthSpec {
  /** 设备码端点；取自 xAI 发布的 OIDC discovery。 */
  deviceCodeUrl: string;
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  port: number;
  redirectHost: string;
  pathname: string;
  scopes: string[];
  extra: Record<string, string>;
}
export const OAUTH_SPECS: Record<OAuthProviderId, OAuthSpec> = {
  grok: {
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    authorizeUrl: "https://auth.x.ai/oauth2/authorize",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
    port: 56121, redirectHost: "127.0.0.1", pathname: "/callback",
    // grok-cli:access 与 api:access 都在 discovery 的 scopes_supported 里，是公开广告的 scope。
    scopes: ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"],
    // 刻意不带 referrer=opencode：本插件不是 OpenCode，冒名是唯一真正失实的字段。
    extra: { plan: "generic" },
  },
};
export const isOAuthProvider = (id: string): id is OAuthProviderId => id === "grok";
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const redirectUri = (spec: OAuthSpec): string => `http://${spec.redirectHost}:${spec.port}${spec.pathname}`;
