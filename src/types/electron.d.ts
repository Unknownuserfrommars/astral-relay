/**
 * electron 最小类型声明：只为本插件的调用点过 typecheck，
 * 不把 electron 安装为依赖。真实 API 以运行时为准。
 */
declare module "electron" {
  export interface BrowserWindowConstructorOptions {
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    title?: string;
    autoHideMenuBar?: boolean;
    backgroundColor?: string;
    webPreferences?: {
      nodeIntegration?: boolean;
      contextIsolation?: boolean;
    };
  }

  export class BrowserWindow {
    constructor(opts?: BrowserWindowConstructorOptions);
    loadFile(path: string): Promise<void>;
    focus(): void;
    restore(): void;
    close(): void;
    isDestroyed(): boolean;
    isMinimized(): boolean;
    on(event: string, listener: (...args: unknown[]) => void): void;
  }

  export const ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<any>;
  };
}
