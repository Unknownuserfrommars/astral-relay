# Changelog

本插件遵循 [SemVer](https://semver.org/lang/zh-CN/)。版本号三段式由 `manifest.json`
与 `package.json` 同步维护——发布前跑 `npm run check-sync` 防止产物静默失效。

## [0.5.0] - 2026-09-12

### 新增

- **Code 轮次绑定（`src/core/turn-binding.ts`）：编程套餐不再需要任何宿主改动。**
  prompt provider 在 Code 会话轮次登记用户输入的 SHA-256 指纹（折叠空白，不存原文），
  代理核对请求体里最后一条 user 消息的指纹，命中才放行。
  provider 在宿主构建请求之前被 await，用户输入又原样出现在出站请求体里，
  所以登记必然早于验证，不存在竞态。
- `ar1` 签名凭据的 nonce 首用计时：第一次出现即开始计时，超过 2 小时不再接受，
  把 issuedAt 给出的 24 小时重放窗口收缩到首用后的短窗。
  刻意不做「只许用一次」——同一轮的流式重试与工具续轮共用同一个凭据，
  严格去重会把工具续轮打断，那是拿可用性换一个假的严密性。
- 面板新增 Code 轮次登记数；`get-state` 只回传数量，不回传原文或指纹。

### 变更

- **HMAC 验签保留，没有删除。** 0.5.0 是「加了一条自包含路径」，不是「换掉一条路径」。
  代理带签名时以签名为准、不回退到内容匹配；不带签名才走内容匹配。
  验签这一侧（`readRelayContext`）本来就完全在插件内部，不需要宿主提供任何文件。
- `docs/host-integration.md` 从「必读的前置要求」改写为「可选的更强路径」，
  并写明上游 Cyrene 没有、也不计划有这项改动：为了一个插件去改宿主源码，
  那是补丁不是插件。
- 面板去掉遗留的「Codex / Grok 通过浏览器连接」（0.4.0 已移除 Codex）；
  闸门文案改为如实描述两条判定路径。
- `THIRD_PARTY_NOTICES.md` 不再声称包含 Codex 兼容处理与 Responses 终端输出修复——
  两者都随 0.4.0 删除了，继续写着就是不实描述。
- 上游 user-agent 随版本号更新为 `astral-relay/0.5.0`。

### 修复

- Code 轮次登记的过期边界与 `gate.ts` 对齐：正好到 TTL 仍然有效，超过才失效
  （原实现会把刚好到点的登记提前扫掉）。

### 已知限制（写清楚，不含糊）

- 内容绑定证明的是「这段输入确实来自一次 Code 交互」，不是「这个请求由那一轮发出」。
  同一段文本在 TTL 内于其它模式重发会通过；要堵这个缺口必须由宿主逐请求签名。
- 两条路径都不隔离持有本地 token 的本机程序——插件的信任模型本来就不防它。
- 登记不认轮次结束：provider 入参里没有 runId，只能靠 TTL 与条目上限收口。

## [0.4.0] - 2026-09-12

### 移除

- **整体移除 Codex**。`chatgpt.com/backend-api/codex` 是私有后端，没有面向第三方的公开契约
  （openai/codex#36886 至今无官方答复）。需要 Codex 的用户改用宿主 MCP 接入本机已登录的
  `codex mcp-server`，额度同样走自己的 ChatGPT 订阅，不需要插件代劳。
- 随之删除 `proxy/responses.ts`（Codex 专用 SSE 修复）及其测试。

### 变更

- Grok 的 `referrer="opencode"` 已删除：本插件不是 OpenCode，这是唯一真正失实的字段。
- 上游 user-agent 改为 `astral-relay/0.4.0` 自报家门，不再伪装 `grok-build-cli`。
- specs 端点改注为取自 xAI 自己发布的 OIDC discovery，而非从第三方构建中提取的常量。
- Grok 标记为 **experimental**，面板显示实验性提示。

### 新增

- Grok 设备码登录（RFC 8628）：与原有回环回调流程**并存**而非替换，
  因为回调流程有测试覆盖且可用，用未实测实现替换可用实现是倒退。
- 设备码轮询遵循服务端 `interval`，正确处理 `authorization_pending` 与 `slow_down`；
  token 端点错误只透出 OAuth 错误码，不回显响应正文。
- 轮询等待可注入（`sleep` seam），测试不再空等（设备码用例 4193ms → 154ms）。

### 已知代价

- 随 Codex 一并删除的还有其工具续轮与非流式收集两条用例，那是能跑通的真实覆盖。
- `server.ts` 中 protocol 不匹配的 400 分支目前无厂商可覆盖，保留给将来的 responses 厂商。
- Grok 无端到端验证：开发机没有 SuperGrok / X Premium 账号。

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
