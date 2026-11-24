'use strict';

/**
 * Trae CDP 用量采集器。
 *
 * 契约见 docs/INTERFACES.md 第 4 节：
 *   class TraeCollector extends EventEmitter { start(); stop(); getStatus(); }
 *   事件：'usage' (UsageEvent) / 'status' / 'log' / 'diagnostic'
 *
 * 三条采集通道：
 *   1. Debugger 断点：定位 v2/v1 调用点，paused 时仅按协议白名单读取用量与模型上下文；
 *   2. 网络响应体：URL 白名单内的 response body 交给 parser；`get_session_usage` 额外解析 credits_float；
 *   3. WebSocket 文本帧兜底：帧文本同样走 parser。
 *
 * 设计原则：任何单目标/单通道异常都被隔离，采集器本身永不因 Trae 版本变化而崩溃；
 * 未知 payload 优雅降级（少采集/零采集）。所有 paused 事件在 finally 与 1.8s 兜底定时器中 resume。
 */

const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');

const { CdpConnection, discoverTargets } = require('./cdp');
const {
  parseResponseBody,
  extractUsageEvents,
  extractBillingEvents,
  parseJsonValues,
  endpointOfUrl,
  normalizeModelName
} = require('./parser');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const TARGET_TYPES = new Set(['page', 'webview', 'iframe', 'worker', 'service_worker', 'background_page']);

const SCRIPT_URL_RE = /workbench|trae|extensionHost|main|aiserver|chat/i;
// Trae 3.4.x（ai-chat v2，SSH 远程窗口同样经过本地渲染进程）：
//   fireTokenUsageReceived(payload) → { sessionId, tokenUsage: { prompt_tokens, ... } }
// 旧版 v1 用 reportTokenUsage；metadata 事件用于补 model。
const BREAKPOINT_MARKS = [
  { mark: 'fireTokenUsageReceived', max: 2 },
  { mark: 'reportTokenUsage', max: 2 },
  { mark: 'fireMetadataReceived', max: 1 }
];
const MAX_BREAKPOINTS_PER_SCRIPT = 5;
const MAX_SCRIPTS_PER_TARGET = 80;
const MAX_SCAN_CONCURRENCY = 3;
const MAX_BUFFERED_SCRIPTS = 100;
const MAX_SCRIPT_SOURCE_LENGTH = 32 * 1024 * 1024; // Trae 3.4.16 的 ai-modules-chat/index.mjs 约 15.8MB

const NETWORK_URL_RE = /get_session_usage|commercial|chat|llm|completion|agent/i;
// 耗时候选只认生成接口：按 URL 路径的 /completions 结尾判断，
// 排除 get_session_usage 等辅助接口，以及查询参数里 chat/agent 字样造成的多候选误判。
const TIMING_PATH_RE = /\/completions\/?$/i;
const BILLING_URL_RE = /get_session_usage/i;
const MAX_BODY_LENGTH = 10 * 1024 * 1024; // 10MB
const MAX_WS_FRAME_LENGTH = 2 * 1024 * 1024;
const MAX_PENDING_RESPONSES = 2000;

const MAX_PROP_DEPTH = 4;
const PROPERTY_BUDGET = 400;

const CONNECT_TIMEOUT_MS = 5000;
const DISCOVERY_TIMEOUT_MS = 1500;
const COMMAND_TIMEOUT_MS = 3000;
const SOURCE_FETCH_TIMEOUT_MS = 15000;
const BODY_FETCH_TIMEOUT_MS = 4000;
const PROP_TIMEOUT_MS = 2000;
const RESUME_TIMEOUT_MS = 1500;
const PAUSED_FALLBACK_MS = 1800;

const TARGET_RETRY_MS = 15000;
const DEDUPE_TTL_MS = 10000;
const DEDUPE_MAX = 1000;
// 账单响应通常只有 credits_float + session_id；把它和最近一次同 session 的用量对齐，
// 才能让 store 的「billing 回填」规则命中（extension 也会过滤 0 token 事件）。
const RECENT_USAGE_TTL_MS = 5 * 60 * 1000;
const RECENT_USAGE_MAX = 100;
const TIMING_TTL_MS = 5 * 60 * 1000;
const TIMING_MAX_PENDING = 200;
// 服务端耗时缓存：handle 帧与定义帧相隔毫秒级；超过新鲜窗口视为陈旧，
// 不得把上一次调用的耗时错配给新调用。
const SERVER_TIMING_FRESH_MS = 10 * 1000;
const SERVER_TIMING_MAX = 100;

function makeWhitelist(names) {
  return Object.fromEntries(names.map((name) => [name, null]));
}

const USAGE_DETAILS_WHITELIST = makeWhitelist([
  'cached_tokens', 'cachedTokens', 'cache_read_input_tokens', 'cacheReadInputTokens',
  'cache_read_token', 'cache_read_tokens', 'cache_creation_input_tokens',
  'cacheCreationInputTokens', 'cache_creation_token', 'cache_creation_tokens',
  'cache_write_tokens', 'cacheWriteInputTokens', 'reasoning_tokens', 'reasoningTokens'
]);
const TOKEN_USAGE_WHITELIST = {
  ...makeWhitelist([
    'input_tokens', 'prompt_tokens', 'input_token', 'inputTokens', 'promptTokens',
    'output_tokens', 'completion_tokens', 'output_token', 'outputTokens', 'completionTokens',
    'total_tokens', 'totalTokens', 'cache_read_input_tokens', 'cacheReadInputTokens',
    'cache_read_token', 'cached_tokens', 'cachedTokens', 'cache_read_tokens',
    'cache_creation_input_tokens', 'cacheCreationInputTokens', 'cache_creation_token',
    'cache_creation_tokens', 'cache_write_tokens', 'cacheWriteInputTokens',
    'reasoning_tokens', 'reasoningTokens', 'model', 'model_name', 'modelName',
    'session_id', 'sessionId', 'sessionID', 'agentMessageId', 'agent_message_id',
    'reply_to_message_id', 'replyToMessageId', 'message_id', 'messageId',
    'assistantMessageId', '__packet_seq__', 'packet_seq',
    'credits', 'credits_float', 'creditsFloat', 'credit'
  ]),
  prompt_tokens_details: USAGE_DETAILS_WHITELIST,
  completion_tokens_details: USAGE_DETAILS_WHITELIST,
  input_tokens_details: USAGE_DETAILS_WHITELIST,
  output_tokens_details: USAGE_DETAILS_WHITELIST
};
const MODEL_WHITELIST = makeWhitelist(['model', 'model_name', 'modelName']);
// Trae 随流式事件回传的服务端计时（server_timing_info）：逐 LLM 调用更新。
// Agent/SSH 模式生成请求不经本机渲染进程，网络通道看不到，只能从这里取耗时。
const SERVER_TIMING_WHITELIST = makeWhitelist(['server_processing_time', 'platform_first_token_timing']);
const V2_LOCAL_WHITELIST = {
  e: {
    ...TOKEN_USAGE_WHITELIST,
    tokenUsage: TOKEN_USAGE_WHITELIST,
    metadata: {
      ...makeWhitelist(['model', 'model_name', 'modelName', 'request_model']),
      model_smart_selection_meta: MODEL_WHITELIST
    }
  },
  t: null,
  r: {
    sessionId: null,
    tracking: {
      sessionId: null,
      model: null,
      chatFirstTokenPayload: { categories: MODEL_WHITELIST },
      serverTimingEvents: SERVER_TIMING_WHITELIST
    }
  }
};
const V1_FIRST_TOKEN_WHITELIST = makeWhitelist(['model', 'model_name', 'sessionId', 'session_id']);
const V1_CONTEXT_WHITELIST = {
  ...makeWhitelist([
    'sessionId', 'session_id', 'agentMessageId', 'assistantMessageId',
    'messageId', 'model', 'model_name'
  ]),
  chatFirstTokenPayload: V1_FIRST_TOKEN_WHITELIST,
  firstTokenPayload: V1_FIRST_TOKEN_WHITELIST
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function errorMessage(err) {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function durationMsBetween(start, end) {
  const startSeconds = Number(start);
  const endSeconds = Number(end);
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) return null;
  const milliseconds = Math.round((endSeconds - startSeconds) * 1000);
  return milliseconds >= 0 ? milliseconds : null;
}

/** 耗时有效性：仅接受有限正数（0ms 的预检/异常请求不是真实生成耗时）。 */
function positiveTimingMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

/** 从会话缓存取当前调用的服务端耗时；陈旧/缺失/非法返回 null。 */
function serverTimingForSession(sessionId, trackings) {
  if (!sessionId || !trackings) return null;
  const entry = trackings.get(sessionId);
  if (!entry || Date.now() - entry.at > SERVER_TIMING_FRESH_MS) return null;
  const events = entry.serverTimingEvents && typeof entry.serverTimingEvents === 'object' ? entry.serverTimingEvents : {};
  const durationMs = positiveTimingMs(events.server_processing_time);
  const firstResponseMs = positiveTimingMs(events.platform_first_token_timing);
  if (durationMs === null && firstResponseMs === null) return null;
  return { firstResponseMs, durationMs, timingSource: 'debugger-inferred' };
}

function isGenerationRequestUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    return TIMING_PATH_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function hashScriptUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

function shortLabel(target) {
  if (!target) return 'unknown-target';
  const title = typeof target.title === 'string' ? target.title.trim() : '';
  if (title) return title.length > 40 ? `${title.slice(0, 40)}…` : title;
  const id = typeof target.id === 'string' ? target.id : '';
  return `${target.type || 'target'}${id ? `#${id.slice(0, 8)}` : ''}`;
}

function isBinaryMimeType(mimeType) {
  if (typeof mimeType !== 'string' || !mimeType) return false;
  if (/^(image|audio|video|font)\//i.test(mimeType)) return true;
  return /octet-stream|application\/wasm|application\/zip/i.test(mimeType);
}

/** 计算文本中第 index 个字符的 0 基行号/列号。 */
function computeLineColumn(text, index) {
  let line = 0;
  let lastNewline = -1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lastNewline = i;
    }
  }
  return { line, column: index - lastNewline - 1 };
}

/** 找出 needle 在源码中的所有出现位置（最多 limit 个）。 */
function findOccurrences(source, needle, limit) {
  const locations = [];
  let from = 0;
  while (locations.length < limit) {
    const index = source.indexOf(needle, from);
    if (index < 0) break;
    locations.push(computeLineColumn(source, index));
    from = index + needle.length;
  }
  return locations;
}

/**
 * 从 ai-chat v2 断点局部作用域提取 token 用量（纯函数，便于测试）。
 * local 形如 { e: { sessionId, tokenUsage: {...} } }；metadata 事件只更新 model 缓存。
 */
function extractTraeV2UsageEvents(local, { models, recentUsage, trackings, inherited = {} } = {}) {
  const source = local && typeof local === 'object' ? (local.e && typeof local.e === 'object' ? local.e : local) : null;
  if (!source) return [];
  const root = local && typeof local === 'object' ? local : {};
  const context = root.r && typeof root.r === 'object' ? root.r : null;
  const tracking = context && context.tracking && typeof context.tracking === 'object' ? context.tracking : null;
  const sessionId = (root.t != null ? String(root.t) : null)
    || (source.sessionId != null ? String(source.sessionId) : null)
    || (source.session_id != null ? String(source.session_id) : null)
    || (context && context.sessionId != null ? String(context.sessionId) : null)
    || (tracking && tracking.sessionId != null ? String(tracking.sessionId) : null);
  // handle 帧只有 stream 上下文（无 tokenUsage）：把逐调用服务端耗时按 sessionId 缓存，
  // 供紧随其后的定义帧 usage 事件附带；同帧含两者时（新版 bundle）也走同一缓存。
  if (sessionId && tracking && trackings) {
    const serverTimingEvents = tracking.serverTimingEvents && typeof tracking.serverTimingEvents === 'object'
      ? tracking.serverTimingEvents : null;
    if (serverTimingEvents) {
      trackings.set(sessionId, { at: Date.now(), serverTimingEvents });
      if (trackings.size > SERVER_TIMING_MAX) {
        const cutoff = Date.now() - TIMING_TTL_MS;
        for (const [key, value] of trackings) {
          if (value.at < cutoff) trackings.delete(key);
        }
        if (trackings.size > SERVER_TIMING_MAX) trackings.delete(trackings.keys().next().value);
      }
    }
  }
  // stream context 中的 model 信息（v2 handle 断点可拿到）
  if (sessionId && models) {
    const ctxModel = (tracking && (tracking.model || (tracking.chatFirstTokenPayload && tracking.chatFirstTokenPayload.categories && tracking.chatFirstTokenPayload.categories.model))) || null;
    if (ctxModel && typeof ctxModel === 'string') models.set(sessionId, normalizeModelName(ctxModel));
  }

  // metadata：只记 model，用于后续 token 事件归因
  if (source.metadata && typeof source.metadata === 'object') {
    const md = source.metadata;
    const nested = md.model_smart_selection_meta && typeof md.model_smart_selection_meta === 'object' ? md.model_smart_selection_meta : {};
    const model = md.model || md.model_name || md.modelName || md.request_model || nested.model || nested.model_name || nested.modelName;
    if (sessionId && model && typeof model === 'string' && models) models.set(sessionId, normalizeModelName(model));
    if (!source.tokenUsage) return [];
  }

  const usage = source.tokenUsage && typeof source.tokenUsage === 'object' ? source.tokenUsage : source;
  if (!usage || typeof usage !== 'object') return [];
  const inheritedWithSource = { ...inherited, source: 'debugger' };
  const events = extractUsageEvents(usage, inheritedWithSource);
  if (!events.length) return [];

  const replyId = usage.reply_to_message_id || usage.replyToMessageId || source.reply_to_message_id || null;
  const packetSeq = usage.__packet_seq__ != null ? usage.__packet_seq__ : (usage.packet_seq != null ? usage.packet_seq : null);
  const messageId = replyId ? `${replyId}${packetSeq != null ? ':' + packetSeq : ''}` : null;
  const dedupeKey = `${sessionId || ''}|${messageId || events[0].totalTokens + ':' + events[0].promptTokens + ':' + events[0].completionTokens}`;

  const now = Date.now();
  // 同一 token 包可能被两个不同形状的断点各命中一次（messageId 可能一个带 packet_seq、一个不带），
  // 再叠加一个忽略 messageId 的 token 指纹键，避免重复计数。
  const tokenKey = `${sessionId || ''}|tok:${events[0].promptTokens}:${events[0].completionTokens}:${events[0].totalTokens}`;
  if (recentUsage) {
    const last = recentUsage.get(dedupeKey) || recentUsage.get(tokenKey);
    if (last && now - last < 15000) return [];
    recentUsage.set(dedupeKey, now);
    recentUsage.set(tokenKey, now);
    if (recentUsage.size > 1200) {
      for (const [key, at] of recentUsage) if (now - at > 60000) recentUsage.delete(key);
    }
  }

  const model = (sessionId && models && models.get(sessionId)) || source.model || usage.model || null;
  const serverTiming = serverTimingForSession(sessionId, trackings);
  return events.map((event) => ({
    ...event,
    source: 'debugger',
    model: normalizeModelName(model || event.model || 'unknown'),
    sessionId: sessionId || event.sessionId,
    messageId: messageId || event.messageId,
    ...(serverTiming || {})
  }));
}

function decodeResponseBody(response) {
  if (!response || typeof response !== 'object') return null;
  const { body } = response;
  if (typeof body !== 'string') return null;
  if (response.base64Encoded) {
    try {
      return Buffer.from(body, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  return body;
}

// ---------------------------------------------------------------------------
// TraeCollector
// ---------------------------------------------------------------------------

class TraeCollector extends EventEmitter {
  /**
   * @param {{
   *   host?: string,
   *   port?: number,
   *   debuggerEnabled?: boolean,
   *   networkEnabled?: boolean,
   *   pollIntervalMs?: number,
   *   logger?: (level: 'info'|'warn'|'error', message: string) => void
   * }} [options]
   */
  constructor(options = {}) {
    super();
    const opts = options && typeof options === 'object' ? options : {};

    this.host = typeof opts.host === 'string' && opts.host ? opts.host : '127.0.0.1';
    const port = Number(opts.port);
    this.port = Number.isFinite(port) && port > 0 && port <= 65535 ? Math.trunc(port) : 9222;
    this.debuggerEnabled = opts.debuggerEnabled !== false;
    this.networkEnabled = opts.networkEnabled !== false;
    this.timingEnabled = opts.timingEnabled !== false;
    this.pollIntervalMs = Number.isFinite(opts.pollIntervalMs) && opts.pollIntervalMs > 0
      ? Math.trunc(opts.pollIntervalMs)
      : 3000;
    this._logger = typeof opts.logger === 'function' ? opts.logger : () => {};
    this.webSocketImpl = typeof opts.webSocketImpl === 'function' ? opts.webSocketImpl : null;

    this._started = false;
    this._polling = false;
    /** @type {NodeJS.Timeout|null} */
    this._pollTimer = null;
    /** @type {Map<string, object>} targetId -> session */
    this._targets = new Map();
    /** @type {Map<string, number>} 跨通道去重缓存：key -> 最近 emit 时间 */
    this._dedupe = new Map();
    /** @type {Array<{at:number, event:object}>} 最近的非账单用量，用于 billing 事件归并 */
    this._recentUsage = [];

    this._status = {
      connected: false,
      targetCount: 0,
      collectorCount: 0,
      breakpointCount: 0,
      lastCaptureAt: null,
      lastError: null
    };

    this._discoverFailures = 0;
    this._retryAt = 0;
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /** 立即轮询一次，然后按 pollIntervalMs 定时轮询。 */
  start() {
    if (this._started) return;
    this._started = true;
    this._discoverFailures = 0;
    this._retryAt = 0;
    this._emitLog('info', `开始轮询 CDP ${this.host}:${this.port}（间隔 ${this.pollIntervalMs}ms）`);
    this._emitStatus();
    this._poll().catch((err) => this._handleUnexpected(err));
    this._pollTimer = setInterval(() => {
      this._poll().catch((err) => this._handleUnexpected(err));
    }, this.pollIntervalMs);
    if (this._pollTimer && typeof this._pollTimer.unref === 'function') this._pollTimer.unref();
  }

  /** 停止轮询并关闭所有目标连接。 */
  stop() {
    if (!this._started) return;
    this._started = false;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    for (const session of [...this._targets.values()]) {
      this._disposeSession(session, 'collector-stopped');
    }
    this._targets.clear();
    this._dedupe.clear();
    this._recentUsage = [];
    this._status.connected = false;
    this._status.lastError = null;
    this._refreshCounts();
    this._emitLog('info', '已停止 CDP 采集');
    this._emitStatus();
  }

  /** @returns {{connected:boolean,targetCount:number,collectorCount:number,breakpointCount:number,lastCaptureAt:number|null,lastError:string|null}} */
  getStatus() {
    return {
      connected: this._status.connected === true,
      targetCount: this._status.targetCount,
      collectorCount: this._status.collectorCount,
      breakpointCount: this._status.breakpointCount,
      lastCaptureAt: this._status.lastCaptureAt,
      lastError: this._status.lastError
    };
  }

  // -------------------------------------------------------------------------
  // 轮询 / 目标发现
  // -------------------------------------------------------------------------

  async _poll() {
    if (!this._started || this._polling) return;
    if (Date.now() < this._retryAt) return;
    this._polling = true;
    try {
      let discovered;
      try {
        discovered = await discoverTargets({
          host: this.host,
          port: this.port,
          timeoutMs: DISCOVERY_TIMEOUT_MS
        });
      } catch (err) {
        this._handleDiscoveryFailure(err);
        return;
      }

      this._discoverFailures = 0;
      this._retryAt = 0;
      this._status.connected = true;
      this._status.lastError = null;

      const targets = discovered && Array.isArray(discovered.targets) ? discovered.targets : [];
      this._emitDiagnostic({
        type: 'discovery',
        version: discovered && discovered.version && typeof discovered.version === 'object' ? discovered.version : null,
        targetCount: targets.length,
        targets: targets.map((target) => ({
          id: target.id,
          type: target.type,
          title: target.title,
          url: endpointOfUrl(target.url)
        }))
      });

      await this._reconcileTargets(targets);
      this._emitStatus();
    } catch (err) {
      this._status.lastError = `轮询异常：${errorMessage(err)}`;
      this._emitLog('error', this._status.lastError);
      this._emitDiagnostic({ type: 'poll-error', error: this._status.lastError });
      this._emitStatus();
    } finally {
      this._polling = false;
    }
  }

  _handleDiscoveryFailure(err) {
    this._discoverFailures += 1;
    const base = Math.max(this.pollIntervalMs, 1000);
    const factor = Math.min(2 ** Math.min(this._discoverFailures - 1, 4), 8);
    const backoffMs = Math.min(30000, base * factor);
    this._retryAt = Date.now() + backoffMs;
    this._status.connected = false;
    this._status.lastError = `CDP 发现失败：${errorMessage(err)}`;
    this._emitLog(
      this._discoverFailures <= 2 ? 'warn' : 'error',
      `${this._status.lastError}（第 ${this._discoverFailures} 次，${backoffMs}ms 后重试）`
    );
    this._emitDiagnostic({
      type: 'discovery-failed',
      attempt: this._discoverFailures,
      error: this._status.lastError,
      retryAfterMs: backoffMs
    });
    this._emitStatus();
  }

  // -------------------------------------------------------------------------
  // 目标会话
  // -------------------------------------------------------------------------

  _createSession(entry) {
    return {
      id: entry.id,
      target: {
        id: entry.id,
        type: entry.type,
        title: entry.title,
        url: entry.url,
        webSocketDebuggerUrl: entry.webSocketDebuggerUrl
      },
      conn: null,
      ready: false,
      connecting: false,
      closingForRetry: false,
      lastAttemptAt: 0,
      lastError: null,
      /** @type {Map<string, {scriptId:string,lineNumber:number}>} */
      breakpoints: new Map(),
      /** @type {Set<string>} */
      scannedScripts: new Set(),
      scanBusy: 0,
      /** @type {Map<string,string>} sessionId -> model（来自 fireMetadataReceived） */
      models: new Map(),
      /** @type {Map<string, number>} token 包去重键 -> 时间戳 */
      recentUsage: new Map(),
      /** @type {Array<{scriptId:string,url:string}>} 扫描并发满时排队（大 bundle 不被永久跳过） */
      pendingScripts: [],
      /** @type {Map<string, object>} requestId -> response meta */
      network: new Map(),
      /** 仅内存的网络耗时候选与 turn 绑定，不进入日志或数据库。 */
      timing: new Map(),
      timingLinks: new Map(),
      /** @type {Map<string, {at:number, serverTimingEvents:object}>} sessionId -> 服务端耗时缓存 */
      trackings: new Map(),
      /** @type {object[]} 接入完成前缓冲的 scriptParsed */
      bufferedScripts: [],
      pausedCount: 0,
      disposed: false
    };
  }

  async _reconcileTargets(targets) {
    const desired = new Map();
    for (const target of targets) {
      if (!target || typeof target !== 'object') continue;
      const type = typeof target.type === 'string' ? target.type : '';
      if (!TARGET_TYPES.has(type)) continue;
      if (typeof target.webSocketDebuggerUrl !== 'string' || !target.webSocketDebuggerUrl) continue;
      const id = target.id ? String(target.id) : target.webSocketDebuggerUrl;
      desired.set(id, {
        id,
        type,
        title: typeof target.title === 'string' ? target.title : '',
        url: typeof target.url === 'string' ? target.url : '',
        webSocketDebuggerUrl: target.webSocketDebuggerUrl
      });
    }

    // 清理消失的目标
    for (const [id, session] of [...this._targets.entries()]) {
      if (!desired.has(id)) {
        this._emitLog('info', `目标已消失「${shortLabel(session.target)}」`);
        this._disposeSession(session, 'target-gone');
        this._targets.delete(id);
        continue;
      }
      const entry = desired.get(id);
      session.target.title = entry.title;
      session.target.url = entry.url;
      session.target.type = entry.type;
    }

    const pendingAttach = [];
    for (const entry of desired.values()) {
      const existing = this._targets.get(entry.id);
      if (!existing) {
        const session = this._createSession(entry);
        this._targets.set(entry.id, session);
        pendingAttach.push(this._attachSession(session));
        continue;
      }
      if (!existing.ready && !existing.connecting && Date.now() - existing.lastAttemptAt >= TARGET_RETRY_MS) {
        pendingAttach.push(this._attachSession(existing));
      }
    }
    if (pendingAttach.length > 0) {
      await Promise.allSettled(pendingAttach);
    }
    this._refreshCounts();
  }

  async _attachSession(session) {
    if (!this._started || session.disposed || session.connecting || session.ready) return;
    session.connecting = true;
    session.lastAttemptAt = Date.now();
    const conn = new CdpConnection(session.target.webSocketDebuggerUrl, { WebSocketImpl: this.webSocketImpl });
    session.conn = conn;
    try {
      await conn.connect({ timeoutMs: CONNECT_TIMEOUT_MS });
      if (!this._started || session.disposed) {
        session.closingForRetry = true;
        conn.close();
        return;
      }

      this._wireConnection(session, conn);

      await this._sendTolerant(session, 'Runtime.enable');
      if (this.networkEnabled || this.timingEnabled) {
        await this._sendTolerant(session, 'Network.enable', {
          maxTotalBufferSize: 50000000,
          maxResourceBufferSize: 16000000
        });
      }
      if (this.debuggerEnabled) {
        await this._sendTolerant(session, 'Debugger.enable', { maxScriptsCacheSize: 50000000 });
      }
      // 连接可能在初始化期间被 Trae 关闭（_onConnectionClosed 在 connecting 阶段只做静默处理）
      if (session.disposed || !conn.connected) {
        throw new Error('目标连接在初始化期间关闭');
      }

      session.ready = true;
      this._emitLog('info', `已接入 CDP 目标「${shortLabel(session.target)}」`);
      this._emitDiagnostic({
        type: 'target-attached',
        targetId: session.id,
        targetType: session.target.type,
        title: session.target.title,
        debuggerEnabled: this.debuggerEnabled,
        networkEnabled: this.networkEnabled
      });

      const buffered = session.bufferedScripts.splice(0, session.bufferedScripts.length);
      for (const params of buffered) this._scheduleScriptScan(session, params);
    } catch (err) {
      session.lastError = errorMessage(err);
      session.conn = null;
      session.ready = false;
      session.closingForRetry = true;
      try {
        conn.close();
      } catch {
        /* ignore */
      }
      this._emitLog('warn', `接入目标失败「${shortLabel(session.target)}」：${session.lastError}`);
      this._emitDiagnostic({
        type: 'target-attach-failed',
        targetId: session.id,
        targetType: session.target.type,
        error: session.lastError
      });
    } finally {
      session.connecting = false;
      this._refreshCounts();
    }
  }

  _wireConnection(session, conn) {
    conn.on('close', () => this._onConnectionClosed(session));
    conn.on('error', (err) => {
      this._emitLog('warn', `CDP 连接错误「${shortLabel(session.target)}」：${errorMessage(err)}`);
    });

    if (this.debuggerEnabled) {
      conn.on('Debugger.scriptParsed', (params) => {
        if (!this._started || session.disposed) return;
        if (!session.ready) {
          if (session.bufferedScripts.length < MAX_BUFFERED_SCRIPTS) session.bufferedScripts.push(params);
          return;
        }
        this._scheduleScriptScan(session, params);
      });
      conn.on('Debugger.paused', (params) => {
        Promise.resolve()
          .then(() => this._onPaused(session, params))
          .catch((err) => this._handleHandlerError(session, 'Debugger.paused', err));
      });
      conn.on('Debugger.resumed', () => {
        session.paused = false;
      });
    }

    if (this.timingEnabled) {
      conn.on('Network.requestWillBeSent', (params) => this._onTimingRequest(session, params));
      conn.on('Network.responseReceived', (params) => this._onTimingResponse(session, params));
      conn.on('Network.loadingFinished', (params) => this._onTimingFinished(session, params, false));
      conn.on('Network.loadingFailed', (params) => this._onTimingFinished(session, params, true));
    }

    if (this.networkEnabled) {
      conn.on('Network.responseReceived', (params) => {
        try {
          this._onResponseReceived(session, params);
        } catch (err) {
          this._handleHandlerError(session, 'Network.responseReceived', err);
        }
      });
      conn.on('Network.loadingFinished', (params) => {
        Promise.resolve()
          .then(() => this._onLoadingFinished(session, params))
          .catch((err) => this._handleHandlerError(session, 'Network.loadingFinished', err));
      });
      conn.on('Network.loadingFailed', (params) => {
        try {
          if (params && params.requestId != null) session.network.delete(String(params.requestId));
        } catch {
          /* ignore */
        }
      });
      conn.on('Network.webSocketFrameReceived', (params) => {
        try {
          this._onWebSocketFrame(session, params);
        } catch (err) {
          this._handleHandlerError(session, 'Network.webSocketFrameReceived', err);
        }
      });
    }
  }

  _onConnectionClosed(session) {
    if (session.disposed) return;
    if (session.closingForRetry) {
      session.closingForRetry = false;
      session.conn = null;
      return;
    }
    if (session.connecting) {
      session.conn = null;
      return;
    }
    if (session.ready) this._emitLog('warn', `目标连接关闭「${shortLabel(session.target)}」`);
    this._emitDiagnostic({ type: 'target-disconnected', targetId: session.id, title: session.target.title });
    this._disposeSession(session, 'connection-closed');
    this._targets.delete(session.id);
    this._refreshCounts();
    this._emitStatus();
  }

  _disposeSession(session, reason) {
    if (!session || session.disposed) return;
    session.disposed = true;
    session.ready = false;
    session.breakpoints.clear();
    session.scannedScripts.clear();
    session.network.clear();
    session.timing.clear();
    session.timingLinks.clear();
    session.trackings.clear();
    session.bufferedScripts.length = 0;
    const conn = session.conn;
    session.conn = null;
    if (conn) {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
    }
    this._emitDiagnostic({ type: 'target-disposed', targetId: session.id, reason });
  }

  async _sendTolerant(session, method, params) {
    const conn = session.conn;
    if (!conn) return null;
    try {
      return await this._withTimeout(conn.send(method, params || {}), COMMAND_TIMEOUT_MS, method);
    } catch (err) {
      this._emitLog('warn', `${method} 失败「${shortLabel(session.target)}」：${errorMessage(err)}`);
      this._emitDiagnostic({ type: 'command-failed', targetId: session.id, method, error: errorMessage(err) });
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 调试器断点通道
  // -------------------------------------------------------------------------

  _scheduleScriptScan(session, params) {
    Promise.resolve()
      .then(() => this._onScriptParsed(session, params))
      .catch((err) => this._handleHandlerError(session, 'Debugger.scriptParsed', err));
  }

  async _onScriptParsed(session, params) {
    if (!this._started || !this.debuggerEnabled || session.disposed) return;
    const scriptId = params && params.scriptId != null ? String(params.scriptId) : '';
    const url = params && typeof params.url === 'string' ? params.url : '';
    if (!scriptId || !url) return;
    if (!SCRIPT_URL_RE.test(url)) return;
    if (session.scannedScripts.has(scriptId)) return;
    if (session.scannedScripts.size >= MAX_SCRIPTS_PER_TARGET) return;
    if (session.scanBusy >= MAX_SCAN_CONCURRENCY) {
      // 排队而不是丢弃：大聊天 bundle（含断点采集点）不能被并发上限永久跳过
      if (session.pendingScripts.length < 200) {
        const item = { scriptId, url };
        if (/ai-modules-chat\/dist\/index\.mjs/.test(url)) session.pendingScripts.unshift(item);
        else session.pendingScripts.push(item);
        this._emitDiagnostic({ type: 'script-scan-queued', targetId: session.id, url, reason: 'concurrency', queue: session.pendingScripts.length });
      }
      return;
    }

    session.scannedScripts.add(scriptId);
    session.scanBusy += 1;
    try {
      const conn = session.conn;
      if (!conn || session.disposed) return;
      const response = await this._withTimeout(
        conn.send('Debugger.getScriptSource', { scriptId }),
        SOURCE_FETCH_TIMEOUT_MS,
        'Debugger.getScriptSource'
      );
      if (session.disposed) return;
      const source = response && typeof response.scriptSource === 'string' ? response.scriptSource : '';
      if (!source) return;
      if (source.length > MAX_SCRIPT_SOURCE_LENGTH) {
        this._emitDiagnostic({ type: 'script-scan-skipped', targetId: session.id, url, reason: 'too-large', length: source.length });
        return;
      }

      let breakpoints = 0;
      let occurrencesTotal = 0;
      for (const { mark, max } of BREAKPOINT_MARKS) {
        const locations = findOccurrences(source, mark, Math.min(max * 3, MAX_BREAKPOINTS_PER_SCRIPT));
        occurrencesTotal += locations.length;
        let setForMark = 0;
        for (const location of locations) {
          if (session.disposed) break;
          if (setForMark >= max) break;
          const activeConn = session.conn;
          if (!activeConn) break;
          const breakpointId = await this._setBreakpointAt(activeConn, session, scriptId, url, location);
          if (breakpointId) {
            session.breakpoints.set(breakpointId, { scriptId, lineNumber: location.line, mark });
            breakpoints += 1;
            setForMark += 1;
            // extension 侧按 type==='breakpoint' 记录采集点日志
            this._emitDiagnostic({
              type: 'breakpoint',
              targetId: session.id,
              scriptId,
              url,
              mark,
              lineNumber: location.line,
              breakpointId
            });
          }
        }
      }
      if (occurrencesTotal === 0) {
        this._emitDiagnostic({ type: 'script-scanned', targetId: session.id, url, found: false, length: source.length });
        return;
      }
      this._emitDiagnostic({
        type: 'breakpoint-set',
        targetId: session.id,
        scriptId,
        url,
        occurrences: occurrencesTotal,
        breakpoints
      });
      this._refreshCounts();
      this._emitStatus();
    } catch (err) {
      this._handleHandlerError(session, 'Debugger.getScriptSource', err);
    } finally {
      session.scanBusy = Math.max(0, session.scanBusy - 1);
      if (!session.disposed && session.pendingScripts.length > 0 && session.scanBusy < MAX_SCAN_CONCURRENCY) {
        const next = session.pendingScripts.shift();
        if (next) this._scheduleScriptScan(session, next);
      }
    }
  }

  async _setBreakpointAt(conn, session, scriptId, url, location) {
    try {
      const result = await this._withTimeout(
        conn.send('Debugger.setBreakpoint', {
          location: { scriptId, lineNumber: location.line, columnNumber: location.column }
        }),
        COMMAND_TIMEOUT_MS,
        'Debugger.setBreakpoint'
      );
      if (result && result.breakpointId) return result.breakpointId;
    } catch (err) {
      this._emitDiagnostic({
        type: 'breakpoint-failed',
        targetId: session.id,
        url,
        lineNumber: location.line,
        error: errorMessage(err)
      });
    }
    // 兼容部分 Electron/CDP 版本：按要求 location 不生效时退回按 URL 下断点
    try {
      const fallback = await this._withTimeout(
        conn.send('Debugger.setBreakpointByUrl', {
          lineNumber: location.line,
          columnNumber: location.column,
          url
        }),
        COMMAND_TIMEOUT_MS,
        'Debugger.setBreakpointByUrl'
      );
      if (fallback && fallback.breakpointId) return fallback.breakpointId;
    } catch (err) {
      this._emitDiagnostic({
        type: 'breakpoint-failed',
        targetId: session.id,
        url,
        lineNumber: location.line,
        error: errorMessage(err)
      });
    }
    return null;
  }

  /**
   * ai-chat v2 断点快通道：读取局部作用域里的 `e`。
   * - fireTokenUsageReceived: e = { sessionId, tokenUsage: { prompt_tokens, completion_tokens, ... } }
   * - fireMetadataReceived:   e = { sessionId, metadata: { model/model_name/... } }
   * 返回 UsageEvent[]（同一条 token 包只返回一次）。
   */
  async _captureTraeV2Events(session, callFrame, inherited) {
    const scopeChain = callFrame && Array.isArray(callFrame.scopeChain) ? callFrame.scopeChain : [];
    const localScope = scopeChain.find((scope) => scope && scope.type === 'local');
    if (!localScope || !localScope.object || !localScope.object.objectId) return [];
    const local = await this._readProperties(
      session,
      localScope.object.objectId,
      1,
      { visited: 0 },
      { maxDepth: 5, budget: 700, maxChildren: 140 },
      V2_LOCAL_WHITELIST
    );
    return extractTraeV2UsageEvents(local, {
      models: session.models,
      recentUsage: session.recentUsage,
      trackings: session.trackings,
      inherited
    });
  }

  /**
   * 从 reportTokenUsage(usage, chatContext) 的两个参数中提取用量。
   * usage: completion_tokens / prompt_tokens / total_tokens / cache_read_input_tokens ...
   * chatContext: sessionId / agentMessageId / chatFirstTokenPayload.model ...
   */
  async _extractReportTokenUsageArgs(session, argRemotes, inherited) {
    const readArg = async (arg, limits, whitelist) => {
      if (!arg || !arg.objectId) return null;
      try {
        return await this._readProperties(session, arg.objectId, 1, { visited: 0 }, limits, whitelist);
      } catch {
        return null;
      }
    };
    const usage = await readArg(
      argRemotes[0],
      { maxDepth: 2, budget: 120, maxChildren: 40 },
      TOKEN_USAGE_WHITELIST
    );
    const context = await readArg(
      argRemotes[1],
      { maxDepth: 3, budget: 260, maxChildren: 80 },
      V1_CONTEXT_WHITELIST
    );
    if (!usage && !context) return [];
    const payload = (context && (context.chatFirstTokenPayload || context.firstTokenPayload)) || null;
    const merged = { ...(usage || {}) };
    if (payload) {
      if (merged.model == null) merged.model = payload.model || payload.model_name;
      if (merged.sessionId == null) merged.sessionId = payload.sessionId || payload.session_id;
    }
    if (context) {
      if (merged.sessionId == null) merged.sessionId = context.sessionId || context.session_id;
      if (merged.messageId == null) merged.messageId = context.agentMessageId || context.assistantMessageId || context.messageId;
      if (merged.model == null) merged.model = context.model || context.model_name;
    }
    return extractUsageEvents(merged, inherited);
  }

  async _onPaused(session, params) {
    if (!this._started || !this.debuggerEnabled) {
      if (session && session.conn && !session.disposed) await this._resume(session, 'inactive');
      return;
    }
    if (!session || session.disposed) return;
    if (!session.conn) return;

    session.paused = true;
    session.pausedCount += 1;
    let resumeRequested = false;
    const requestResume = (reason) => {
      if (resumeRequested) return;
      resumeRequested = true;
      this._resume(session, reason).catch(() => {});
    };

    const fallbackTimer = setTimeout(() => {
      if (resumeRequested) return;
      this._emitLog('warn', `断点暂停超过 ${PAUSED_FALLBACK_MS}ms，强制 Debugger.resume（${shortLabel(session.target)}）`);
      requestResume('fallback-timeout');
    }, PAUSED_FALLBACK_MS);
    if (fallbackTimer && typeof fallbackTimer.unref === 'function') fallbackTimer.unref();

    try {
      const callFrame = params && Array.isArray(params.callFrames) ? params.callFrames[0] : null;
      if (!callFrame) {
        this._emitDiagnostic({ type: 'paused', targetId: session.id, reason: params && params.reason, eventCount: 0 });
        return;
      }

      const inherited = {
        source: 'debugger',
        observedAt: Date.now(),
        endpoint: null,
        targetId: session.id,
        targetTitle: session.target.title
      };

      // 仅按已知协议读取白名单字段，不展开未知 local scope / arguments。
      let events = await this._captureTraeV2Events(session, callFrame, inherited);
      if (events.length === 0 && callFrame.functionName === 'reportTokenUsage' && Array.isArray(callFrame.arguments) && callFrame.arguments.length >= 2) {
        events = await this._extractReportTokenUsageArgs(session, callFrame.arguments, inherited);
      }

      this._emitDiagnostic({
        type: 'paused',
        targetId: session.id,
        reason: params && params.reason ? params.reason : null,
        functionName: callFrame.functionName || null,
        scriptUrlHash: hashScriptUrl(callFrame.url),
        eventCount: events.length
      });

      for (const event of events) {
        this._emitUsage({
          ...event,
          source: 'debugger',
          endpoint: null,
          targetId: session.id,
          targetTitle: session.target.title
        });
      }
    } catch (err) {
      const message = errorMessage(err);
      this._emitLog('warn', `读取断点作用域失败：${message}`);
      this._emitDiagnostic({ type: 'paused-error', targetId: session.id, error: message });
    } finally {
      clearTimeout(fallbackTimer);
      requestResume('normal');
    }
  }

  async _resume(session, reason) {
    if (!session || session.disposed) return;
    const conn = session.conn;
    if (!conn) return;
    try {
      await this._withTimeout(conn.send('Debugger.resume'), RESUME_TIMEOUT_MS, 'Debugger.resume');
      this._emitDiagnostic({ type: 'resumed', targetId: session.id, reason });
    } catch (err) {
      const message = errorMessage(err);
      // “未处于暂停状态”属于无害竞态，不刷日志
      if (!/not paused|was not paused|can only perform operation while paused/i.test(message)) {
        this._emitLog('warn', `Debugger.resume 失败（${reason}）：${message}`);
        this._emitDiagnostic({ type: 'resume-failed', targetId: session.id, reason, error: message });
      }
    } finally {
      session.paused = false;
    }
  }

  /**
   * 按协议白名单读取 CDP RemoteObject；白名单外的属性描述和值均不保留、不展开。
   * @returns {Promise<object|undefined>}
   */
  async _readProperties(session, objectId, depth, state, limits = {}, whitelist) {
    if (!whitelist || !objectId || session.disposed || !session.conn || !this.debuggerEnabled) return undefined;
    const maxDepth = limits.maxDepth ?? MAX_PROP_DEPTH;
    const budget = limits.budget ?? PROPERTY_BUDGET;
    const maxChildren = limits.maxChildren ?? 80;
    if (depth > maxDepth || state.visited >= budget) return undefined;
    state.visited += 1;

    const response = await this._withTimeout(
      session.conn.send('Runtime.getProperties', { objectId, ownProperties: true }),
      PROP_TIMEOUT_MS,
      'Runtime.getProperties'
    );
    if (session.disposed) return undefined;

    const properties = response && Array.isArray(response.result) ? response.result : [];
    const object = {};
    let children = 0;
    for (const property of properties) {
      if (state.visited >= budget) break;
      if (!property || typeof property.name !== 'string') continue;
      if (!Object.prototype.hasOwnProperty.call(whitelist, property.name)) continue;
      if (property.enumerable === false) continue;
      const value = property.value;
      if (!value || typeof value !== 'object') {
        object[property.name] = value ? value.value ?? null : null;
        continue;
      }
      if (value.type === 'object' && value.objectId) {
        const childWhitelist = whitelist[property.name];
        // 标量字段出现意外对象、数组或白名单外结构时均不展开。
        if (!childWhitelist || value.className === 'Array') continue;
        children += 1;
        if (children > maxChildren) continue;
        const child = await this._readProperties(session, value.objectId, depth + 1, state, limits, childWhitelist);
        if (child !== undefined) object[property.name] = child;
        continue;
      }
      if (value.type === 'function' || value.type === 'symbol') continue;
      object[property.name] = value.value !== undefined ? value.value : null;
    }
    return object;
  }

  // -------------------------------------------------------------------------
  // 网络响应通道
  // -------------------------------------------------------------------------

  _onResponseReceived(session, params) {
    if (!this.networkEnabled || session.disposed) return;
    const requestId = params && params.requestId != null ? String(params.requestId) : '';
    const response = params && params.response;
    if (!requestId || !response || typeof response.url !== 'string') return;
    if (session.network.size >= MAX_PENDING_RESPONSES) {
      const oldest = session.network.keys().next().value;
      if (oldest !== undefined) session.network.delete(oldest);
    }
    session.network.set(requestId, {
      url: response.url,
      status: typeof response.status === 'number' ? response.status : 0,
      mimeType: typeof response.mimeType === 'string' ? response.mimeType : '',
      type: typeof params.type === 'string' ? params.type : '',
      receivedAt: Date.now()
    });
  }

  async _onLoadingFinished(session, params) {
    if (!this.networkEnabled || session.disposed) return;
    const requestId = params && params.requestId != null ? String(params.requestId) : '';
    if (!requestId) return;
    const entry = session.network.get(requestId);
    session.network.delete(requestId);
    if (!entry) return;
    if (!NETWORK_URL_RE.test(entry.url)) return;
    if (!(entry.status > 0 && entry.status < 400)) return;
    if (isBinaryMimeType(entry.mimeType)) return;

    const encodedLength = params && typeof params.encodedDataLength === 'number' ? params.encodedDataLength : null;
    if (encodedLength != null && encodedLength > MAX_BODY_LENGTH) {
      this._emitDiagnostic({
        type: 'network-skipped',
        targetId: session.id,
        url: endpointOfUrl(entry.url),
        reason: 'too-large',
        size: encodedLength
      });
      return;
    }
    const conn = session.conn;
    if (!conn || session.disposed) return;

    let body = null;
    try {
      const response = await this._withTimeout(
        conn.send('Network.getResponseBody', { requestId }),
        BODY_FETCH_TIMEOUT_MS,
        'Network.getResponseBody'
      );
      body = decodeResponseBody(response);
    } catch (err) {
      this._emitDiagnostic({
        type: 'network-body-failed',
        targetId: session.id,
        url: endpointOfUrl(entry.url),
        error: errorMessage(err)
      });
      return;
    }
    if (typeof body !== 'string' || !body) return;
    if (body.length > MAX_BODY_LENGTH) {
      this._emitDiagnostic({
        type: 'network-skipped',
        targetId: session.id,
        url: endpointOfUrl(entry.url),
        reason: 'too-large',
        size: body.length
      });
      return;
    }
    this._captureText(session, body, entry.url, { channel: 'http' });
  }

  _onWebSocketFrame(session, params) {
    if (!this.networkEnabled || session.disposed) return;
    const frame = params && params.response;
    if (!frame || typeof frame.payloadData !== 'string') return;
    if (frame.opcode != null && frame.opcode !== 1) return; // 仅文本帧
    const text = frame.payloadData;
    if (!text || text.length > MAX_WS_FRAME_LENGTH) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const first = trimmed[0];
    if (first !== '{' && first !== '[' && !/^data\s*:/i.test(trimmed) && !/^event\s*:/i.test(trimmed)) return;

    const tokenEvents = parseResponseBody(text, { url: null });
    if (tokenEvents.length === 0) return;
    for (const event of tokenEvents) {
      this._emitUsage({
        ...event,
        source: 'network',
        endpoint: null,
        targetId: session.id,
        targetTitle: session.target.title
      });
    }
    this._emitDiagnostic({ type: 'websocket-capture', targetId: session.id, count: tokenEvents.length });
  }

  /** 把一段响应体/帧文本交给 parser，并 emit 事件。 */
  _captureText(session, text, url, meta = {}) {
    const observedAt = Date.now();
    const endpoint = endpointOfUrl(url);
    const baseContext = {
      observedAt,
      endpoint,
      targetId: session.id,
      targetTitle: session.target.title
    };

    let tokenCount = 0;
    let billingCount = 0;
    const billingEndpoint = BILLING_URL_RE.test(url);

    for (const event of parseResponseBody(text, { url })) {
      tokenCount += 1;
      this._emitUsage({
        ...event,
        // 账单响应中的 credits 由 billing 通道标注，避免同一笔实际积分重复归因
        credits: billingEndpoint ? null : event.credits,
        source: 'network',
        endpoint: event.endpoint != null ? event.endpoint : endpoint,
        targetId: session.id,
        targetTitle: session.target.title
      });
    }

    if (billingEndpoint) {
      for (const value of parseJsonValues(text)) {
        for (const event of extractBillingEvents(value, baseContext)) {
          billingCount += 1;
          const enriched = this._enrichBillingEvent(event);
          this._emitUsage({
            ...enriched,
            source: 'billing',
            endpoint: enriched.endpoint != null ? enriched.endpoint : endpoint,
            targetId: session.id,
            targetTitle: session.target.title
          });
        }
      }
    }

    this._emitDiagnostic({
      type: 'network-capture',
      channel: meta.channel || 'http',
      targetId: session.id,
      url: endpoint,
      tokenEvents: tokenCount,
      billingEvents: billingCount,
      totalEvents: tokenCount + billingCount
    });
    return tokenCount + billingCount;
  }

  // -------------------------------------------------------------------------
  // 事件 emit / 状态
  // -------------------------------------------------------------------------

  _onTimingRequest(session, params) {
    if (!this.timingEnabled || session.disposed) return;
    const requestId = params?.requestId != null ? String(params.requestId) : '';
    const url = params?.request?.url;
    if (!requestId || !isGenerationRequestUrl(url)) return;
    // 生成请求是 POST；OPTIONS 预检/GET 轮询瞬时完成，混入会产生 0ms 假耗时。
    const method = params?.request?.method;
    if (typeof method === 'string' && method.toUpperCase() !== 'POST') return;
    if (!Number.isFinite(Number(params.timestamp)) || session.timing.has(requestId)) return;
    this._pruneTiming(session);
    if (session.timing.size >= TIMING_MAX_PENDING) {
      const oldest = session.timing.keys().next().value;
      if (oldest !== undefined) session.timing.delete(oldest);
    }
    session.timing.set(requestId, {
      requestId,
      startTimestamp: Number(params.timestamp),
      firstResponseMs: null,
      durationMs: null,
      seenAt: Date.now(),
      assigned: false,
      ambiguous: false,
      event: null
    });
  }

  _onTimingResponse(session, params) {
    const entry = session.timing.get(String(params?.requestId));
    if (!entry) return;
    entry.firstResponseMs = durationMsBetween(entry.startTimestamp, params.timestamp);
    entry.seenAt = Date.now();
  }

  _onTimingFinished(session, params, failed) {
    const requestId = String(params?.requestId);
    const entry = session.timing.get(requestId);
    if (!entry) return;
    if (failed) {
      session.timing.delete(requestId);
      for (const [turn, linkedId] of session.timingLinks) {
        if (linkedId === requestId) session.timingLinks.delete(turn);
      }
      return;
    }
    entry.durationMs = durationMsBetween(entry.startTimestamp, params.timestamp);
    entry.seenAt = Date.now();
    if (entry.assigned && entry.event && entry.durationMs > 0) {
      const event = this._enrichTiming(entry.event, entry);
      entry.event = null;
      this._emitUsage(event);
    }
  }

  _pruneTiming(session) {
    const cutoff = Date.now() - TIMING_TTL_MS;
    for (const [requestId, entry] of session.timing) {
      if (entry.seenAt >= cutoff) continue;
      session.timing.delete(requestId);
      for (const [turn, linkedId] of session.timingLinks) {
        if (linkedId === requestId) session.timingLinks.delete(turn);
      }
    }
  }

  _enrichTiming(event, entry) {
    // 0ms/负值视为无效（预检、异常瞬时请求），回退到事件已有耗时（如服务端计时）。
    const firstResponseMs = positiveTimingMs(entry.firstResponseMs) ?? positiveTimingMs(event.firstResponseMs) ?? null;
    const durationMs = positiveTimingMs(entry.durationMs) ?? positiveTimingMs(event.durationMs) ?? null;
    if (firstResponseMs === null && durationMs === null) return event;
    const fromNetwork = positiveTimingMs(entry.firstResponseMs) !== null || positiveTimingMs(entry.durationMs) !== null;
    return {
      ...event,
      firstResponseMs,
      durationMs,
      timingSource: fromNetwork ? 'network-inferred' : (event.timingSource || 'network-inferred')
    };
  }

  _attachTiming(session, event) {
    if (!this.timingEnabled || !session || !event || event.source === 'billing') return event;
    this._pruneTiming(session);
    if (!event.sessionId || !event.messageId) {
      for (const entry of session.timing.values()) {
        if (!entry.assigned) entry.ambiguous = true;
      }
      return event;
    }

    const turn = `${event.sessionId}|${event.messageId}`;
    const linkedId = session.timingLinks.get(turn);
    if (linkedId) {
      const linked = session.timing.get(linkedId);
      // 未完成/无效（0ms）请求不附带半截耗时，等待 finish 补充完整一对值。
      return linked && linked.durationMs > 0 ? this._enrichTiming(event, linked) : event;
    }

    const candidates = [...session.timing.values()].filter((entry) => !entry.assigned && !entry.ambiguous);
    if (candidates.length !== 1) {
      if (candidates.length > 1) {
        for (const entry of candidates) entry.ambiguous = true;
      }
      return event;
    }
    const entry = candidates[0];
    entry.assigned = true;
    entry.event = { ...event };
    session.timingLinks.set(turn, entry.requestId);
    return entry.durationMs > 0 ? this._enrichTiming(event, entry) : event;
  }

  _emitUsage(event) {
    if (!event || !Number.isFinite(event.inputTokens) || !Number.isFinite(event.outputTokens)) return;
    event = this._attachTiming(this._targets.get(event.targetId), event);
    const key = [
      event.source,
      event.targetId,
      event.model,
      event.inputTokens,
      event.outputTokens,
      event.totalTokens,
      event.cacheReadTokens,
      event.cacheWriteTokens,
      event.credits == null ? '' : event.credits,
      event.sessionId == null ? '' : event.sessionId,
      event.messageId == null ? '' : event.messageId,
      event.billingId == null ? '' : event.billingId,
      event.firstResponseMs == null ? '' : event.firstResponseMs,
      event.durationMs == null ? '' : event.durationMs,
      event.timingSource == null ? '' : event.timingSource
    ].join('|');
    const now = Date.now();
    const last = this._dedupe.get(key);
    if (last != null && now - last < DEDUPE_TTL_MS) return;
    this._dedupe.set(key, now);
    if (this._dedupe.size > DEDUPE_MAX) this._pruneDedupe(now);
    this._status.lastCaptureAt = now;
    this._rememberUsage(event);
    this._safeEmit('usage', event);
  }

  /**
   * 账单响应通常只有 credits_float + session_id，缺少 model/token 三件套；
   * 与最近一次同 session 的用量归并后，store 的 billing 回填规则与 extension 的非零 token 过滤才能命中。
   */
  _enrichBillingEvent(event) {
    const candidate = this._findRecentUsageForBilling(event);
    if (!candidate) return event;
    const enriched = { ...event };
    const hasTokens = enriched.inputTokens > 0 || enriched.outputTokens > 0 || enriched.totalTokens > 0;
    if (!hasTokens) {
      enriched.inputTokens = candidate.inputTokens;
      enriched.outputTokens = candidate.outputTokens;
      enriched.totalTokens = candidate.totalTokens;
      enriched.cacheReadTokens = candidate.cacheReadTokens;
      enriched.cacheWriteTokens = candidate.cacheWriteTokens;
    }
    if (enriched.model === 'unknown' && candidate.model !== 'unknown') enriched.model = candidate.model;
    if (enriched.messageId == null) enriched.messageId = candidate.messageId;
    if (enriched.sessionId == null) enriched.sessionId = candidate.sessionId;
    this._emitDiagnostic({
      type: 'billing-enriched',
      targetId: enriched.targetId,
      sessionId: enriched.sessionId,
      model: enriched.model,
      inputTokens: enriched.inputTokens,
      outputTokens: enriched.outputTokens,
      totalTokens: enriched.totalTokens,
      credits: enriched.credits
    });
    return enriched;
  }

  _findRecentUsageForBilling(event) {
    const cutoff = Date.now() - RECENT_USAGE_TTL_MS;
    while (this._recentUsage.length > 0 && this._recentUsage[0].at < cutoff) this._recentUsage.shift();
    const sessionId = event.sessionId != null ? event.sessionId : event.billingId;
    if (sessionId == null) return null;
    for (let index = this._recentUsage.length - 1; index >= 0; index -= 1) {
      if (this._recentUsage[index].event.sessionId === sessionId) return this._recentUsage[index].event;
    }
    return null;
  }

  _rememberUsage(event) {
    if (!event || event.source === 'billing') return;
    if (!(event.inputTokens > 0 || event.outputTokens > 0 || event.totalTokens > 0)) return;
    const now = Date.now();
    this._recentUsage.push({ at: now, event });
    const cutoff = now - RECENT_USAGE_TTL_MS;
    while (this._recentUsage.length > 0 && this._recentUsage[0].at < cutoff) this._recentUsage.shift();
    while (this._recentUsage.length > RECENT_USAGE_MAX) this._recentUsage.shift();
  }

  _pruneDedupe(now) {
    for (const [key, timestamp] of [...this._dedupe]) {
      if (now - timestamp > DEDUPE_TTL_MS) this._dedupe.delete(key);
    }
    while (this._dedupe.size > DEDUPE_MAX) {
      const first = this._dedupe.keys().next().value;
      if (first === undefined) break;
      this._dedupe.delete(first);
    }
  }

  _emitStatus() {
    this._refreshCounts();
    this._safeEmit('status', this.getStatus());
  }

  _refreshCounts() {
    let collectorCount = 0;
    let breakpointCount = 0;
    for (const session of this._targets.values()) {
      if (session.ready) collectorCount += 1;
      breakpointCount += session.breakpoints.size;
    }
    this._status.targetCount = this._targets.size;
    this._status.collectorCount = collectorCount;
    this._status.breakpointCount = breakpointCount;
  }

  _emitLog(level, message) {
    const payload = { level, message };
    this._safeEmit('log', payload);
    try {
      this._logger(level, message);
    } catch {
      /* 日志回调异常隔离 */
    }
  }

  _emitDiagnostic(payload) {
    this._safeEmit('diagnostic', payload && typeof payload === 'object' ? payload : { type: 'diagnostic', payload });
  }

  _safeEmit(event, payload) {
    try {
      this.emit(event, payload);
    } catch (err) {
      try {
        this._logger('error', `事件监听器异常（${event}）：${errorMessage(err)}`);
      } catch {
        /* ignore */
      }
    }
  }

  _handleHandlerError(session, handler, err) {
    const message = errorMessage(err);
    this._emitLog('warn', `${handler} 处理失败（${shortLabel(session && session.target)}）：${message}`);
    this._emitDiagnostic({
      type: 'handler-error',
      handler,
      targetId: session ? session.id : null,
      error: message
    });
  }

  _handleUnexpected(err) {
    const message = errorMessage(err);
    this._status.lastError = `未预期异常：${message}`;
    this._emitLog('error', this._status.lastError);
    this._emitDiagnostic({ type: 'unexpected-error', error: message });
    this._emitStatus();
  }

  _withTimeout(promise, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`CDP 命令超时（${label}，${timeoutMs}ms）`));
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      Promise.resolve(promise).then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }
}

module.exports = { TraeCollector, extractTraeV2UsageEvents };
