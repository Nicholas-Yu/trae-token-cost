# 采集原理与适配指南（Trae 3.4.x）

本文记录「Trae Token 用量」的数据来源、实测抓到的 payload，以及 Trae 升级后如何重新定位采集点。

## 1. 背景：SSH 远程窗口里聊天在哪里跑

在 Trae CN 3.4.16 的 SSH 远程窗口中：

- **聊天 UI / 渲染**：本机渲染进程（workbench 页面，加载 `@byted-icube/ai-modules-chat/dist/index.mjs`）。
- **LLM 请求 / agent 执行**：远程服务器上的 Rust 组件（`~/.trae-cn-server/.../modules/ai-agent/harness-server`）。因此本机渲染进程的网络面板里看不到聊天 SSE 请求（只有 `get_session_usage` 等辅助请求）。
- **token 用量**：由远程 agent 随流式事件回传到本机渲染进程，最终走 ai-chat v2 的 `StreamEvents` 派发。

结论：**本机 CDP 钩住渲染进程的事件派发点**即可统计 SSH 窗口的用量，无需在远程服务器安装任何东西。

## 2. v2 采集点（当前主通道）

聊天 bundle 内（本项目实测位置：`node_modules/@byted-icube/ai-modules-chat/dist/index.mjs:6673` 附近）：

```js
// StreamEvents 服务
fireTokenUsageReceived(e) { this._onTokenUsageReceived.fire(e) }
```

断点命中时，`callFrame` 的 local scope：

```js
local = { e: { sessionId: '...', tokenUsage: { ... } } }
```

`tokenUsage` 实测字段（Trae 3.4.16，SSH 远程窗口）：

```json
{
  "input": "0.000",
  "output": "0.000",
  "last_turn_total_tokens": 35820,
  "max_tokens": 1179648,
  "completion_tokens": 25,
  "prompt_tokens": 35795,
  "reasoning_tokens": 15,
  "total_tokens": 35820,
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 34816,
  "prompt_tokens_total": 0,
  "completion_tokens_total": 0,
  "reply_to_message_id": "redacted-id",
  "__packet_seq__": 10
}
```

同一轮 agent 会有多次 LLM 调用，每次一个 `__packet_seq__`；用量数值是该次调用的（不是累计）。扩展按 `reply_to_message_id + __packet_seq__` 区分记录，合计即轮次消耗。

### 模型名

两个来源：

1. `fireMetadataReceived(e)`，`e = { sessionId, metadata }`，metadata 里可能有 `model` / `model_name`；
2. 断点在 `fireTokenUsageReceived` 的**第二处**（handle 闭包）时，local scope 里有 stream context：

```js
local = {
  e: { ... tokenUsage 字段 ... },
  t: '<sessionId>',
  r: { sessionId, tracking: { model: 'deepseek-flash', modelStrategy: 'manual', ... } }
}
```

扩展会把 `r.tracking.model` 记到 `sessionId -> model` 映射，后续同会话事件自动带上模型名。

### 去重

同一个 token 包会被不同形状的断点各命中一次（字段位置不同导致 messageId 可能一个带 packet_seq、一个不带），因此扩展同时使用：

- 主键：`sessionId + reply_to_message_id + __packet_seq__`；
- 指纹键：`sessionId + prompt_tokens + completion_tokens + total_tokens`（15 秒窗口）。

### 服务端耗时（debugger-inferred）

Agent/SSH 模式的 LLM 请求由远程 ai-agent 发出，本机渲染进程网络面板看不到（实测只有遥测与辅助请求），网络耗时通道无法覆盖。但 handle 断点的 stream 上下文里有 Trae 自己的计时状态：

```js
local.r = { sessionId, tracking: { startTime, firstTokenTime, serverTimingEvents, ... } }
// serverTimingEvents 来自流式 timing 事件的 server_timing_info，逐 LLM 调用更新：
// { server_processing_time: 3257, platform_first_token_timing: 2005, name: 'llm_raw_chat_v2', ... }
```

扩展只按白名单读取 `server_processing_time`（该次调用服务端处理耗时 → duration_ms）与 `platform_first_token_timing`（服务端首 Token 耗时 → first_response_ms），按 sessionId 缓存（10 秒新鲜窗口，防止跨调用错配），附带到 usage 事件，`timingSource='debugger-inferred'`。不读取聊天正文；服务端口径不含客户端网络往返。

## 3. 旧版 v1 通道（兼容）

旧版聊天管线（Trae 3.3.x 等）用：

```js
reportTokenUsage(usage, chatContext)
```

`usage` 里有 `prompt_tokens/completion_tokens/total_tokens/cache_read_input_tokens/...`。
扩展仍保留该断点与参数解析，作为旧版本/其它窗口类型的兜底。

## 4. 排查 / 重新适配（Trae 升级后）

1. 确认调试端口已生效：

   ```bash
   curl -s http://127.0.0.1:9222/json/version
   curl -s http://127.0.0.1:9222/json/list
   ```

2. 跑探针（会枚举 target、抓聊天 bundle 源码、在候选函数上打断点并 dump 局部变量）：

   ```bash
   node scripts/probe-cdp.mjs --port 9222 --out probe-output --seconds 300
   # 然后在 Trae 里发一条 AI 消息
   ```

3. 看 `probe-output/log.txt`：确认 `chat bundle found`、`breakpoint set`、`paused` 是否出现；
   若脚本 URL 变化，用 `grep -o "token_usage" probe-output/scripts/source-*.js` 找新的事件派发函数。
4. 用 [v2 探针](scripts/probe-v2.mjs)（在 `fireTokenUsageReceived` / `handleTokenUsage` / `reportTokenUsage` 上打断点）快速验证新版本是否仍派发同样事件：

   ```bash
   node scripts/probe-v2.mjs 9222 probe-v2 240
   ```

5. 若事件名/入口变了：在聊天 bundle 源码里搜 `token_usage`、`TokenUsage`、`onTokenUsageReceived`；
   v2 处理链通常包括 `StreamEvents.fireTokenUsageReceived` → `handleTokenUsage` → `storeService.updateMessage(..., { tokenUsage })`。
   把新函数名加入 `src/capture/collector.js` 的 `BREAKPOINT_MARKS`，并按新 payload 调整 `extractTraeV2UsageEvents`。

## 5. 安全说明

- CDP 只绑定 `127.0.0.1`；本机任意进程可连接（CDP 固有性质），不要转发到局域网/公网。
- 采集只读取调试作用域中的 token 数值、模型名、会话 ID（落库前哈希），不读取提示词/回答正文。
