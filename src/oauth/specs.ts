// OAuth wire details adapted from Cyrene-Plugins subscription-oauth 1.2.7 (MIT).
// See THIRD_PARTY_NOTICES.md. These are compatibility endpoints, not public API guarantees.
export type OAuthProviderId = "codex" | "grok";
export interface OAuthSpec {
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
  codex: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    port: 1455, redirectHost: "localhost", pathname: "/auth/callback",
    scopes: ["openid", "profile", "email", "offline_access", "api.connectors.read", "api.connectors.invoke"],
    extra: { id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "codex_cli_rs", prompt: "login" },
  },
  grok: {
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    authorizeUrl: "https://auth.x.ai/oauth2/authorize",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    port: 56121, redirectHost: "127.0.0.1", pathname: "/callback",
    scopes: ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"],
    extra: { plan: "generic", referrer: "opencode" },
  },
};
export const isOAuthProvider = (id: string): id is OAuthProviderId => id === "codex" || id === "grok";
export const redirectUri = (spec: OAuthSpec): string => `http://${spec.redirectHost}:${spec.port}${spec.pathname}`;
