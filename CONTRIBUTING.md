# Contributing

## 环境

- Node.js 22+（CI 跑 22 与 24）
- npm；仓库经 `.gitattributes` 统一为 LF

## 目录

```text
astral-relay/
├── manifest.json      # Cyrene 插件清单
├── src/
│   ├── core/          # gate.ts（闸门）+ providers.ts（厂商目录）
│   ├── proxy/         # 按厂商分路的本地代理
│   ├── ui/            # 窗口、面板 IPC、面板静态页
│   ├── types/         # Cyrene / electron 的最小本地类型面
│   └── index.ts       # register / unregister / open
├── tests/             # vitest
├── scripts/           # build.mjs / check-sync.mjs / deploy.mjs
└── dist/              # 构建产物（gitignored，绝不手改）
```

`src/` 是唯一事实源，`dist/` 是产物。改完 `src/` 必须 `npm run build`。
`check-sync.mjs` 会在打包前比对源码哈希，改了源码没重建会直接 exit 1。

## 本地开发

```bash
npm ci
npm run typecheck
npm run build      # 契约测试要先有产物
npm test
npm run deploy     # 装到本机 Cyrene
```

## 硬性规则（违反会被退回）

1. **不得放宽模式验证。** `coding-only` 厂商必须验证宿主签名的 `mode=code` 与 `source=conversation`。
2. **不得绕过 token / 模式凭据校验。** 活动时间窗仅用于诊断，不能授权请求。
3. **改 `kind` 必须有条款依据。** 把 `coding-only` 改成 `general` 等于取消该厂商的
   全部约束，PR 里必须贴出厂商原文。
4. **订阅 Key、OAuth token 与授权码不进日志、不进 IPC 返回值。** 所有出站 HTTP 使用 Electron `net.fetch()`。
5. **新增厂商必须附接入依据并说明接口性质。** Grok OAuth 使用 xAI 共享客户端，端点取自其公开 OIDC discovery；
   不接受把私有后端（如 chatgpt.com/backend-api/*）当作第三方接入面的 PR。
   Z.ai / Anthropic / Google 暂不收录，`tests/providers.test.ts` 覆盖目录边界。
6. **零运行时依赖。** 面板渲染只允许 `textContent`。

## 关于 Copilot

Copilot 在目录里但 `available: false`。要把它做出来，正确路线是驱动用户自己
安装并登录的 `copilot --headless --port N`，走 JSON-RPC——**不要**引入
`@github/copilot-sdk`（依赖 koffi 原生模块并自带 CLI 二进制，违反第 6 条）。
提交前必须在装了 CLI 的机器上实测通过，不接受未验证的协议实现。

## 提交

- 提交信息与注释一律中文
- 改了边界行为必须同步改测试与 README「已知限制」
