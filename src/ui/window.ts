import type { PluginContext } from "../types/cyrene";
import type { BrowserWindow } from "electron";
import type { Logger } from "../logger";
import { PROVIDERS } from "../core/providers";

type ElectronMainModule = typeof import("electron");

export interface WindowManager {
  open(ctx: PluginContext): Promise<void>;
  close(): void;
}

const WINDOW_TITLE = "星驿 · Astral Relay";
const WINDOW_WIDTH = 760;
const WINDOW_HEIGHT = 640;

/**
 * 配置窗口管理器：
 * - 懒加载 electron，无 GUI 环境下降级为 warn；
 * - 同一时刻只保留一个窗口；
 * - 绑定 ctx.signal，插件注销即关窗。
 */
export function createWindowManager(deps: { log: Logger }): WindowManager {
  const { log } = deps;
  let win: BrowserWindow | null = null;

  const close = (): void => {
    const target = win;
    win = null;
    if (!target) return;
    try {
      if (!target.isDestroyed()) target.close();
    } catch (err) {
      log.warn("关闭窗口失败：", err instanceof Error ? err.message : String(err));
    }
  };

  const open = async (ctx: PluginContext): Promise<void> => {
    if (ctx.signal.aborted) return;
    ctx.signal.addEventListener("abort", close, { once: true });

    if (win && !win.isDestroyed()) {
      try {
        if (win.isMinimized()) win.restore();
        win.focus();
      } catch (err) {
        log.warn("聚焦窗口失败：", err instanceof Error ? err.message : String(err));
      }
      return;
    }
    win = null;

    try {
      const electron = require("electron") as ElectronMainModule;
      const created = new electron.BrowserWindow({
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
        minWidth: 560,
        minHeight: 480,
        title: WINDOW_TITLE,
        autoHideMenuBar: true,
        backgroundColor: "#fff8fb",
        // 面板是随插件分发的受信静态页，panel.js 直接用 ipcRenderer。
        webPreferences: { nodeIntegration: true, contextIsolation: false },
      });
      // Documentation belongs in the system browser, never in a Node-enabled plugin window.
      const documentationUrls = new Set(PROVIDERS.map((provider) => provider.termsUrl));
      created.webContents.setWindowOpenHandler(({ url }) => {
        if (documentationUrls.has(url)) void electron.shell.openExternal(url).catch(() => log.warn("无法打开文档链接"));
        return { action: "deny" };
      });
      created.webContents.on("will-navigate", (event) => event.preventDefault());
      created.on("closed", () => {
        if (win === created) win = null;
      });
      win = created;
      await created.loadFile(`${__dirname}/panel/index.html`);
      if (ctx.signal.aborted) close();
    } catch (err) {
      log.warn("打开窗口失败：", err instanceof Error ? err.message : String(err));
      close();
    }
  };

  return { open, close };
}
