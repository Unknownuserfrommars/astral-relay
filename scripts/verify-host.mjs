// Optional cross-repository contract check: node scripts/verify-host.mjs <Cyrene checkout>
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

if (!process.argv[2]) throw new Error("Pass the Cyrene source checkout path.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = path.resolve(process.argv[2], "src/main/orchestrator/astral-relay-auth.ts");
const verifier = path.join(root, "src/core/request-auth.ts");
const result = await build({
  stdin: { contents: `export { bindAstralRelayCredential } from ${JSON.stringify(host)}; export { readRelayContext } from ${JSON.stringify(verifier)};`, resolveDir: root },
  bundle: true, platform: "node", format: "esm", write: false,
});
const { bindAstralRelayCredential, readRelayContext } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const secret = "ar-secret-v1.integration-test";
for (const provider of ["minimax", "qwen", "tencent"]) {
  for (const mode of ["chat", "work", "learn", "code"]) {
    for (const source of ["conversation", "scheduler"]) {
      const token = bindAstralRelayCredential(`http://127.0.0.1:12345/p/${provider}/v1`, secret, mode, source);
      const context = readRelayContext(token, secret, provider);
      assert.ok(context);
      assert.equal(context.mode, mode);
      assert.equal(context.source, source);
      assert.equal(readRelayContext(token, secret + "wrong", provider), null);
    }
  }
}
console.log("Host/plugin credential contract: 24 mode/provider/source combinations passed.");
