# Changelog

本插件遵循 [SemVer](https://semver.org/lang/zh-CN/)。版本号三段式由 `manifest.json`
与 `package.json` 同步维护——发布前跑 `npm run check-sync` 防止产物静默失效。

## [0.1.0] - 2026-09-12

### 新增

- 闸门（`src/core/gate.ts`）：只在 Code 模式的交互式会话轮次开窗，
  定时任务、朋友圈发帖与其它模式一律拒绝
- 受闸门约束的本地代理（`src/proxy/server.ts`）：OpenAI 兼容协议，
  放行后转发到所选套餐官方端点并注入用户自己的订阅 Key
- 套餐目录（`src/core/plans.ts`）：通义千问 Coding Plan、腾讯云 Coding Plan、
  MiniMax Token Plan；每条都附厂商条款链接
- 配置面板：选套餐、存 Key（写宿主安全存储）、查看闸门状态与模型档案填写值

### 已知限制

- 闸门是时间窗而非逐请求绑定：宿主不会把轮次标识带进 HTTP 头，开窗期间
  同一档案的其它模式请求会被放行。详见 README「已知限制」一节。
