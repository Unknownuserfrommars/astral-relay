# Contributing

## 环境

- Node.js 22+（CI 跑 22 与 24）
- npm；仓库经 `.gitattributes` 统一为 LF

## 目录

```text
coding-plan-gate/
├── manifest.json      # Cyrene 插件清单
├── src/
│   ├── core/          # gate.ts（闸门）+ plans.ts（套餐目录）
│   ├── proxy/         # 受闸门约束的本地代理
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

1. **不得放宽闸门。** `modes:["code"]` 与 `sources:["conversation"]` 是合规基础，
   放宽等于把套餐 Key 暴露给定时任务与发帖决策。
2. **不得绕过 `gate.check`。** 任何新的转发路径都必须先过闸门。
3. **订阅 Key 不进日志、不进 IPC 返回值。**
4. **新增套餐必须附厂商条款链接**，且条款须允许第三方编程工具使用。
   Z.ai / Anthropic / OpenAI 订阅不接受，`tests/plans.test.ts` 有回归钉子。
5. **零运行时依赖。**
6. 面板渲染只允许 `textContent`。

## 提交

- 提交信息与注释一律中文
- 改了边界行为必须同步改测试与 README「已知限制」
