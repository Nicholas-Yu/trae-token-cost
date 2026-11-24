'use strict';

/**
 * src/data/store.js
 *
 * UsageStore —— 本地 SQLite 用量存储（契约 docs/INTERFACES.md §5）。
 *
 * 设计要点：
 * - 零第三方依赖，使用 Node 内置 node:sqlite（Electron 39 / Node 22.21 与系统 Node 24 均可用）。
 * - 所有 ID（sessionId/messageId/billingId/turn_key）落库前做 sha256 前 16 位十六进制。
 * - 去重/合并按契约顺序执行：turn_key → billing_key → billing 回填 → 10s 跨通道 → INSERT。
 * - credits 仅在有限数值时落库；creditKind='estimated' 记为 estimated，其余有限值记为 actual。
 * - summary/csv 的聚合口径见各方法注释。
 * - 所有方法在 close() 之后调用都会抛出清晰错误。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startOfDaysAgo } = require('../util');

/** 本地日历日键（与 summary.days 的 strftime localtime 口径一致）。 */
function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const HASH_PREFIX_LEN = 16;
const CROSS_CHANNEL_WINDOW_MS = 10 * 1000;
const BILLING_BACKFILL_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_RECENT_LIMIT = 200;
const DEFAULT_SUMMARY_RECENT_LIMIT = 100;
const DEFAULT_RETENTION_DAYS = 180;
const SCHEMA_VERSION = '4';

let DatabaseSync = null;
let sqliteRequireError = null;
try {
  // Node 22.5+ / Electron 39 内置。Node 22 早期版本会打印 ExperimentalWarning，属预期。
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  sqliteRequireError = err;
}

const SCHEMA_SQL = `
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
  reasoning_tokens INTEGER,
  usage_complete INTEGER NOT NULL DEFAULT 0,
  credits REAL,
  credit_kind TEXT NOT NULL DEFAULT 'unknown',
  host_label TEXT,
  workspace_name TEXT,
  window_title TEXT,
  session_key TEXT,
  message_key TEXT,
  billing_key TEXT,
  endpoint TEXT,
  first_response_ms INTEGER,
  duration_ms INTEGER,
  timing_source TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS calls_observed_at ON calls(observed_at DESC);
CREATE INDEX IF NOT EXISTS calls_model ON calls(model);
CREATE INDEX IF NOT EXISTS calls_turn_key ON calls(turn_key);
CREATE INDEX IF NOT EXISTS calls_host ON calls(host_label);
CREATE INDEX IF NOT EXISTS calls_billing_key ON calls(billing_key);
CREATE INDEX IF NOT EXISTS calls_session_key ON calls(session_key, observed_at);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** 可被合并更新的列（不含 id / created_at）。 */
const MUTABLE_COLUMNS = [
  'observed_at',
  'turn_key',
  'source',
  'model',
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'usage_complete',
  'credits',
  'credit_kind',
  'host_label',
  'workspace_name',
  'window_title',
  'session_key',
  'message_key',
  'billing_key',
  'endpoint',
  'first_response_ms',
  'duration_ms',
  'timing_source',
];

/** CSV 列顺序（带 UTF-8 BOM + CRLF，字段按 RFC 4180 转义）。 */
const CSV_COLUMNS = [
  'observed_at',
  'model',
  'source',
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'usage_complete',
];

/**
 * sha256(value) 前 16 位十六进制；空值/空串返回 null。
 * @param {*} value
 * @returns {string|null}
 */
function sha16(value) {
  if (value === null || value === undefined) return null;
  const str = typeof value === 'string' ? value : String(value);
  if (str.length === 0) return null;
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, HASH_PREFIX_LEN);
}

/**
 * token 计数归一化：缺省/非法 → 0；负数抛错；小数向下取整。
 * @param {*} value
 * @param {string} field 字段名（错误信息用）
 * @returns {number}
 */
function normalizeTokenCount(value, field) {
  if (value === null || value === undefined) return 0;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new TypeError(`UsageStore.record: ${field} 必须是有限数字，收到 ${String(value)}`);
  }
  if (num < 0) {
    throw new RangeError(`UsageStore.record: ${field} 不能为负数，收到 ${num}`);
  }
  return Math.floor(num);
}

/**
 * credits 归一化：仅接受 number 且有限；其它（null/NaN/字符串）→ null。
 * @param {*} value
 * @returns {number|null}
 */
function normalizeCredits(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 推理 Token 可缺省为 null，避免把未上报误认为零。 */
function normalizeOptionalTokenCount(value, field) {
  if (value === null || value === undefined) return null;
  return normalizeTokenCount(value, field);
}

function normalizeTimingMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

/** 计费必需字段必须在原始事件中完整存在，不能由默认零值补齐。 */
function hasCompleteUsage(event) {
  return ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    .every((field) => event[field] !== null && event[field] !== undefined && Number.isFinite(Number(event[field])) && Number(event[field]) >= 0);
}

function maxNullableNumber(existing, incoming) {
  if (existing === null || existing === undefined) return incoming ?? null;
  if (incoming === null || incoming === undefined) return existing;
  return Math.max(existing, incoming);
}

/**
 * 合并 source 字段：逗号分隔、去重、保留已有顺序。
 * @param {string|null} existing
 * @param {string|null} incoming
 * @returns {string}
 */
function mergeSources(existing, incoming) {
  const parts = [];
  const seen = new Set();
  for (const raw of [existing, incoming]) {
    if (typeof raw !== 'string') continue;
    for (const piece of raw.split(',')) {
      const value = piece.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      parts.push(value);
    }
  }
  return parts.join(',') || 'unknown';
}

/** 空字符串视为空值。 */
function isBlank(value) {
  return value === null || value === undefined || value === '';
}

/** COALESCE：existing 非空则保留，否则取 incoming。 */
function coalesce(existing, incoming) {
  return isBlank(existing) ? (isBlank(incoming) ? null : incoming) : existing;
}

/** 行对象转换为普通 JS 对象（node:sqlite 返回的是 null prototype 对象）。 */
function toPlainRow(row) {
  return row ? { ...row } : null;
}

/**
 * 把 UsageEvent 归一化成 calls 表的一行（snake_case）。
 * @param {object} event
 * @returns {object}
 */
function normalizeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('UsageStore.record(event): event 必须是对象');
  }
  const inputTokens = normalizeTokenCount(event.inputTokens, 'inputTokens');
  const outputTokens = normalizeTokenCount(event.outputTokens, 'outputTokens');
  let totalTokens;
  if (event.totalTokens === null || event.totalTokens === undefined) {
    totalTokens = inputTokens + outputTokens;
  } else {
    totalTokens = normalizeTokenCount(event.totalTokens, 'totalTokens');
  }
  // 契约：totalTokens 缺省 = input + output；显式给出偏小值时仍以两者之和兜底，避免统计漏量。
  totalTokens = Math.max(totalTokens, inputTokens + outputTokens);

  const credits = normalizeCredits(event.credits);
  let creditKind = 'unknown';
  if (credits !== null) {
    creditKind = event.creditKind === 'estimated' ? 'estimated' : 'actual';
  }

  const observedAtRaw = Number(event.observedAt);
  const observedAt = Number.isFinite(observedAtRaw) ? Math.floor(observedAtRaw) : Date.now();

  const rawSessionId = isBlank(event.sessionId) ? null : String(event.sessionId);
  const rawMessageId = isBlank(event.messageId) ? null : String(event.messageId);
  const rawBillingId = isBlank(event.billingId) ? null : String(event.billingId);
  const sessionKey = sha16(rawSessionId);
  const messageKey = sha16(rawMessageId);
  const billingKey = sha16(rawBillingId);
  const turnKey = (sessionKey || messageKey)
    ? sha16(`${rawSessionId || ''}|${rawMessageId || ''}`)
    : null;

  const modelRaw = typeof event.model === 'string' ? event.model.trim() : '';
  const endpoint = typeof event.endpoint === 'string' && event.endpoint.length > 0
    ? event.endpoint
    : null;
  const source = typeof event.source === 'string' && event.source.trim().length > 0
    ? event.source.trim()
    : 'unknown';
  const firstResponseMs = normalizeTimingMs(event.firstResponseMs);
  const durationMs = normalizeTimingMs(event.durationMs);
  // 两种合法来源：network-inferred（本机可见 /completions 的 CDP 时间戳）、
  // debugger-inferred（断点白名单读取 Trae 回传的逐调用服务端计时）。
  const timingSource = (firstResponseMs !== null || durationMs !== null)
    && (event.timingSource === 'network-inferred' || event.timingSource === 'debugger-inferred')
    ? event.timingSource : null;

  return {
    observed_at: observedAt,
    turn_key: turnKey,
    source,
    model: modelRaw || 'unknown',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cache_read_tokens: normalizeTokenCount(event.cacheReadTokens, 'cacheReadTokens'),
    cache_write_tokens: normalizeTokenCount(event.cacheWriteTokens, 'cacheWriteTokens'),
    reasoning_tokens: normalizeOptionalTokenCount(event.reasoningTokens, 'reasoningTokens'),
    usage_complete: (typeof event.usageComplete === 'boolean' ? event.usageComplete : hasCompleteUsage(event)) ? 1 : 0,
    credits,
    credit_kind: creditKind,
    host_label: null,
    workspace_name: null,
    window_title: null,
    session_key: sessionKey,
    message_key: messageKey,
    billing_key: billingKey,
    endpoint,
    first_response_ms: firstResponseMs,
    duration_ms: durationMs,
    timing_source: timingSource,
  };
}

/**
 * CSV 字段转义（RFC 4180）。
 * @param {*} value
 * @returns {string}
 */
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

class UsageStore {
  /**
   * @param {string} dbPath SQLite 文件路径（或 ':memory:'）
   * @param {{readOnly?: boolean}} [options]
   */
  constructor(dbPath, { readOnly = false } = {}) {
    if (!DatabaseSync) {
      const err = new Error(
        'UsageStore 需要 Node 内置 node:sqlite（Node 22.5+ / Electron 39+），当前运行环境不可用'
        + (sqliteRequireError ? `：${sqliteRequireError.message}` : ''),
      );
      err.code = 'SQLITE_UNAVAILABLE';
      err.cause = sqliteRequireError;
      throw err;
    }
    if (typeof dbPath !== 'string' || dbPath.length === 0) {
      throw new TypeError('UsageStore(dbPath): dbPath 必须是非空字符串');
    }

    this.dbPath = dbPath;
    this._closed = false;
    this._readOnly = readOnly;
    this._statements = new Map();

    if (readOnly) {
      this._db = new DatabaseSync(dbPath, { readOnly: true });
      this._db.exec('PRAGMA query_only = ON;');
      this._db.exec('PRAGMA busy_timeout = 5000;');
      return;
    }

    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }

    this._db = new DatabaseSync(dbPath);
    // WAL 是持久化设置；:memory: 下 SQLite 会退回 memory 日志，不影响使用。
    this._db.exec('PRAGMA journal_mode = WAL;');
    this._db.exec('PRAGMA synchronous = NORMAL;');
    this._db.exec('PRAGMA busy_timeout = 5000;');
    this._db.exec(SCHEMA_SQL);
    // v1 数据库只补充新列，保留原记录、索引和去重键。
    const columns = new Set(this._db.prepare('PRAGMA table_info(calls)').all().map((row) => row.name));
    if (!columns.has('reasoning_tokens')) this._db.exec('ALTER TABLE calls ADD COLUMN reasoning_tokens INTEGER');
    if (!columns.has('usage_complete')) this._db.exec("ALTER TABLE calls ADD COLUMN usage_complete INTEGER NOT NULL DEFAULT 0");
    if (!columns.has('first_response_ms')) this._db.exec('ALTER TABLE calls ADD COLUMN first_response_ms INTEGER');
    if (!columns.has('duration_ms')) this._db.exec('ALTER TABLE calls ADD COLUMN duration_ms INTEGER');
    if (!columns.has('timing_source')) this._db.exec('ALTER TABLE calls ADD COLUMN timing_source TEXT');
    this._db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
    this._db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('created_at', String(Date.now()));
  }

  /** 断言实例可用。 */
  _assertOpen() {
    if (this._closed || !this._db) {
      throw new Error('UsageStore 已关闭，不能再执行操作');
    }
  }

  /** 写操作必须在连接打开且非只读时执行。 */
  _assertWritable() {
    this._assertOpen();
    if (this._readOnly) {
      throw new Error('UsageStore 当前为只读模式，不能执行写操作');
    }
  }

  /**
   * 预处理 SQL 并按 SQL 文本缓存 Statement。
   * @param {string} sql
   */
  _stmt(sql) {
    let stmt = this._statements.get(sql);
    if (!stmt) {
      stmt = this._db.prepare(sql);
      this._statements.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * 按 id 查询一行。
   * @param {number} id
   * @returns {object|null}
   */
  _rowById(id) {
    return toPlainRow(this._stmt('SELECT * FROM calls WHERE id = ?').get(id));
  }

  /**
   * 把两条记录合并后 UPDATE 回数据库，返回合并后的行。
   * 规则：token 取 max、actual 积分优先、source 逗号合并去重、空字段 COALESCE、observed_at 取较早值。
   * @param {object} existing 数据库中的现有行
   * @param {object} incoming 归一化后的新行
   * @returns {object}
   */
  _merge(existing, incoming) {
    const merged = {
      observed_at: Math.min(existing.observed_at, incoming.observed_at),
      turn_key: coalesce(existing.turn_key, incoming.turn_key),
      source: mergeSources(existing.source, incoming.source),
      model: existing.model && existing.model !== 'unknown' ? existing.model : (incoming.model || 'unknown'),
      input_tokens: Math.max(existing.input_tokens, incoming.input_tokens),
      output_tokens: Math.max(existing.output_tokens, incoming.output_tokens),
      total_tokens: Math.max(existing.total_tokens, incoming.total_tokens),
      cache_read_tokens: Math.max(existing.cache_read_tokens, incoming.cache_read_tokens),
      cache_write_tokens: Math.max(existing.cache_write_tokens, incoming.cache_write_tokens),
      reasoning_tokens: maxNullableNumber(existing.reasoning_tokens, incoming.reasoning_tokens),
      usage_complete: existing.usage_complete || incoming.usage_complete ? 1 : 0,
      credits: existing.credits,
      credit_kind: existing.credit_kind || 'unknown',
      host_label: coalesce(existing.host_label, incoming.host_label),
      workspace_name: coalesce(existing.workspace_name, incoming.workspace_name),
      window_title: coalesce(existing.window_title, incoming.window_title),
      session_key: coalesce(existing.session_key, incoming.session_key),
      message_key: coalesce(existing.message_key, incoming.message_key),
      billing_key: coalesce(existing.billing_key, incoming.billing_key),
      endpoint: coalesce(existing.endpoint, incoming.endpoint),
      first_response_ms: coalesce(existing.first_response_ms, incoming.first_response_ms),
      duration_ms: coalesce(existing.duration_ms, incoming.duration_ms),
      timing_source: coalesce(existing.timing_source, incoming.timing_source),
    };

    // 积分合并：actual 永远优先；estimated 可在没有 actual 时覆盖 unknown/estimated。
    if (incoming.credit_kind === 'actual') {
      merged.credits = incoming.credits;
      merged.credit_kind = 'actual';
    } else if (incoming.credit_kind === 'estimated' && merged.credit_kind !== 'actual') {
      merged.credits = incoming.credits;
      merged.credit_kind = 'estimated';
    }

    const assignments = MUTABLE_COLUMNS.map((column) => `${column} = ?`).join(', ');
    const values = MUTABLE_COLUMNS.map((column) => merged[column]);
    this._stmt(`UPDATE calls SET ${assignments} WHERE id = ?`).run(...values, existing.id);
    return this._rowById(existing.id);
  }

  /**
   * 记录一条 UsageEvent；命中去重规则时合并而不是新增。
   * @param {object} event UsageEvent（camelCase，见契约 §1）
   * @param {{hostLabel?: string|null, workspaceName?: string|null}} [options]
   * @returns {object} 落库后的行（snake_case，与 calls 表列一致）
   */
  record(event, options = {}) {
    this._assertWritable();
    // 多进程同时接管时，必须让去重查询与后续写入处于同一事务。
    this._db.exec('BEGIN IMMEDIATE');
    try {
      const row = this._record(event, options);
      this._db.exec('COMMIT');
      return row;
    } catch (error) {
      try { this._db.exec('ROLLBACK'); } catch { /* 保留原始写入错误 */ }
      throw error;
    }
  }

  _record(event, options = {}) {
    const { hostLabel = null } = options || {};
    const incoming = normalizeEvent(event);
    incoming.host_label = isBlank(hostLabel) ? null : String(hostLabel);
    // 原始工作区名和窗口标题不落盘；内部哈希键继续用于去重。
    incoming.workspace_name = null;
    incoming.window_title = null;

    // 规则 1：turn_key 命中。
    if (incoming.turn_key) {
      const existing = toPlainRow(
        this._stmt('SELECT * FROM calls WHERE turn_key = ? ORDER BY id ASC LIMIT 1').get(incoming.turn_key),
      );
      if (existing) return this._merge(existing, incoming);
    }

    // 规则 2：billing_key 命中。
    if (incoming.billing_key) {
      const existing = toPlainRow(
        this._stmt('SELECT * FROM calls WHERE billing_key = ? ORDER BY id ASC LIMIT 1').get(incoming.billing_key),
      );
      if (existing) return this._merge(existing, incoming);
    }

    // 规则 3：billing 事件回填“同 model + 同 token 三件套 + 无实际积分”的既有行（±15 分钟）。
    if (incoming.credit_kind === 'actual' && incoming.source.split(',').includes('billing')) {
      const existing = toPlainRow(
        this._stmt(
          `SELECT * FROM calls
            WHERE model = ? AND input_tokens = ? AND output_tokens = ? AND total_tokens = ?
              AND credit_kind <> 'actual'
              AND observed_at BETWEEN ? AND ?
            ORDER BY ABS(observed_at - ?) ASC, id ASC
            LIMIT 1`,
        ).get(
          incoming.model,
          incoming.input_tokens,
          incoming.output_tokens,
          incoming.total_tokens,
          incoming.observed_at - BILLING_BACKFILL_WINDOW_MS,
          incoming.observed_at + BILLING_BACKFILL_WINDOW_MS,
          incoming.observed_at,
        ),
      );
      if (existing) return this._merge(existing, incoming);
    }

    // 规则 4：同 model + 同 token 三件套 + 10 秒内（跨通道重复）合并。
    const crossChannel = toPlainRow(
      this._stmt(
        `SELECT * FROM calls
          WHERE model = ? AND input_tokens = ? AND output_tokens = ? AND total_tokens = ?
            AND observed_at BETWEEN ? AND ?
          ORDER BY ABS(observed_at - ?) ASC, id ASC
          LIMIT 1`,
      ).get(
        incoming.model,
        incoming.input_tokens,
        incoming.output_tokens,
        incoming.total_tokens,
        incoming.observed_at - CROSS_CHANNEL_WINDOW_MS,
        incoming.observed_at + CROSS_CHANNEL_WINDOW_MS,
        incoming.observed_at,
      ),
    );
    if (crossChannel) return this._merge(crossChannel, incoming);

    // 规则 5：新增。
    const created = {
      ...incoming,
      created_at: Date.now(),
    };
    const columns = [...MUTABLE_COLUMNS, 'created_at'];
    const placeholders = columns.map(() => '?').join(', ');
    const result = this._stmt(`INSERT INTO calls (${columns.join(', ')}) VALUES (${placeholders})`).run(
      ...columns.map((column) => created[column]),
    );
    return this._rowById(Number(result.lastInsertRowid));
  }

  /** 按时间升序逐行读取，供费用聚合与导出使用，避免一次性加载全部记录。 */
  *iterate(options = {}) {
    this._assertOpen();
    const { sinceMs = null } = options || {};
    const params = [];
    let where = '';
    if (sinceMs !== null && sinceMs !== undefined && Number.isFinite(Number(sinceMs))) {
      where = 'WHERE observed_at >= ?';
      params.push(Math.floor(Number(sinceMs)));
    }
    const rows = this._stmt(`SELECT * FROM calls ${where} ORDER BY observed_at ASC, id ASC`).iterate(...params);
    for (const row of rows) yield toPlainRow(row);
  }

  /**
   * 最近记录（按 observed_at DESC, id DESC）。
   * @param {{limit?: number, sinceMs?: number|null, hostLabel?: string|null}} [options]
   * @returns {object[]}
   */
  recent(options = {}) {
    this._assertOpen();
    const { limit = DEFAULT_RECENT_LIMIT, sinceMs = null, hostLabel = null } = options || {};
    let safeLimit = Math.floor(Number(limit));
    if (!Number.isFinite(safeLimit) || safeLimit <= 0) safeLimit = DEFAULT_RECENT_LIMIT;
    safeLimit = Math.min(safeLimit, 10000);

    const clauses = [];
    const params = [];
    if (sinceMs !== null && sinceMs !== undefined && Number.isFinite(Number(sinceMs))) {
      clauses.push('observed_at >= ?');
      params.push(Math.floor(Number(sinceMs)));
    }
    if (!isBlank(hostLabel)) {
      clauses.push('host_label = ?');
      params.push(String(hostLabel));
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this._stmt(
      `SELECT * FROM calls ${where} ORDER BY observed_at DESC, id DESC LIMIT ?`,
    ).all(...params, safeLimit);
    return rows.map(toPlainRow);
  }

  /**
   * 汇总。sinceMs 为 null/缺省表示全部。
   * @param {{sinceMs?: number|null}} [options]
   * @returns {{
   *   total: object,
   *   models: object[],
   *   hosts: object[],
   *   days: object[],
   *   recent: object[]
   * }}
   */
  summary(options = {}) {
    this._assertOpen();
    const { sinceMs = null } = options || {};
    const params = [];
    let where = '';
    if (sinceMs !== null && sinceMs !== undefined && Number.isFinite(Number(sinceMs))) {
      where = 'WHERE observed_at >= ?';
      params.push(Math.floor(Number(sinceMs)));
    }

    const actualSum = "COALESCE(SUM(CASE WHEN credit_kind = 'actual' THEN credits ELSE 0 END), 0)";
    const estimatedSum = "COALESCE(SUM(CASE WHEN credit_kind = 'estimated' THEN credits ELSE 0 END), 0)";

    const totalRow = toPlainRow(
      this._stmt(
        `SELECT
            COUNT(*) AS calls,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
            COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
            COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
            COALESCE(SUM(CASE WHEN usage_complete = 0 THEN 1 ELSE 0 END), 0) AS incomplete_calls,
            COUNT(CASE WHEN duration_ms > 0 THEN 1 END) AS timed_calls,
            COUNT(CASE WHEN first_response_ms > 0 THEN 1 END) AS first_response_timed_calls,
            COALESCE(SUM(duration_ms), 0) AS duration_ms_sum,
            COALESCE(SUM(first_response_ms), 0) AS first_response_ms_sum,
            COALESCE(SUM(CASE WHEN duration_ms > 0 THEN output_tokens ELSE 0 END), 0) AS timed_output_tokens,
            ${actualSum} AS actual_credits,
            ${estimatedSum} AS estimated_credits
          FROM calls ${where}`,
      ).get(...params),
    ) || {
      calls: 0,
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      incomplete_calls: 0,
      timed_calls: 0,
      first_response_timed_calls: 0,
      duration_ms_sum: 0,
      first_response_ms_sum: 0,
      timed_output_tokens: 0,
      actual_credits: 0,
      estimated_credits: 0,
    };

    // Lead 确认口径：cache_read_tokens / input_tokens，保留 4 位小数；input=0 时为 null。
    let cacheHitRate = null;
    if (Number(totalRow.input_tokens) > 0) {
      cacheHitRate = Math.round((Number(totalRow.cache_read_tokens) / Number(totalRow.input_tokens)) * 10000) / 10000;
    }
    totalRow.cache_hit_rate = cacheHitRate;

    const models = this._stmt(
      `SELECT
          model,
          COUNT(*) AS calls,
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cache_read_tokens), 0) AS cached_tokens,
          COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
          COALESCE(SUM(CASE WHEN usage_complete = 0 THEN 1 ELSE 0 END), 0) AS incomplete_calls,
          ${actualSum} AS actual_credits,
          ${estimatedSum} AS estimated_credits
        FROM calls ${where}
        GROUP BY model
        ORDER BY total_tokens DESC, model ASC`,
    ).all(...params).map(toPlainRow);

    const hosts = this._stmt(
      `SELECT
          COALESCE(host_label, '本机') AS host_label,
          COUNT(*) AS calls,
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cache_read_tokens), 0) AS cached_tokens,
          ${actualSum} AS actual_credits,
          ${estimatedSum} AS estimated_credits
        FROM calls ${where}
        GROUP BY COALESCE(host_label, '本机')
        ORDER BY total_tokens DESC, host_label ASC`,
    ).all(...params).map(toPlainRow);

    const days = this._stmt(
      `SELECT
          strftime('%Y-%m-%d', observed_at / 1000, 'unixepoch', 'localtime') AS day,
          COUNT(*) AS calls,
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cache_read_tokens), 0) AS cached_tokens,
          COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
          COALESCE(SUM(CASE WHEN usage_complete = 0 THEN 1 ELSE 0 END), 0) AS incomplete_calls,
          ${actualSum} AS actual_credits,
          ${estimatedSum} AS estimated_credits
        FROM calls ${where}
        GROUP BY day
        ORDER BY day ASC`,
    ).all(...params).map(toPlainRow);

    const dayModels = this._stmt(
      `SELECT
          strftime('%Y-%m-%d', observed_at / 1000, 'unixepoch', 'localtime') AS day,
          model,
          COUNT(*) AS calls,
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
          COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
          COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
          COUNT(duration_ms) AS timed_calls,
          COALESCE(SUM(duration_ms), 0) AS duration_ms_sum,
          COALESCE(SUM(first_response_ms), 0) AS first_response_ms_sum
        FROM calls ${where}
        GROUP BY day, model
        ORDER BY day ASC, total_tokens DESC, model ASC`,
    ).all(...params).map(toPlainRow);

    return {
      total: totalRow,
      models,
      hosts,
      days,
      dayModels,
      recent: this.recent({ limit: DEFAULT_SUMMARY_RECENT_LIMIT, sinceMs }),
    };
  }

  /**
   * 活动热力图数据：固定最近 N 个本地日历日（含今天）的 Token/调用数，缺数据日补零。
   * 独立于当前时间范围；单 SQL 日聚合，不做费用装饰、不重复 iterate。
   * @param {{sinceMs?: number|null, days?: number}} [options]
   * @returns {{days: Array<{day: string, total_tokens: number, calls: number}>}}
   */
  activityDays(options = {}) {
    this._assertOpen();
    const { sinceMs = null, days = 56 } = options || {};
    const params = [];
    let where = '';
    if (sinceMs !== null && sinceMs !== undefined && Number.isFinite(Number(sinceMs))) {
      where = 'WHERE observed_at >= ?';
      params.push(Math.floor(Number(sinceMs)));
    }
    const rows = this._stmt(
      `SELECT
          strftime('%Y-%m-%d', observed_at / 1000, 'unixepoch', 'localtime') AS day,
          COUNT(*) AS calls,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM calls ${where}
        GROUP BY day`,
    ).all(...params).map(toPlainRow);
    const byDay = new Map(rows.map((row) => [row.day, row]));
    let count = Math.floor(Number(days));
    if (!Number.isFinite(count) || count <= 0) count = 56;
    const out = [];
    for (let i = count - 1; i >= 0; i -= 1) {
      const key = localDayKey(startOfDaysAgo(i));
      const hit = byDay.get(key);
      out.push({ day: key, total_tokens: hit ? hit.total_tokens : 0, calls: hit ? hit.calls : 0 });
    }
    return { days: out };
  }

  /**
   * 导出 CSV：UTF-8 BOM + CRLF + RFC 4180 转义。observed_at 输出 ISO 8601。
   * @param {{sinceMs?: number|null}} [options]
   * @returns {string}
   */
  csv(options = {}) {
    this._assertOpen();
    const { sinceMs = null } = options || {};
    const lines = [CSV_COLUMNS.join(',')];
    let count = 0;
    for (const record of this.iterate({ sinceMs })) {
      record.observed_at = Number.isFinite(record.observed_at)
        ? new Date(record.observed_at).toISOString()
        : '';
      lines.push(CSV_COLUMNS.map((column) => csvEscape(record[column])).join(','));
      count += 1;
    }
    return `\uFEFF${lines.join('\r\n')}${count > 0 ? '\r\n' : ''}`;
  }

  /**
   * 清空所有调用记录。
   * @returns {number} 删除行数
   */
  /** 历史记录里同会话已有已知模型时，回填 unknown 行（旧版本采集缺 model）。返回更新条数。 */
  backfillModels() {
    this._assertWritable();
    const sql = `
      UPDATE calls SET model = (
        SELECT c2.model FROM calls c2
        WHERE c2.session_key = calls.session_key
          AND c2.model IS NOT NULL AND c2.model NOT IN ('', 'unknown')
        ORDER BY c2.id DESC LIMIT 1
      )
      WHERE (model = 'unknown' OR model = '' OR model IS NULL)
        AND session_key IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM calls c2
          WHERE c2.session_key = calls.session_key
            AND c2.model IS NOT NULL AND c2.model NOT IN ('', 'unknown')
        )`;
    const result = this._db.prepare(sql).run();
    return Number(result.changes) || 0;
  }

  clear() {
    this._assertWritable();
    const result = this._stmt('DELETE FROM calls').run();
    return Number(result.changes) || 0;
  }

  /**
   * 按保留天数清理旧记录。
   * @param {{retentionDays?: number}} [options]
   * @returns {number} 删除行数
   */
  prune(options = {}) {
    this._assertWritable();
    const { retentionDays = DEFAULT_RETENTION_DAYS } = options || {};
    const days = Number(retentionDays);
    if (!Number.isFinite(days) || days <= 0) {
      throw new RangeError(`UsageStore.prune: retentionDays 必须是正数，收到 ${String(retentionDays)}`);
    }
    const cutoff = Date.now() - Math.floor(days) * 24 * 60 * 60 * 1000;
    const result = this._stmt('DELETE FROM calls WHERE observed_at < ?').run(cutoff);
    return Number(result.changes) || 0;
  }

  /**
   * 关闭数据库连接（可重复调用）。
   */
  close() {
    if (this._closed) return;
    this._closed = true;
    this._statements.clear();
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }
}

module.exports = {
  UsageStore,
  // 显式导出常量便于扩展层复用（不属于冻结契约的必需项）。
  CROSS_CHANNEL_WINDOW_MS,
  BILLING_BACKFILL_WINDOW_MS,
  csvEscape,
};
