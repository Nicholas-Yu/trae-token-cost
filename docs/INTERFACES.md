# 模块接口契约（冻结版 v1 · v1.1 增补）

> v1.1 增补（0.2.0）：UsageEvent 计时字段（firstResponseMs/durationMs/timingSource）、
> 推理与完整性字段、store schema v4 列与耗时聚合、collector v2 断点与服务端计时通道。
> 其余条款维持 v1 冻结口径。

所有模块使用 **CommonJS**（`require` / `module.exports`），运行时**零第三方依赖**，仅 Node 内置模块。
Trae 扩展宿主运行在 Electron 39 / Node 22.21.1：`fetch`、`WebSocket`、`node:sqlite` 可用（已实测）。
本机开发/测试用系统 Node v24（`node --test test/`）。

项目根：`<repo-root>`

## 0. 分工与写权限

- Lead：`package.json`、`src/extension.js`、`src/ui/**`、`scripts/**`、`docs/**`、README、打包与验收。
- Teammate A（capture）：`src/capture/**`、`test/parser*.test.js`、`test/capture*.test.js`。
- Teammate B（platform）：`src/data/**`、`src/setup/**`、`src/host.js`、`test/store*.test.js`、`test/leader*.test.js`、`test/argv*.test.js`、`test/relaunch*.test.js`、`test/host*.test.js`。
- 不要修改他人 scope 内的文件；需要改契约先消息通知 Lead。

## 1. UsageEvent（采集 → 存储）

`src/capture/**` 产出、`src/data/store.js` 消费。

```js
{
  inputTokens: number,        // 必填，>=0
  outputTokens: number,       // 必填，>=0
  totalTokens: number,        // 缺省 = input + output
  cacheReadTokens: number,    // 缺省 0
  cacheWriteTokens: number,   // 缺省 0
  model: string,              // 缺省 'unknown'；normalizeModelName 后使用
  credits: number | null,     // 仅账单/明确字段才有，未知为 null
  sessionId: string | null,   // 原始 ID；存储时哈希
  messageId: string | null,   // 原始 ID；存储时哈希
  billingId: string | null,   // 账单响应里的会话 ID（原始），存储时哈希
  source: 'debugger' | 'network' | 'billing',
  observedAt: number,         // epoch ms，采集时刻
  endpoint: string | null,    // 网络来源的 URL（去 query，保留 host+path）
  targetId: string | null,    // CDP target id
  targetTitle: string | null, // CDP target title（窗口标题，用于主机归属）
  // --- v1.1 增补 ---
  reasoningTokens: number | null, // 推理 Token（输出子集）；未上报为 null，不猜测
  usageComplete: boolean,         // 计费四件套（input/output/cacheRead/cacheWrite）原始齐全
  creditKind: 'actual' | 'estimated', // credits 的口径；缺省按 actual
  firstResponseMs: number | null, // 首响应耗时（>0 有效）
  durationMs: number | null,      // 调用耗时（>0 有效）
  timingSource: 'network-inferred' | 'debugger-inferred' | null
  // network-inferred：本机可见 /completions POST 的 CDP 时间戳差；
  // debugger-inferred：断点白名单读取 Trae 回传的逐调用服务端计时
  // （platform_first_token_timing → firstResponseMs，server_processing_time → durationMs）。
}
```

## 2. capture/cdp.js（A）

```js
// 最小 CDP 客户端，使用全局 WebSocket（Node 22.21+）
class CdpConnection {
  constructor(wsUrl)
  async connect()                       // 5s 超时；连接后 on('close'|'error')
  send(method, params = {})             // Promise<result>；错误时 reject
  on(event, cb) / off(event, cb)        // 事件：CDP 事件名 + 'close' | 'error'
  close()
}

// HTTP 发现
async function discoverTargets({ host = '127.0.0.1', port, timeoutMs = 1500 })
// -> { version: object|null, targets: Array<{id,type,title,url,webSocketDebuggerUrl}> }
// 先 GET /json/version，再 GET /json/list；两者失败都抛错（调用方决定降级）
```

## 3. capture/parser.js（A）

```js
// 解析 JSON / SSE / 嵌套对象中的用量；返回 UsageEvent[]（source 由调用方覆盖）
function parseResponseBody(text, { url = null } = {}) -> UsageEvent[]
function extractUsageEvents(value, inherited = {}) -> UsageEvent[]   // 深扫，兼容嵌套/重复
function looksLikeUsage(value) -> boolean
function normalizeModelName(value) -> string   // 去空白、去“正式版”后缀；空 -> 'unknown'
```

要求：识别 `input_tokens|prompt_tokens|inputTokens`、`output_tokens|completion_tokens`、`total_tokens`、
`cache_read_input_tokens|cached_tokens|cacheReadInputTokens`、`cache_creation_input_tokens`、
`credits|credits_float|fee_usage.credits`、`model|model_name`、`session_id|sessionId`、`message_id|messageId`；
SSE 逐行 `data: {...}`，容忍 `[DONE]` 与非 JSON 行；同一 payload 内同一条用量只产出一次。

## 4. capture/collector.js（A）

```js
class TraeCollector extends EventEmitter {
  constructor({
    host = '127.0.0.1',
    port = 9222,
    debuggerEnabled = true,
    networkEnabled = true,
    pollIntervalMs = 3000,
    logger = () => {}
  })
  start()     // 立即一次 poll，然后定时 poll
  stop()
  getStatus() // -> { connected, targetCount, collectorCount, breakpointCount, lastCaptureAt, lastError }
}
// 事件：
// 'usage' (UsageEvent)
// 'status' (status 对象)
// 'log' ({level:'info'|'warn'|'error', message})
// 'diagnostic' ({type, ...})
```

行为：
- 轮询 `/json/list`，类型 `page|webview|iframe|worker|service_worker|background_page` 且带 `webSocketDebuggerUrl` 的目标。
- 每目标：`Runtime.enable`、`Network.enable({maxTotalBufferSize:50_000_000,maxResourceBufferSize:16_000_000})`、
  `Debugger.enable({maxScriptsCacheSize:50_000_000})`。
- `Debugger.scriptParsed`：URL 命中 `/workbench|trae|extensionHost|main|aiserver|chat/i` →
  `Debugger.getScriptSource`，搜 v2 标记 `fireTokenUsageReceived`（≤2 处）、`reportTokenUsage`（≤2 处，v1 兜底）、
  `fireMetadataReceived`（≤1 处，补 model）→ `Debugger.setBreakpoint`。
  `Debugger.paused`：按白名单读 callFrames[0] 的 local scope（`Runtime.getProperties` 递归，深度≤4，v2 通道≤5）→
  `extractTraeV2UsageEvents` / `extractUsageEvents`；`finally` 里 `Debugger.resume`，并加 1.8s 强制 resume 兜底。
- 耗时双通道（v1.1）：
  - debugger-inferred（Agent/SSH 主通道）：handle 断点的 `r.tracking.serverTimingEvents` 只读
    `server_processing_time` / `platform_first_token_timing` 两个数值，按 sessionId 缓存（10s 新鲜窗口防跨调用错配），
    附带到同会话 usage 事件；不读聊天正文。
  - network-inferred：`Network.requestWillBeSent/responseReceived/loadingFinished` 时间戳差；
    候选仅限 URL pathname 以 `/completions` 结尾的 POST（排除 OPTIONS 预检与辅助接口），
    同会话同轮唯一候选才关联；0ms/负值无效样本丢弃；未完成请求不附带半截耗时。
- `Network.responseReceived` + `loadingFinished`：仅当 URL 命中
  `/get_session_usage|commercial|chat|llm|completion|agent/i`、状态 <400、体积 <10MB 时
  `Network.getResponseBody` → `parseResponseBody`；`/get_session_usage` 的响应把 `credits_float` 标为
  实际积分（source='billing'，billingId 用响应里的 session_id）。
- 监听 `Network.webSocketFrameReceived` 作为兜底（帧文本解析同样走 parser）。
- 目标关闭/失败要清理；每个 target 的异常不能影响其他 target；连续发现失败时 `status.connected=false` 并限频重试。
- 采集到的 `UsageEvent.targetId/targetTitle` 必须带上。

## 5. data/store.js（B）

```js
class UsageStore {
  constructor(dbPath)   // 建 schema + WAL；方法可重复调用（幂等）
  record(event, { hostLabel = null, workspaceName = null } = {}) -> row
  recent({ limit = 200, sinceMs = null, hostLabel = null } = {}) -> row[]
  summary({ sinceMs = null } = {}) -> {
    total: {
      calls, total_tokens, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, actual_credits, estimated_credits, cache_hit_rate,
      // v1.1 耗时聚合（仅统计 >0 的有效值）：
      timed_calls, first_response_timed_calls, duration_ms_sum, first_response_ms_sum,
      timed_output_tokens, incomplete_calls, reasoning_tokens
    },
    models: [ { model, calls, total_tokens, input_tokens, output_tokens, cached_tokens, actual_credits, estimated_credits } ],
    hosts:  [ { host_label, calls, total_tokens, input_tokens, output_tokens, actual_credits, estimated_credits } ],
    days:   [ { day: 'YYYY-MM-DD', calls, total_tokens, input_tokens, output_tokens, actual_credits, estimated_credits } ], // 升序
    recent: row[]
  }
  csv({ sinceMs = null } = {}) -> string   // 带 UTF-8 BOM + CRLF
  clear()
  prune({ retentionDays = 180 } = {}) -> number   // 删除条数
  close()
}
module.exports = { UsageStore };
```

SQLite 表（字段名为准）：

```sql
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_key TEXT,
  observed_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  credits REAL,
  credit_kind TEXT NOT NULL DEFAULT 'unknown',   -- actual | estimated | unknown
  host_label TEXT,
  workspace_name TEXT,
  window_title TEXT,
  session_key TEXT,
  message_key TEXT,
  billing_key TEXT,
  endpoint TEXT,
  reasoning_tokens INTEGER,              -- v1.1：未上报为 NULL
  usage_complete INTEGER NOT NULL DEFAULT 0, -- v1.1
  first_response_ms INTEGER,             -- v1.1：>0 有效
  duration_ms INTEGER,                   -- v1.1：>0 有效
  timing_source TEXT,                    -- v1.1：network-inferred | debugger-inferred | NULL
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS calls_observed_at ON calls(observed_at DESC);
CREATE INDEX IF NOT EXISTS calls_model ON calls(model);
CREATE INDEX IF NOT EXISTS calls_turn_key ON calls(turn_key);
CREATE INDEX IF NOT EXISTS calls_host ON calls(host_label);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

去重/合并规则（按顺序，命中即更新而不是新增）：
1. `turn_key = sha256(sessionId|messageId)` 已存在 → 合并：token 取 max，`credit_kind='actual'` 优先，`source` 用逗号合并去重，空字段 COALESCE；
   计时字段（first_response_ms/duration_ms/timing_source）同样 COALESCE（保留首个已知值），`observed_at` 取较早值。
2. `billingId`（哈希后存 `billing_key`）命中已有行 → 同上合并。
3. 本次为 billing 且存在“同 model + 同 token 三件套 + 无实际积分”行（±15 分钟）→ 回填 credits。
4. 同 model + 同 token 三件套 + 10 秒内（跨通道重复）→ 合并。
5. 否则 INSERT。
若无 session/message id，`turn_key` 可为 NULL（不做规则 1）。`credits` 仅当 `event.credits` 是有限数时写入，`credit_kind='actual'`；若用户配置了费率且未拿到实际积分，由 extension 层决定是否估算（store 不估算，`estimated_credits` 汇总时按 `credit_kind='estimated'` 求 SUM，扩展可传 `creditKind:'estimated'` 的 credits）。
所有 ID 存储前 `sha256(id).slice(0,16)`。

## 6. data/leader.js（B）

```js
class LeaderElection extends EventEmitter {
  constructor({ dir, heartbeatMs = 2000, staleMs = 8000, logger = () => {} })
  start()        // 异步开始；在 dir 下维护 leader.json / status.json
  stop()
  get role()     // 'leader' | 'follower' | 'starting'
  getStatus()    // 最近一次状态（leader 写文件；follower 读文件）
  updateStatus(partial)   // 仅 leader；合并写 status.json，并更新 heartbeatAt
}
// 事件：'role' (role), 'status' (status), 'error' (err)
```

- 选举：读 `leader.json`；不存在或 `heartbeatAt` 超过 `staleMs` 则写入本进程候选（`nonce`）→ 回读确认自己获胜才成为 leader；否则 follower。
- leader 每 `heartbeatMs` 刷新 `leader.json`（含 pid/nonce/startedAt/heartbeatAt/version）。
- follower 每 1s 检查 leader 是否过期；过期则重新竞选，变化时 emit('role')。
- leader 退出时（`stop()`）删除自己拥有的 leader.json。
- `status.json` 结构：
```js
{ role, pid, startedAt, heartbeatAt, cdpConnected, targetCount, collectorCount,
  breakpointCount, lastCaptureAt, lastError, appVersion, platform }
```

## 7. src/host.js（B）

```js
function deriveHostLabel(windowTitle) -> string
// 解析 "[SSH: gpu-host]" / "[SSH:host]" / "[远程: gpu-host]" 形式 → 'gpu-host'；无法解析 → '本机'
function parseWindowTitle(windowTitle) -> { host: string|null, workspaceName: string|null }
function sanitizeWindowTitle(title) -> string   // 去掉 " — Trae CN"/" - Trae CN" 等后缀
```

## 8. src/setup/argv.js（B）

```js
function parseJsonc(text) -> object              // 容错 // 与 /* */ 注释、尾逗号
function readArgvFile(argvPath) -> { config, existed }
function enableCdp({ argvPath, port }) -> { changed, backupPath, config }
function disableCdp({ argvPath }) -> { changed, backupPath, config }
function copyBackupPath(backupPath) // 名称约定：argv.json.bak-<ISO时间戳>
```
要求：写前备份（权限 0600）；原子写（临时文件 + rename）；保留原键与缩进风格（2 空格 + 末尾换行即可）；重复调用幂等。

## 9. src/setup/relaunch.js（B）

```js
function buildWorkspaceArg({ remoteAuthority = null, workspaceFile = null, workspaceFolders = [] })
  -> { kind: 'file-uri' | 'folder-uri' | null, value: string | null }
function buildRelaunchSpec({ platform, appBundlePath, port, workspaceArg, restoreWindows = 'all' })
  -> { command: string, args: string[] }        // 纯函数，可单测
function createGuardScript({ platform, spec, logPath = null, tmpDir })
  -> { scriptPath, command, args }              // 返回“等待 Trae 退出后重开”的守护脚本
function launchDetached({ command, args }) -> void
function copyLaunchCommand(spec) -> string      // 供“复制启动命令”命令使用
```

macOS 说明：`appBundlePath` 形如 `/Applications/Trae CN.app`；
守护脚本流程 = `等待 `pgrep -f "<bundle>/Contents/MacOS/Electron"` 无进程 → sleep 1 → `open -n "<bundle>" --args --remote-debugging-port=<port> [workspace]`。
`restoreWindows` 为 `'all'`（默认）时不传 workspace 参数（依赖会话恢复，避免双开窗口）；
为 `'none'|'empty'` 且存在 workspaceArg 时才传。Windows/Linux 给出尽力而为的命令字符串。

## 10. 扩展侧（Lead）

- 记录富化：`hostLabel = deriveHostLabel(event.targetTitle)`；`workspaceName = parseWindowTitle(...).workspaceName`；
  当前窗口自身信息（`vscode.env.remoteName/remoteAuthority`、`vscode.workspace.name`）用于状态栏/仪表盘展示。
- 服务端（leader）流程：`UsageStore` + `LeaderElection` + `TraeCollector`；只有 leader 启动 collector；
  `election.updateStatus(collector.getStatus())`；follower 只读 DB（`new UsageStore(dbPath)` 只读查询）。
- 范围换算：`today` 本地 0 点、`week` 本周一 0 点、`month` 本月 1 日 0 点、`all` null。
- 状态栏/仪表盘只消费本契约，不直接碰 CDP。

## 11. Webview 消息协议

扩展 → webview：`{ type: 'update', payload: { summary, recent, status, context, config } }`
webview → 扩展：`{ type: 'refresh', range }`、`{ type: 'export', format, range }`、
`{ type: 'enableCapture' }`、`{ type: 'disableCapture' }`、`{ type: 'diagnostics' }`、
`{ type: 'clearData' }`、`{ type: 'openReadme' }`
`range` ∈ `today|week|month|all`。

## 12. 测试约定

- `node --test test/*.test.js`（Node 24 上目录参数不可用），每个测试文件独立、使用 `os.tmpdir()` 下临时目录建库。
- 不依赖网络、不读写 `~/.trae-cn`、不启动 Trae。
- parser 测试需有合成 fixture（SSE 两段 usage + 账单 JSON + 嵌套对象 + 缺字段 + 重复）。
- 可用 `node:sqlite`（系统 Node 24 与 Trae 内 Node 22.21 均可用）。
