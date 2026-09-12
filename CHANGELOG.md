# Changelog

本插件遵循 [SemVer](https://semver.org/lang/zh-CN/)。版本号三段式由 `manifest.json`
与 `package.json` 同步维护——发布前跑 `npm run check-sync` 防止产物静默失效。

## [0.3.1] - 2026-09-12

- 移除 Codex / Grok 由插件额外施加的 Code-only 限制，支持 Chat / Work / Learn / Code
- Codex / Grok 接受正常面板 token，无需宿主模式凭据改动；Qwen / 腾讯 Coding Plan 保持 Code-only
- 回归验证 OAuth 全模式放行、旧宿主 token 兼容及错误 token 拒绝

## [0.3.0] - 2026-09-12

- 新增 Codex / Grok 浏览器 OAuth 连接、取消、断开、自动刷新及模型目录
- 所有出站 HTTP 使用 Electron `net.fetch()`，包括原有订阅 Key 代理
- Codex 原生 Responses 与 Grok Chat Completions 直通，保留工具续轮并真正流式转发
- Codex / Grok 本集成使用逐请求 Code 会话验证；移除 README 对 Codex 的一概排除
- OAuth 凭据仅进入安全存储；刷新与断开并发时不会重新写回已断开的账号

## [0.2.0] - 2026-09-12

改名：编程套餐直通 → **星驿 · Astral Relay**（插件 id `coding-plan-gate` → `astral-relay`）。
定位从「只做编程套餐」扩展为「BYOS 中转站」，闸门从插件级降为**厂商级的一层**。

### 新增

- 多厂商目录（`src/core/providers.ts`），按条款分 `kind`：
  `general` 全模式可用、`coding-only` 仅 Code 模式、`agent-cli` 需驱动本地 CLI
- MiniMax Token Plan（`general`），支持国际站 / 中国大陆双端点切换
- 代理改为按路径分路：`/p/<厂商>/v1/*`，一个端口服务全部厂商；
  不靠模型名猜厂商（多家同名模型时必然出错）
- 面板重做为多厂商卡片：每家独立的 Key、区域、Base URL 与放行范围徽章
- GitHub Copilot 作为 `agent-cli` 类目入库，但 `available: false` 置灰——
  条款允许，卡在打包（SDK 依赖 koffi 原生模块并自带 CLI 二进制）

### 修复

- 编程套餐逐请求验证宿主模式凭据，阻止并发 Chat/Work 借用 Code 活动窗口
- 旧宿主缺少模式凭据时明确拒绝编程套餐，通用 BYOS 保持可用
- 面板定时刷新不再每 3 秒清空正在输入的 Key

- **腾讯云端点写错了**：0.1.0 用的是按量付费的 `api.lkeap.cloud.tencent.com/v1`，
  实际 Coding Plan 专属端点是 `.../coding/v3`。官方文档明确写了两套
  Key 与 Base URL「不互通，请勿混用」，填错会直接鉴权失败。
  `tests/providers.test.ts` 加了回归钉子。

### 兼容性

- 破坏性：插件 id 与 secrets 键名都变了（`coding_plan_key_*` → `astral_relay_key_*`），
  0.1.0 存的 Key 不会被读到，需要在面板里重填一次
- 模型档案的 Base URL 形态变了（多了 `/p/<厂商>` 段），需要重新填

## [0.1.0] - 2026-09-12

### 新增

- 闸门：只在 Code 模式的交互式会话轮次开窗，定时任务与其它模式一律拒绝
- 受闸门约束的本地代理，转发到所选套餐官方端点并注入订阅 Key
- 通义千问 / 腾讯云 / MiniMax 三家套餐目录，各附厂商条款链接
- 配置面板：选套餐、存 Key、查看闸门状态与模型档案填写值
