# Cyrene host integration

Qwen and Tencent Coding Plans require the companion Cyrene host change. Installing only the plugin on an older host returns HTTP 403 for those plans. Codex, Grok, and MiniMax support every mode with the normal panel token and do not require this host change.

The implementation is in Cyrene's `src/main/orchestrator/astral-relay-auth.ts`, called by `build-options.ts` for conversations and `agent-runtime.ts` for scheduler runs. It transforms only the in-memory run credential, leaving saved model profiles unchanged. Stream requests, retries, and tool continuations use that run's credential through the existing API-key transport.

## Wire contract: ar1

The panel exposes a random `ar-secret-v1.<secret>` token. The host signs only profiles using that prefix and an HTTP URL matching `127.0.0.1:<port>/p/<provider>/v1`.

The request's bearer credential (or x-api-key) is `ar1.<payload>.<signature>`:

- Payload: base64url UTF-8 JSON containing `provider`, `mode`, `source`, `issuedAt` (Unix milliseconds), and a random `nonce`.
- Signature: lowercase hex HMAC-SHA256 of `ar1.<payload>`, using the complete panel token as the key.
- Verification: valid signature, matching route provider, nonempty nonce, integer timestamp no later than now and less than 24 hours old.
- Coding-only plans additionally require `mode === "code"` and `source === "conversation"`. Missing context returns 403; invalid signatures return 401.
- General plans accept either the static panel token or a valid signed credential in any mode.

Do not infer mode from prompts, model names, tools, active windows, or a global time window. Background calls without signed context cannot use coding-only plans. Never persist signed run credentials into profiles or forward them upstream.

This prevents accidental cross-mode use by the host. It does not prevent a process holding the panel token from signing its own requests, or replay of a credential during its validity period.

## Verification

1. Build the companion Cyrene source and this plugin.
2. Open the plugin panel and copy the current Base URL and token into a model profile.
3. For Qwen / Tencent Coding Plans, verify a Code conversation succeeds and Chat/Work/Learn return 403, including while Code is active.
4. Verify general BYOS works in each mode and the subscription key replaces the local credential upstream.

No real subscription credentials are needed for automated tests; the proxy suite uses a stub upstream.
