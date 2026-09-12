#!/usr/bin/env node
/**
 * 构建脚本：把 TypeScript 源码打包成单个 index.cjs，并把 manifest 与面板一起放进
 * dist/plugin/astral-relay/。产物可直接压缩成 Cyrene 插件 ZIP。
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PLUGIN_DIR = path.join(ROOT, "dist", "plugin", "astral-relay");
const SRC_DIR = path.join(ROOT, "src");
const MANIFEST_PATH = path.join(ROOT, "manifest.json");
const SOURCE_HASH_PATH = path.join(ROOT, "dist", ".source-hash");

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function hashDirectory(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const hash = createHash("sha256");
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) hash.update(`${relative}/:${await hashDirectory(full, relative)}\n`);
    else if (entry.isFile()) hash.update(`${relative}:${await sha256File(full)}\n`);
  }
  return hash.digest("hex");
}

export async function computeSourceHash() {
  const srcHash = await hashDirectory(SRC_DIR);
  const manifestHash = await sha256File(MANIFEST_PATH);
  return createHash("sha256").update(srcHash).update(manifestHash).digest("hex");
}

async function copyPanelAssets() {
  const srcPanel = path.join(SRC_DIR, "ui", "panel");
  const destPanel = path.join(PLUGIN_DIR, "panel");
  await mkdir(destPanel, { recursive: true });
  for (const name of ["index.html", "panel.js"]) {
    const src = path.join(srcPanel, name);
    try {
      await stat(src);
      await copyFile(src, path.join(destPanel, name));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
}

async function main() {
  console.log("[build] 开始构建 astral-relay...");
  await rm(PLUGIN_DIR, { recursive: true, force: true });
  await mkdir(PLUGIN_DIR, { recursive: true });

  // electron 由宿主提供，不要 bundle
  await esbuild.build({
    entryPoints: [path.join(SRC_DIR, "index.ts")],
    outfile: path.join(PLUGIN_DIR, "index.cjs"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["electron"],
    minify: false,
    sourcemap: false,
    charset: "utf8",
  });

  await copyFile(MANIFEST_PATH, path.join(PLUGIN_DIR, "manifest.json"));
  // Cyrene-Plugins 收录清单要求插件目录内必须有 README.md；
  // 放进构建而不是手动拷贝，否则下次 build 又会漏掉。
  await copyFile(path.join(ROOT, "README.md"), path.join(PLUGIN_DIR, "README.md"));
  await copyFile(path.join(ROOT, "THIRD_PARTY_NOTICES.md"), path.join(PLUGIN_DIR, "THIRD_PARTY_NOTICES.md"));
  await copyPanelAssets();

  const hash = await computeSourceHash();
  await mkdir(path.dirname(SOURCE_HASH_PATH), { recursive: true });
  await writeFile(SOURCE_HASH_PATH, hash + "\n", "utf8");

  console.log("[build] 产物目录:", PLUGIN_DIR);
  console.log("[build] source-hash:", hash);
}

main().catch((err) => {
  console.error("[build] 失败:", err);
  process.exit(1);
});
