<h1 align="center">编程套餐直通 · Coding Plan Gate</h1>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-ff69b4?style=flat-square" alt="version">
  <img src="https://img.shields.io/badge/TypeScript-strict-ff69b4?style=flat-square" alt="typescript">
  <img src="https://img.shields.io/badge/node-22%2B-ff69b4?style=flat-square" alt="node">
  <img src="https://img.shields.io/badge/platform-Cyrene%20Plugin%20API%20v1-ff69b4?style=flat-square" alt="platform">
  <img src="https://img.shields.io/badge/runtime%20deps-0-ff69b4?style=flat-square" alt="zero deps">
</p>

用你自己的**编程套餐订阅**驱动 Cyrene，不用再单独买按量付费额度——
但**只在 Code 模式的交互式对话里生效**。

## 为什么有这个插件

通义千问、腾讯云、MiniMax 的编程套餐都允许把套餐 Key 用在「编程工具」里，
但都明确禁止用于自动化脚本、应用后端与非交互式批量调用。

Cyrene 不只有你敲字的 Code 模式，还有定时任务、朋友圈发帖、渠道消息这些
无人值守路径。它们共用同一套模型档案——如果你只是把套餐 Key 填进模型档案，
这些路径同样会用它发请求，那就越界了，后果是**订阅被暂停或 Key 被封禁**。

本插件存在的唯一理由，就是给这件事加一道**执行得住的闸门**，而不是靠自觉。

## 它怎么工作

```text
Code 模式发消息
      │
      ▼
宿主调用 prompt provider（modes:["code"] + sources:["conversation"]）
      │  ← 定时任务与发帖决策根本不会走到这里
      ▼
闸门开窗
      │
      ▼
本地代理 127.0.0.1  ──放行──▶  套餐官方端点（注入你的订阅 Key）
      │
      └─ 闸门关着 ──▶ 403，并说明原因
      │
      ▼
turn:finished → 关窗
```

## 支持的套餐

| 套餐 | Key 前缀 | 条款 |
|---|---|---|
| 通义千问 Coding Plan | `sk-sp-` | [阿里云文档](https://help.aliyun.com/zh/model-studio/coding-plan) |
| 腾讯云 Coding Plan | `sk-sp-` | [腾讯云文档](https://cloud.tencent.com/document/product/1823/130092) |
| MiniMax Token Plan | `sk-cp-` | [MiniMax 文档](https://platform.minimax.io/docs/token-plan/intro) |

**明确不收录**，且不接受 PR 添加：

- **Z.ai GLM Coding Plan** —— 条款点名禁止用于「自有应用、机器人、网站、SaaS」，支持工具是封闭列表
- **Anthropic Claude 订阅** —— 第三方产品不得提供 claude.ai 登录或额度
- **ChatGPT / Codex 订阅** —— 第三方客户端直连 Codex 后端没有公开契约

## 安装

```bash
npm install
npm run deploy   # 构建并拷贝到 %APPDATA%/live2d-cyrene/plugins/
```

然后在 Cyrene 插件面板点「刷新插件」，手动启用，再点「打开」配置。

## 配置

1. 面板里选套餐，填订阅 Key（写入宿主安全存储，不落明文、不进日志）
2. 把面板显示的 **Base URL** 和 **token** 填进 Cyrene 的模型档案，协议选 OpenAI 兼容
3. token 每次启动随机生成，重启 Cyrene 后需要重新填

## 已知限制

**闸门是时间窗，不是逐请求绑定。** 模型档案里的 apiKey 是静态的，宿主也不会把
轮次标识带进 HTTP 头，所以代理无法把某个请求认到某一轮。开窗期间，你在另一个
窗口用同一个档案发起的 Chat 轮次会被放行。调小「开窗存活上限」能缩小窗口，消不掉。

**关窗不认轮次。** provider 的入参里没有 runId，runId 只出现在 turn:finished，
两者对不上，所以任何一次轮次结束都会关窗。宁可关早也不关晚。

要彻底解决这两条，需要宿主把轮次上下文带进请求——那是上游 API 的事。

## 免责

条款随时会变，最终解释权在各厂商。**使用前请自己点开上表的条款链接复核**，
本插件不对你的账号状态负责。
