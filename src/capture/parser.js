'use strict';

/**
 * 用量 payload 解析（JSON / SSE / 嵌套对象）。
 *
 * 契约见 docs/INTERFACES.md 第 3 节：
 *   parseResponseBody(text, { url }) -> UsageEvent[]
 *   extractUsageEvents(value, inherited) -> UsageEvent[]
 *   looksLikeUsage(value) -> boolean
 *   normalizeModelName(value) -> string
 *
 * 额外附加导出（向后兼容的辅助函数，供 collector 解析账单响应复用）：
 *   parseJsonValues(text) -> any[]
 *   extractBillingEvents(value, inherited) -> UsageEvent[]   // source='billing'
 *
 * 设计原则：未知/改版 payload 只应“少产出或零产出”，绝不能抛异常。
 */

// ---------------------------------------------------------------------------
// 字段别名集合（来自契约，额外兼容少量大小写/下划线变体，便于改版时优雅降级）
// ---------------------------------------------------------------------------

const INPUT_KEYS = ['input_tokens', 'prompt_tokens', 'input_token', 'inputTokens', 'promptTokens'];
const OUTPUT_KEYS = ['output_tokens', 'completion_tokens', 'output_token', 'outputTokens', 'completionTokens'];
const TOTAL_KEYS = ['total_tokens', 'totalTokens'];
const CACHE_READ_KEYS = [
  'cache_read_input_tokens',
  'cacheReadInputTokens',
  'cache_read_token',
  'cached_tokens',
  'cachedTokens',
  'cache_read_tokens'
];
const CACHE_WRITE_KEYS = [
  'cache_creation_input_tokens',
  'cacheCreationInputTokens',
  'cache_creation_token',
  'cache_creation_tokens',
  'cache_write_tokens',
  'cacheWriteInputTokens'
];
const REASONING_KEYS = ['reasoning_tokens', 'reasoningTokens'];
const CREDIT_KEYS = ['credits', 'credits_float', 'creditsFloat', 'credit'];
const MODEL_KEYS = ['model', 'model_name', 'modelName'];
const SESSION_KEYS = ['session_id', 'sessionId', 'sessionID'];
const MESSAGE_KEYS = ['agentMessageId', 'agent_message_id', 'reply_to_message_id', 'message_id', 'messageId', 'userMessageId', 'user_message_id', 'assistantMessageId'];
const USAGE_CONTAINER_KEYS = [
  'usage',
  'token_usage',
  'tokenUsage',
  'usageMetadata',
  'usage_metadata',
  'token_metrics',
  'tokenMetrics',
  'usage_data',
  'usageData'
];
const BILLING_CONTAINER_RE = /^fee_usage$|^feeUsage$|^fee$|^billing$|^billing_info$|^billingInfo$/i;
const DETAILS_KEY_RE = /detail/i;

const DIRECT_USAGE_KEYS = [
  ...INPUT_KEYS,
  ...OUTPUT_KEYS,
  ...TOTAL_KEYS,
  ...CACHE_READ_KEYS,
  ...CACHE_WRITE_KEYS
];

// ---------------------------------------------------------------------------
// 扫描护栏：payload 异常大/深时仍保持有界，避免拖垮扩展宿主
// ---------------------------------------------------------------------------

const MAX_DEPTH = 12;
const MAX_NODES = 20000;
const MAX_EVENTS = 500;
const MAX_JSON_STRING_LENGTH = 2 * 1024 * 1024;
const MAX_EMBEDDED_VALUES = 50;
const MAX_VALUE_TEXT_LENGTH = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 基础类型工具
// ---------------------------------------------------------------------------

function isFiniteNumberLike(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string' && value.trim() !== '') {
    return Number.isFinite(Number(value));
  }
  return false;
}

function asNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toTokenCount(value) {
  const n = asNumber(value);
  if (n == null) return 0;
  return Math.max(0, Math.round(n));
}

function toOptionalTokenCount(value) {
  const n = asNumber(value);
  if (n == null || n < 0) return null;
  return Math.round(n);
}

function pickNumber(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const n = asNumber(obj[key]);
    if (n != null) return n;
  }
  return null;
}

function pickString(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** 尝试 JSON.parse；失败返回 undefined（不用 null，null 是合法 JSON 值）。 */
function tryParseJson(text) {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 模型名归一化
// ---------------------------------------------------------------------------

const FORMAL_SUFFIX_RE = /(?:[\s\-–—_:：,，·/|]+)?(?:[（(【\[]\s*)?正式版(?:\s*[)）】\]])?\s*$/u;

/**
 * 模型名归一化：去首尾空白、内部空白折叠、去“正式版”后缀；空值 -> 'unknown'。
 * @param {unknown} value
 * @returns {string}
 */
function normalizeModelName(value) {
  if (typeof value !== 'string') return 'unknown';
  let name = value.replace(/\s+/g, ' ').trim();
  if (!name) return 'unknown';
  let previous;
  do {
    previous = name;
    name = name.replace(FORMAL_SUFFIX_RE, '').trim();
  } while (name && name !== previous);
  return name || 'unknown';
}

// ---------------------------------------------------------------------------
// UsageEvent 构造
// ---------------------------------------------------------------------------

function normalizeInherited(inherited) {
  const source = inherited && typeof inherited === 'object' ? inherited : {};
  return {
    source: typeof source.source === 'string' && source.source ? source.source : 'network',
    observedAt: Number.isFinite(source.observedAt) ? source.observedAt : Date.now(),
    endpoint: typeof source.endpoint === 'string' && source.endpoint ? source.endpoint : null,
    targetId: source.targetId != null ? String(source.targetId) : null,
    targetTitle: typeof source.targetTitle === 'string' ? source.targetTitle : null,
    model: typeof source.model === 'string' && source.model.trim() ? source.model : undefined,
    sessionId: typeof source.sessionId === 'string' && source.sessionId ? source.sessionId : null,
    messageId: typeof source.messageId === 'string' && source.messageId ? source.messageId : null,
    credits: isFiniteNumberLike(source.credits) ? asNumber(source.credits) : null
  };
}

/** 在当前节点读取模型/会话/账单上下文，供自身与子节点继承。 */
function deriveContext(node, context) {
  const next = {
    source: context.source,
    observedAt: context.observedAt,
    endpoint: context.endpoint,
    targetId: context.targetId,
    targetTitle: context.targetTitle,
    model: context.model,
    sessionId: context.sessionId,
    messageId: context.messageId,
    credits: context.credits
  };
  const model = pickString(node, MODEL_KEYS);
  if (model) next.model = model;
  const sessionId = pickString(node, SESSION_KEYS);
  if (sessionId) next.sessionId = sessionId;
  const messageId = pickString(node, MESSAGE_KEYS);
  if (messageId) next.messageId = messageId;
  const credits = pickCredits(node);
  if (credits != null) next.credits = credits;
  return next;
}

/** 读取 credits：优先顶层别名，其次 `fee_usage.credits` 等嵌套容器。 */
function pickCredits(node) {
  if (!node || typeof node !== 'object') return null;
  const direct = pickNumber(node, CREDIT_KEYS);
  if (direct != null) return direct;
  for (const [key, value] of Object.entries(node)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (!BILLING_CONTAINER_RE.test(key)) continue;
    const nested = pickNumber(value, CREDIT_KEYS);
    if (nested != null) return nested;
  }
  return null;
}

/** 读取 token 字段（含嵌套 details 里的缓存 token），不做“至少一个 >0”过滤。 */
function readTokenFields(node) {
  const fields = {
    input: pickNumber(node, INPUT_KEYS),
    output: pickNumber(node, OUTPUT_KEYS),
    total: pickNumber(node, TOTAL_KEYS),
    cacheRead: pickNumber(node, CACHE_READ_KEYS),
    cacheWrite: pickNumber(node, CACHE_WRITE_KEYS),
    reasoning: pickNumber(node, REASONING_KEYS)
  };
  for (const [key, value] of Object.entries(node)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    // 常见嵌套：prompt_tokens_details: { cached_tokens } / input_tokens_details
    if (DETAILS_KEY_RE.test(key) || /cache/i.test(key)) {
      if (fields.cacheRead == null) fields.cacheRead = pickNumber(value, CACHE_READ_KEYS);
      if (fields.cacheWrite == null) fields.cacheWrite = pickNumber(value, CACHE_WRITE_KEYS);
      if (fields.reasoning == null) fields.reasoning = pickNumber(value, REASONING_KEYS);
    }
  }
  return fields;
}

// 完整性必须看归一化前的原始字段，不能用缺省 0 或负数截断结果代替。
function hasCompleteTokenFields(fields) {
  return [fields.input, fields.output, fields.cacheRead, fields.cacheWrite]
    .every((value) => value != null && Number.isFinite(value) && value >= 0);
}

function hasUsageContainerChild(node) {
  if (!node || typeof node !== 'object') return false;
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (!value || typeof value !== 'object') continue;
    if (USAGE_CONTAINER_KEYS.includes(key) || /usage/i.test(key)) return true;
  }
  return false;
}

/**
 * 当前节点自身是否直接携带一份完整用量。
 * 规则：input/output 至少一个 > 0；只有 total 时降级为 output（但若存在 usage 子容器则交给子节点）。
 */
function readDirectUsage(node, context) {
  const fields = readTokenFields(node);
  const hasTokenField = fields.input != null || fields.output != null || fields.total != null;
  if (!hasTokenField) return null;

  let input = fields.input != null ? toTokenCount(fields.input) : 0;
  let output = fields.output != null ? toTokenCount(fields.output) : 0;

  if (input <= 0 && output <= 0) {
    if (fields.total != null && toTokenCount(fields.total) > 0 && !hasUsageContainerChild(node)) {
      output = toTokenCount(fields.total);
    } else {
      return null;
    }
  }

  const totalFromPayload = fields.total != null ? toTokenCount(fields.total) : null;
  const total = totalFromPayload != null && totalFromPayload >= input + output
    ? totalFromPayload
    : input + output;

  return buildUsageEvent({
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cacheReadTokens: toTokenCount(fields.cacheRead),
    cacheWriteTokens: toTokenCount(fields.cacheWrite),
    reasoningTokens: fields.reasoning,
    usageComplete: hasCompleteTokenFields(fields),
    credits: context.credits,
    model: context.model,
    sessionId: context.sessionId,
    messageId: context.messageId,
    billingId: null,
    source: context.source,
    observedAt: context.observedAt,
    endpoint: context.endpoint,
    targetId: context.targetId,
    targetTitle: context.targetTitle
  });
}

function buildUsageEvent(raw) {
  return {
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    totalTokens: raw.totalTokens,
    cacheReadTokens: raw.cacheReadTokens,
    cacheWriteTokens: raw.cacheWriteTokens,
    reasoningTokens: toOptionalTokenCount(raw.reasoningTokens),
    usageComplete: raw.usageComplete === true,
    model: normalizeModelName(raw.model),
    credits: raw.credits != null && Number.isFinite(raw.credits) ? raw.credits : null,
    sessionId: raw.sessionId != null ? raw.sessionId : null,
    messageId: raw.messageId != null ? raw.messageId : null,
    billingId: raw.billingId != null ? raw.billingId : null,
    source: raw.source,
    observedAt: raw.observedAt,
    endpoint: raw.endpoint != null ? raw.endpoint : null,
    targetId: raw.targetId != null ? raw.targetId : null,
    targetTitle: raw.targetTitle != null ? raw.targetTitle : null
  };
}

function usageEventKey(event) {
  return [
    event.source,
    event.model,
    event.inputTokens,
    event.outputTokens,
    event.totalTokens,
    event.cacheReadTokens,
    event.cacheWriteTokens,
    event.credits == null ? '' : event.credits,
    event.sessionId == null ? '' : event.sessionId,
    event.messageId == null ? '' : event.messageId,
    event.billingId == null ? '' : event.billingId
  ].join('|');
}

// ---------------------------------------------------------------------------
// 深扫
// ---------------------------------------------------------------------------

function walk(node, context, out, state, depth) {
  if (node == null) return;
  if (state.events >= MAX_EVENTS || state.visited >= MAX_NODES) return;
  if (depth > MAX_DEPTH) return;

  if (typeof node === 'string') {
    const trimmed = node.trim();
    if (
      trimmed.length > 1
      && trimmed.length <= MAX_JSON_STRING_LENGTH
      && (trimmed[0] === '{' || trimmed[0] === '[')
      && (trimmed[trimmed.length - 1] === '}' || trimmed[trimmed.length - 1] === ']')
    ) {
      const parsed = tryParseJson(trimmed);
      if (parsed !== undefined) walk(parsed, context, out, state, depth + 1);
    }
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      if (state.events >= MAX_EVENTS || state.visited >= MAX_NODES) break;
      if (item == null) continue;
      if (typeof item !== 'object' && typeof item !== 'string') continue;
      walk(item, context, out, state, depth + 1);
    }
    return;
  }

  if (typeof node !== 'object') return;

  state.visited += 1;
  const localContext = deriveContext(node, context);

  const direct = readDirectUsage(node, localContext);
  if (direct) pushEvent(direct, out, state);

  for (const value of Object.values(node)) {
    if (state.events >= MAX_EVENTS || state.visited >= MAX_NODES) break;
    if (value == null) continue;
    if (typeof value !== 'object' && typeof value !== 'string') continue;
    walk(value, localContext, out, state, depth + 1);
  }
}

function pushEvent(event, out, state) {
  const key = usageEventKey(event);
  if (state.seen.has(key)) return;
  state.seen.add(key);
  state.events += 1;
  out.push(event);
}

/**
 * 深扫任意 JSON 值，提取其中所有用量。
 * @param {unknown} value
 * @param {object} [inherited] 上下文（source/observedAt/endpoint/targetId/targetTitle/model/sessionId/messageId）
 * @returns {Array<object>} UsageEvent[]
 */
function extractUsageEvents(value, inherited = {}) {
  const out = [];
  try {
    const context = normalizeInherited(inherited);
    walk(value, context, out, { seen: new Set(), events: 0, visited: 0 }, 0);
  } catch {
    // 解析过程必须零异常：遇到异常 payload 时返回已收集的部分
  }
  return out;
}

/**
 * 判断一个值是否“像”用量对象（含嵌套 usage 容器）。
 * @param {unknown} value
 * @returns {boolean}
 */
function looksLikeUsage(value) {
  return looksLikeUsageInternal(value, 0);
}

function looksLikeUsageInternal(value, depth) {
  if (value == null || typeof value !== 'object') return false;
  if (depth > 5) return false;
  if (Array.isArray(value)) {
    return value.some((item) => looksLikeUsageInternal(item, depth + 1));
  }
  for (const key of DIRECT_USAGE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key) && isFiniteNumberLike(value[key])) return true;
  }
  if (isFiniteNumberLike(value.credits) || isFiniteNumberLike(value.credits_float)) return true;
  const feeUsage = value.fee_usage || value.feeUsage;
  if (feeUsage && typeof feeUsage === 'object' && isFiniteNumberLike(feeUsage.credits)) return true;
  // 已知容器名优先，再兜底扫任意子对象（深层嵌套的 response/data 等）
  for (const key of USAGE_CONTAINER_KEYS) {
    if (looksLikeUsageInternal(value[key], depth + 1)) return true;
  }
  for (const key of Object.keys(value)) {
    if (USAGE_CONTAINER_KEYS.includes(key)) continue;
    if (looksLikeUsageInternal(value[key], depth + 1)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 账单（credits_float）深扫 —— collector 使用（附加导出）
// ---------------------------------------------------------------------------

/**
 * 深扫账单响应，找出所有 credits（`credits_float|credits|fee_usage.credits`），
 * 产出 source='billing' 的 UsageEvent；billingId 取响应里的 session_id。
 * @param {unknown} value
 * @param {object} [inherited]
 * @returns {Array<object>}
 */
function extractBillingEvents(value, inherited = {}) {
  const out = [];
  try {
    const context = normalizeInherited({ ...inherited, source: 'billing' });
    walkBilling(value, context, out, { seen: new Set(), events: 0, visited: 0 }, 0);
  } catch {
    /* 零异常 */
  }
  return out;
}

function walkBilling(node, context, out, state, depth) {
  if (node == null) return;
  if (state.events >= MAX_EVENTS || state.visited >= MAX_NODES) return;
  if (depth > MAX_DEPTH) return;

  if (typeof node === 'string') {
    const trimmed = node.trim();
    if (
      trimmed.length > 1
      && trimmed.length <= MAX_JSON_STRING_LENGTH
      && (trimmed[0] === '{' || trimmed[0] === '[')
      && (trimmed[trimmed.length - 1] === '}' || trimmed[trimmed.length - 1] === ']')
    ) {
      const parsed = tryParseJson(trimmed);
      if (parsed !== undefined) walkBilling(parsed, context, out, state, depth + 1);
    }
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      if (state.events >= MAX_EVENTS || state.visited >= MAX_NODES) break;
      if (item == null) continue;
      if (typeof item !== 'object' && typeof item !== 'string') continue;
      walkBilling(item, context, out, state, depth + 1);
    }
    return;
  }

  if (typeof node !== 'object') return;

  state.visited += 1;
  const localContext = deriveContext(node, context);

  const credits = pickCredits(node);
  if (credits != null && state.events < MAX_EVENTS) {
    const event = buildBillingEvent(node, localContext, credits);
    const key = usageEventKey(event);
    if (!state.seen.has(key)) {
      state.seen.add(key);
      state.events += 1;
      out.push(event);
    }
  }

  for (const [, value] of Object.entries(node)) {
    if (state.events >= MAX_EVENTS || state.visited >= MAX_NODES) break;
    if (value == null) continue;
    if (typeof value !== 'object' && typeof value !== 'string') continue;
    walkBilling(value, localContext, out, state, depth + 1);
  }
}

/** 账单对象本身可能只有 credits，token 用量在其子 usage 容器里；找到真正携带 token 的对象。 */
function findTokenHolder(node) {
  const own = readTokenFields(node);
  if (own.input != null || own.output != null || own.total != null) return node;
  for (const [key, value] of Object.entries(node)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (!(USAGE_CONTAINER_KEYS.includes(key) || /usage/i.test(key))) continue;
    const fields = readTokenFields(value);
    if (fields.input != null || fields.output != null || fields.total != null) return value;
  }
  return node;
}

function buildBillingEvent(node, context, credits) {
  const holder = findTokenHolder(node);
  const fields = readTokenFields(holder);
  const input = toTokenCount(fields.input);
  const output = toTokenCount(fields.output);
  const totalFromPayload = fields.total != null ? toTokenCount(fields.total) : null;
  const total = totalFromPayload != null && totalFromPayload >= input + output
    ? totalFromPayload
    : input + output;
  const sessionId = context.sessionId != null ? context.sessionId : null;
  const model = context.model != null && context.model !== ''
    ? context.model
    : pickString(holder, MODEL_KEYS);
  return buildUsageEvent({
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cacheReadTokens: toTokenCount(fields.cacheRead),
    cacheWriteTokens: toTokenCount(fields.cacheWrite),
    reasoningTokens: fields.reasoning,
    usageComplete: hasCompleteTokenFields(fields),
    credits,
    model,
    sessionId,
    messageId: context.messageId,
    billingId: sessionId,
    source: 'billing',
    observedAt: context.observedAt,
    endpoint: context.endpoint,
    targetId: context.targetId,
    targetTitle: context.targetTitle
  });
}

// ---------------------------------------------------------------------------
// 文本 -> JSON 值（JSON / SSE / JSONL / 混合文本）
// ---------------------------------------------------------------------------

/**
 * 把响应文本拆成若干 JSON 值：支持整段 JSON、SSE（`data: {...}`、`[DONE]`、注释/事件行）、
 * JSONL，以及混合文本中的平衡 JSON 片段。非 JSON 行一律忽略。
 * @param {string} text
 * @returns {any[]}
 */
function parseJsonValues(text) {
  if (typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length > MAX_VALUE_TEXT_LENGTH) return [];

  const values = [];
  const whole = tryParseJson(trimmed);
  if (whole !== undefined) return [whole];

  const lines = trimmed.split(/\r?\n/);
  let dataBuffer = '';

  const flushBuffer = () => {
    if (!dataBuffer) return;
    const parsed = tryParseJson(dataBuffer);
    if (parsed !== undefined) values.push(parsed);
    dataBuffer = '';
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushBuffer();
      continue;
    }
    if (line === '[DONE]' || line === '[DONE],') {
      flushBuffer();
      continue;
    }
    if (line.startsWith(':') || line.startsWith('//')) continue; // SSE 注释

    const dataMatch = /^data\s*:\s?(.*)$/i.exec(line);
    if (dataMatch) {
      const payload = dataMatch[1].trim();
      if (!payload || payload === '[DONE]') {
        flushBuffer();
        continue;
      }
      const direct = tryParseJson(payload);
      if (direct !== undefined) {
        values.push(direct);
        dataBuffer = '';
      } else {
        // 一个 SSE 事件的 JSON 可能跨多行 data:
        dataBuffer = dataBuffer ? `${dataBuffer}\n${payload}` : payload;
        const buffered = tryParseJson(dataBuffer);
        if (buffered !== undefined) {
          values.push(buffered);
          dataBuffer = '';
        }
      }
      continue;
    }

    if (/^(event|id|retry)\s*:/i.test(line)) continue;

    flushBuffer();
    const parsed = tryParseJson(line);
    if (parsed !== undefined) values.push(parsed);
  }
  flushBuffer();

  if (values.length === 0) {
    for (const candidate of extractBalancedJsonValues(trimmed)) values.push(candidate);
  }
  return values;
}

/** 从混合文本中提取顶层的平衡 JSON 片段（最多 MAX_EMBEDDED_VALUES 个）。 */
function extractBalancedJsonValues(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    if (out.length >= MAX_EMBEDDED_VALUES) break;
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          const parsed = tryParseJson(text.slice(start, i + 1));
          if (parsed !== undefined) out.push(parsed);
          start = -1;
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// URL 端点
// ---------------------------------------------------------------------------

/** 去掉 query/hash，保留 protocol + host + path（契约要求）。 */
function endpointOfUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    const withoutHash = url.split('#')[0];
    const withoutQuery = withoutHash.split('?')[0];
    return withoutQuery || null;
  }
}

// ---------------------------------------------------------------------------
// 公开入口：响应体 -> UsageEvent[]
// ---------------------------------------------------------------------------

/**
 * 解析网络响应体 / WebSocket 文本帧中的用量。
 * @param {string} text
 * @param {{ url?: string|null }} [options]
 * @returns {Array<object>} UsageEvent[]（source 默认 'network'，由调用方覆盖）
 */
function parseResponseBody(text, options = {}) {
  const url = options && typeof options.url === 'string' ? options.url : null;
  const values = parseJsonValues(text);
  if (values.length === 0) return [];
  const observedAt = Date.now();
  const endpoint = endpointOfUrl(url);
  const events = [];
  const seen = new Set();
  for (const value of values) {
    const found = extractUsageEvents(value, { source: 'network', observedAt, endpoint });
    for (const event of found) {
      const key = usageEventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
  }
  return events;
}

module.exports = {
  parseResponseBody,
  extractUsageEvents,
  looksLikeUsage,
  normalizeModelName,
  // 附加导出（不改变契约签名，collector/测试复用）
  parseJsonValues,
  extractBillingEvents,
  endpointOfUrl
};
