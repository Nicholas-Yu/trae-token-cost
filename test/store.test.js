'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { UsageStore } = require('../src/data/store');

const { DatabaseSync } = require('node:sqlite');

function sha16(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** 每个测试用独立的 os.tmpdir() 目录建库，避免互相影响。 */
function makeStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-store-'));
  const dbPath = path.join(dir, 'usage.db');
  const store = new UsageStore(dbPath);
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  return { store, dir, dbPath };
}

let seq = 0;
function baseEvent(overrides = {}) {
  seq += 1;
  return {
    inputTokens: 100 + seq,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    model: 'claude-sonnet-4',
    credits: null,
    sessionId: null,
    messageId: null,
    billingId: null,
    source: 'debugger',
    observedAt: Date.now(),
    endpoint: null,
    targetId: null,
    targetTitle: null,
    ...overrides,
  };
}

function localDay(epochMs) {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function makeReadOnlyStore(t) {
  const { store: writer, dbPath } = makeStore(t);
  writer.record(baseEvent({ model: 'readonly-model', observedAt: Date.now() - 1000 }));
  writer.close();
  const store = new UsageStore(dbPath, { readOnly: true });
  t.after(() => store.close());
  return { store, dbPath };
}

test('建库：schema/索引/meta/WAL，重复构造幂等', (t) => {
  const { store, dbPath } = makeStore(t);
  store.record(baseEvent({ observedAt: Date.now() - 1000 }), { hostLabel: '本机' });
  store.close();

  // 再次打开同一路径（幂等初始化，不丢数据）。
  const again = new UsageStore(dbPath);
  t.after(() => again.close());
  assert.strictEqual(again.recent().length, 1);

  // 用原始连接检查落库结构。
  const raw = new DatabaseSync(dbPath);
  t.after(() => raw.close());
  assert.strictEqual(raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');

  const columns = raw.prepare('PRAGMA table_info(calls)').all().map((row) => row.name);
  const expectedColumns = [
    'id', 'turn_key', 'observed_at', 'source', 'model', 'input_tokens', 'output_tokens',
    'total_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'usage_complete',
    'credits', 'credit_kind', 'host_label', 'workspace_name', 'window_title', 'session_key', 'message_key',
    'billing_key', 'endpoint', 'first_response_ms', 'duration_ms', 'timing_source', 'created_at',
  ];
  for (const column of expectedColumns) assert.ok(columns.includes(column), `缺少列 ${column}`);

  const indexes = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name);
  for (const index of ['calls_observed_at', 'calls_model', 'calls_turn_key', 'calls_host', 'calls_session_key']) {
    assert.ok(indexes.includes(index), `缺少索引 ${index}`);
  }

  const meta = raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  assert.strictEqual(meta.value, '4');
});

test('v1 数据库升级：补充新列、更新版本并保留记录', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-store-v1-'));
  const dbPath = path.join(dir, 'usage.db');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_key TEXT, observed_at INTEGER NOT NULL, source TEXT NOT NULL, model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0, credits REAL,
      credit_kind TEXT NOT NULL DEFAULT 'unknown', host_label TEXT, workspace_name TEXT,
      window_title TEXT, session_key TEXT, message_key TEXT, billing_key TEXT,
      endpoint TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '1');
    INSERT INTO calls (observed_at, source, model, input_tokens, output_tokens, total_tokens, created_at)
    VALUES (1000, 'debugger', 'legacy-model', 10, 5, 15, 1000);
  `);
  raw.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = new UsageStore(dbPath);
  t.after(() => store.close());
  const columns = store._db.prepare('PRAGMA table_info(calls)').all().map((row) => row.name);
  assert.ok(columns.includes('reasoning_tokens'));
  assert.ok(columns.includes('usage_complete'));
  assert.strictEqual(store._db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '4');
  assert.strictEqual(store.recent().length, 1);
  assert.strictEqual(store.recent()[0].model, 'legacy-model');
  assert.strictEqual(store.recent()[0].first_response_ms, null);
  assert.strictEqual(store.recent()[0].duration_ms, null);
  assert.strictEqual(store.recent()[0].timing_source, null);
});

test(':memory: 也可用', (t) => {
  const store = new UsageStore(':memory:');
  t.after(() => store.close());
  store.record(baseEvent());
  assert.strictEqual(store.summary().total.calls, 1);
});

test('只读模式：缺库直接报错且不创建目录或文件', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-store-readonly-missing-'));
  const dbPath = path.join(dir, 'missing', 'usage.db');
  let store;
  t.after(() => {
    if (store) store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.throws(() => {
    store = new UsageStore(dbPath, { readOnly: true });
  });
  assert.strictEqual(fs.existsSync(path.dirname(dbPath)), false);
  assert.strictEqual(fs.existsSync(dbPath), false);
});

test('只读模式：summary/recent/iterate/csv 查询及 close 正常', (t) => {
  const { store } = makeReadOnlyStore(t);
  assert.strictEqual(store._db.prepare('PRAGMA query_only').get().query_only, 1);
  assert.strictEqual(store._db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.strictEqual(store.summary().total.calls, 1);
  assert.strictEqual(store.recent()[0].model, 'readonly-model');
  assert.deepStrictEqual(Array.from(store.iterate()).map((row) => row.model), ['readonly-model']);
  assert.ok(store.csv().includes('readonly-model'));
  store.close();
  store.close();
  assert.throws(() => store.recent(), /已关闭/);
});

test('只读模式：record/backfillModels/clear/prune 明确拒绝写入', (t) => {
  const { store } = makeReadOnlyStore(t);
  const writeMethods = [
    () => store.record(baseEvent()),
    () => store.backfillModels(),
    () => store.clear(),
    () => store.prune(),
  ];
  for (const write of writeMethods) assert.throws(write, /只读/);
  assert.strictEqual(store.recent().length, 1);
});

test('只读模式：打开、查询、关闭前后数据库 SHA-256 不变', (t) => {
  const { store: writer, dbPath } = makeStore(t);
  writer.record(baseEvent({ model: 'readonly-model', observedAt: Date.now() - 1000 }));
  writer.close();
  const closedHash = sha256File(dbPath);

  const store = new UsageStore(dbPath, { readOnly: true });
  t.after(() => store.close());
  assert.strictEqual(sha256File(dbPath), closedHash);
  store.summary();
  store.recent();
  Array.from(store.iterate());
  store.csv();
  assert.strictEqual(sha256File(dbPath), closedHash);
  store.close();
  assert.strictEqual(sha256File(dbPath), closedHash);
});

test('record：缺省字段归一化 + 哈希 ID + 富化字段', (t) => {
  const { store } = makeStore(t);
  const observedAt = Date.now() - 5000;
  const row = store.record(
    baseEvent({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      model: '  ',
      source: undefined,
      sessionId: 'session-raw',
      messageId: 'message-raw',
      billingId: 'billing-raw',
      observedAt,
      targetTitle: 'proj [SSH: gpu-host] — Trae CN',
      endpoint: 'https://api.example.com/v1/chat',
    }),
    { hostLabel: 'gpu-host', workspaceName: 'proj' },
  );

  assert.strictEqual(row.input_tokens, 120);
  assert.strictEqual(row.output_tokens, 30);
  assert.strictEqual(row.total_tokens, 150);
  assert.strictEqual(row.cache_read_tokens, 0);
  assert.strictEqual(row.cache_write_tokens, 0);
  assert.strictEqual(row.model, 'unknown');
  assert.strictEqual(row.source, 'unknown');
  assert.strictEqual(row.credits, null);
  assert.strictEqual(row.credit_kind, 'unknown');
  assert.strictEqual(row.host_label, 'gpu-host');
  assert.strictEqual(row.workspace_name, null);
  assert.strictEqual(row.window_title, null);
  assert.strictEqual(row.usage_complete, 0, '缓存字段缺失必须保留为不完整');
  assert.strictEqual(row.reasoning_tokens, null);
  assert.strictEqual(row.session_key, sha16('session-raw'));
  assert.strictEqual(row.message_key, sha16('message-raw'));
  assert.strictEqual(row.billing_key, sha16('billing-raw'));
  assert.strictEqual(row.turn_key, sha16('session-raw|message-raw'));
  assert.strictEqual(row.endpoint, 'https://api.example.com/v1/chat');
  assert.strictEqual(row.observed_at, observedAt);
  assert.ok(Number.isFinite(row.created_at));
});

test('record：credits 只在有限数值时写入，estimated 走 creditKind', (t) => {
  const { store } = makeStore(t);

  const actual = store.record(baseEvent({ model: 'm1', credits: 1.25 }));
  assert.strictEqual(actual.credits, 1.25);
  assert.strictEqual(actual.credit_kind, 'actual');

  const estimated = store.record(baseEvent({ model: 'm2', credits: 0.5, creditKind: 'estimated' }));
  assert.strictEqual(estimated.credits, 0.5);
  assert.strictEqual(estimated.credit_kind, 'estimated');

  for (const badCredits of [null, undefined, NaN, Infinity, -Infinity, '2.5']) {
    const row = store.record(baseEvent({ model: `m-bad-${String(badCredits)}`, credits: badCredits }));
    assert.strictEqual(row.credits, null, `credits=${String(badCredits)} 不应写入`);
    assert.strictEqual(row.credit_kind, 'unknown');
  }
});

test('record：非法 token 抛错', (t) => {
  const { store } = makeStore(t);
  assert.throws(() => store.record(baseEvent({ inputTokens: -1 })), RangeError);
  assert.throws(() => store.record(baseEvent({ outputTokens: 'abc' })), TypeError);
  assert.throws(() => store.record(null), TypeError);
});

test('去重规则 1：turn_key 命中 → token 取 max、积分 actual 优先、source 合并去重、空字段 COALESCE', (t) => {
  const { store } = makeStore(t);
  const t0 = Date.now() - 60_000;

  const first = store.record(
    baseEvent({
      sessionId: 'sess-1',
      messageId: 'msg-1',
      inputTokens: 100,
      outputTokens: 50,
      model: 'claude-sonnet-4',
      source: 'debugger',
      observedAt: t0,
    }),
  );
  assert.strictEqual(first.turn_key, sha16('sess-1|msg-1'));

  const merged = store.record(
    baseEvent({
      sessionId: 'sess-1',
      messageId: 'msg-1',
      inputTokens: 120,
      outputTokens: 60,
      model: 'claude-sonnet-4',
      source: 'billing',
      credits: 3.5,
      observedAt: t0 + 1000,
      targetTitle: 'proj — Trae CN',
    }),
    { hostLabel: 'gpu-host', workspaceName: 'proj' },
  );

  assert.strictEqual(store.recent().length, 1, '同 turn_key 应合并为一行');
  assert.strictEqual(merged.input_tokens, 120);
  assert.strictEqual(merged.output_tokens, 60);
  assert.strictEqual(merged.total_tokens, 180);
  assert.strictEqual(merged.credits, 3.5);
  assert.strictEqual(merged.credit_kind, 'actual');
  assert.strictEqual(merged.source, 'debugger,billing');
  assert.strictEqual(merged.host_label, 'gpu-host');
  assert.strictEqual(merged.workspace_name, null);
  assert.strictEqual(merged.window_title, null);
  assert.strictEqual(merged.observed_at, t0, '合并保留较早的 observed_at');
});

test('去重规则 2：billing_key 命中 → 合并（不同 session/message 也能命中）', (t) => {
  const { store } = makeStore(t);
  const t0 = Date.now() - 120_000;

  store.record(
    baseEvent({
      sessionId: 'sess-a',
      messageId: 'msg-a',
      billingId: 'bill-1',
      source: 'billing',
      credits: 1.0,
      model: 'm-bill',
      inputTokens: 10,
      outputTokens: 5,
      observedAt: t0,
    }),
  );
  const merged = store.record(
    baseEvent({
      sessionId: 'sess-b',
      messageId: 'msg-b',
      billingId: 'bill-1',
      source: 'billing',
      credits: 2.0,
      model: 'm-bill',
      inputTokens: 10,
      outputTokens: 5,
      observedAt: t0 + 200,
    }),
  );

  assert.strictEqual(store.recent().length, 1);
  assert.strictEqual(merged.billing_key, sha16('bill-1'));
  assert.strictEqual(merged.credits, 2.0, 'actual 以最新一次为准');
  assert.strictEqual(merged.turn_key, sha16('sess-a|msg-a'), 'turn_key 保留已有值');
});

test('去重规则 3：billing 事件回填同 token 三件套且无实际积分的行（±15 分钟）', (t) => {
  const { store } = makeStore(t);
  const t0 = Date.now() - 30 * 60_000;

  const debuggerRow = store.record(
    baseEvent({
      model: 'm-backfill',
      inputTokens: 321,
      outputTokens: 111,
      source: 'debugger',
      observedAt: t0,
    }),
  );
  assert.strictEqual(debuggerRow.credits, null);

  const backfilled = store.record(
    baseEvent({
      model: 'm-backfill',
      inputTokens: 321,
      outputTokens: 111,
      source: 'billing',
      credits: 1.25,
      billingId: 'bill-backfill',
      observedAt: t0 + 60_000,
    }),
  );

  assert.strictEqual(store.recent().length, 1, '应回填而不是新增');
  assert.strictEqual(backfilled.credits, 1.25);
  assert.strictEqual(backfilled.credit_kind, 'actual');
  assert.strictEqual(backfilled.source, 'debugger,billing');
  assert.strictEqual(backfilled.billing_key, sha16('bill-backfill'));

  // 同一账单再次到达：规则 2 命中，仍是一行。
  store.record(
    baseEvent({
      model: 'm-backfill',
      inputTokens: 321,
      outputTokens: 111,
      source: 'billing',
      credits: 1.25,
      billingId: 'bill-backfill',
      observedAt: t0 + 120_000,
    }),
  );
  assert.strictEqual(store.recent().length, 1);
});

test('去重规则 3：超出 ±15 分钟不回填，新增一行', (t) => {
  const { store } = makeStore(t);
  const t0 = Date.now() - 60 * 60_000;
  store.record(
    baseEvent({ model: 'm-out-of-window', inputTokens: 11, outputTokens: 7, source: 'debugger', observedAt: t0 }),
  );
  store.record(
    baseEvent({
      model: 'm-out-of-window',
      inputTokens: 11,
      outputTokens: 7,
      source: 'billing',
      credits: 0.7,
      billingId: 'bill-late',
      observedAt: t0 + 16 * 60_000,
    }),
  );
  assert.strictEqual(store.recent().length, 2);
});

test('去重规则 4：同 model + 同 token 三件套 + 10 秒内跨通道合并', (t) => {
  const { store } = makeStore(t);
  const t0 = Date.now() - 5 * 60_000;

  store.record(
    baseEvent({ model: 'm-cross', inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, source: 'debugger', observedAt: t0, targetTitle: 'x — Trae CN' }),
  );
  const merged = store.record(
    baseEvent({
      model: 'm-cross',
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 2,
      source: 'network',
      observedAt: t0 + 5000,
      targetTitle: 'x — Trae CN',
    }),
    { hostLabel: 'gpu-host' },
  );

  assert.strictEqual(store.recent().length, 1);
  assert.strictEqual(merged.source, 'debugger,network');
  assert.strictEqual(merged.cache_read_tokens, 2, 'token 取 max');
  assert.strictEqual(merged.host_label, 'gpu-host');

  // 超出 10 秒 → 新增一行。
  store.record(
    baseEvent({ model: 'm-cross', inputTokens: 7, outputTokens: 3, source: 'debugger', observedAt: t0 + 11_000 }),
  );
  assert.strictEqual(store.recent().length, 2);

  // 与新行 10 秒内的重复继续合并。
  store.record(
    baseEvent({ model: 'm-cross', inputTokens: 7, outputTokens: 3, source: 'network', observedAt: t0 + 15_000 }),
  );
  assert.strictEqual(store.recent().length, 2);
});

test('积分合并：estimated 可被 actual 覆盖，actual 不会被 estimated 覆盖', (t) => {
  const { store } = makeStore(t);

  const estimatedRow = store.record(
    baseEvent({ sessionId: 's-est', messageId: 'm-est', credits: 0.4, creditKind: 'estimated', model: 'm-est' }),
  );
  assert.strictEqual(estimatedRow.credit_kind, 'estimated');

  const actualRow = store.record(
    baseEvent({ sessionId: 's-est', messageId: 'm-est', credits: 1.5, model: 'm-est' }),
  );
  assert.strictEqual(actualRow.credit_kind, 'actual');
  assert.strictEqual(actualRow.credits, 1.5);

  const estimatedAgain = store.record(
    baseEvent({ sessionId: 's-est', messageId: 'm-est', credits: 0.9, creditKind: 'estimated', model: 'm-est' }),
  );
  assert.strictEqual(estimatedAgain.credit_kind, 'actual', 'actual 优先');
  assert.strictEqual(estimatedAgain.credits, 1.5);
});

test('合并：完整事件可补齐不完整事件，reasoning 取已知较大值', (t) => {
  const { store } = makeStore(t);
  const t0 = Date.now();
  store.record(baseEvent({
    sessionId: 'complete-session', messageId: 'complete-message',
    cacheReadTokens: undefined, reasoningTokens: 10, usageComplete: false, observedAt: t0,
  }));
  const merged = store.record(baseEvent({
    sessionId: 'complete-session', messageId: 'complete-message',
    cacheReadTokens: 10, reasoningTokens: 20, usageComplete: true, observedAt: t0 + 100,
  }));
  assert.strictEqual(store.recent().length, 1);
  assert.strictEqual(merged.usage_complete, 1);
  assert.strictEqual(merged.reasoning_tokens, 20);
});

test('summary：total/models/hosts/days（升序）/recent', (t) => {
  const { store } = makeStore(t);
  const now = Date.now();
  const day0 = now - 2 * 24 * 60 * 60 * 1000;
  const day1 = now - 1 * 24 * 60 * 60 * 1000;

  store.record(
    baseEvent({
      model: 'model-a', inputTokens: 100, outputTokens: 50, cacheReadTokens: 10,
      reasoningTokens: 10, credits: 1.5, source: 'billing', observedAt: day0,
    }),
    { hostLabel: '本机' },
  );
  store.record(
    baseEvent({
      model: 'model-b', inputTokens: 300, outputTokens: 100, cacheReadTokens: 90,
      reasoningTokens: 20, credits: 0.5, creditKind: 'estimated', observedAt: day1,
    }),
    { hostLabel: 'gpu-host' },
  );
  store.record(
    baseEvent({
      model: 'model-a', inputTokens: 200, outputTokens: 80, cacheReadTokens: 100,
      reasoningTokens: 30, credits: null, observedAt: now,
    }),
    { hostLabel: 'gpu-host' },
  );

  const summary = store.summary();
  assert.strictEqual(summary.total.calls, 3);
  assert.strictEqual(summary.total.total_tokens, 150 + 400 + 280);
  assert.strictEqual(summary.total.input_tokens, 600);
  assert.strictEqual(summary.total.output_tokens, 230);
  assert.strictEqual(summary.total.cache_read_tokens, 200);
  assert.strictEqual(summary.total.cache_write_tokens, 15);
  assert.strictEqual(summary.total.reasoning_tokens, 60);
  assert.strictEqual(summary.total.incomplete_calls, 0);
  assert.strictEqual(summary.total.actual_credits, 1.5);
  assert.strictEqual(summary.total.estimated_credits, 0.5);
  assert.strictEqual(summary.total.cache_hit_rate, Math.round((200 / 600) * 10000) / 10000);

  // models 按 total_tokens 降序（model-a: 150 + 280 = 430 > model-b: 400）
  assert.deepStrictEqual(summary.models.map((m) => m.model), ['model-a', 'model-b']);
  assert.strictEqual(summary.models[0].calls, 2);
  assert.strictEqual(summary.models[0].total_tokens, 150 + 280);
  assert.strictEqual(summary.models[0].cached_tokens, 110);
  assert.strictEqual(summary.models[0].actual_credits, 1.5);
  assert.strictEqual(summary.models[1].calls, 1);
  assert.strictEqual(summary.models[1].cached_tokens, 90);
  assert.strictEqual(summary.models[1].actual_credits, 0);
  assert.strictEqual(summary.models[1].estimated_credits, 0.5);

  // hosts
  assert.strictEqual(summary.hosts.length, 2);
  const hostMap = new Map(summary.hosts.map((h) => [h.host_label, h]));
  assert.strictEqual(hostMap.get('本机').total_tokens, 150);
  assert.strictEqual(hostMap.get('gpu-host').total_tokens, 400 + 280);
  assert.strictEqual(hostMap.get('gpu-host').input_tokens, 500);
  assert.strictEqual(hostMap.get('gpu-host').output_tokens, 180);
  assert.strictEqual(hostMap.get('gpu-host').cached_tokens, 190);
  assert.strictEqual(hostMap.get('gpu-host').estimated_credits, 0.5);

  // days 升序
  assert.deepStrictEqual(summary.days.map((d) => d.day), [localDay(day0), localDay(day1), localDay(now)]);
  assert.strictEqual(summary.days[0].calls, 1);
  assert.strictEqual(summary.days[1].total_tokens, 400);
  assert.strictEqual(summary.days[1].cached_tokens, 90);
  assert.strictEqual(summary.days[0].actual_credits, 1.5);

  // recent 按时间倒序
  assert.strictEqual(summary.recent.length, 3);
  assert.deepStrictEqual(summary.recent.map((r) => r.observed_at), [now, day1, day0]);
});

test('summary：cache_hit_rate 定义（cache_read/input，4 位小数，input=0 为 null）', (t) => {
  const { store } = makeStore(t);
  const now = Date.now();

  store.record(baseEvent({ model: 'only-cache', inputTokens: 0, outputTokens: 0, cacheReadTokens: 75, observedAt: now }));
  assert.strictEqual(store.summary().total.cache_hit_rate, null);

  store.record(baseEvent({ model: 'with-input', inputTokens: 300, outputTokens: 0, cacheReadTokens: 100, observedAt: now - 20_000 }));
  assert.strictEqual(store.summary().total.cache_hit_rate, Math.round((175 / 300) * 10000) / 10000);
});

test('summary：sinceMs 过滤', (t) => {
  const { store } = makeStore(t);
  const now = Date.now();
  store.record(baseEvent({ model: 'old', observedAt: now - 3 * 24 * 60 * 60 * 1000 }));
  store.record(baseEvent({ model: 'new', observedAt: now - 1000 }));

  const summary = store.summary({ sinceMs: now - 2 * 24 * 60 * 60 * 1000 });
  assert.strictEqual(summary.total.calls, 1);
  assert.deepStrictEqual(summary.models.map((m) => m.model), ['new']);
  assert.deepStrictEqual(summary.hosts.map((h) => h.host_label), ['本机']);
  assert.strictEqual(summary.recent.length, 1);
});

test('iterate：按时间升序逐行读取并支持 sinceMs', (t) => {
  const { store } = makeStore(t);
  const now = Date.now();
  store.record(baseEvent({ model: 'new', observedAt: now }));
  store.record(baseEvent({ model: 'old', observedAt: now - 60_000 }));
  assert.deepStrictEqual(Array.from(store.iterate()).map((row) => row.model), ['old', 'new']);
  assert.deepStrictEqual(Array.from(store.iterate({ sinceMs: now - 1000 })).map((row) => row.model), ['new']);
});

test('recent：limit / sinceMs / hostLabel 过滤', (t) => {
  const { store } = makeStore(t);
  const now = Date.now();
  store.record(baseEvent({ model: 'r1', observedAt: now - 30_000 }), { hostLabel: '本机' });
  store.record(baseEvent({ model: 'r2', observedAt: now - 20_000 }), { hostLabel: 'gpu-host' });
  store.record(baseEvent({ model: 'r3', observedAt: now - 10_000 }), { hostLabel: 'gpu-host' });

  assert.strictEqual(store.recent().length, 3);
  assert.deepStrictEqual(store.recent({ limit: 2 }).map((r) => r.model), ['r3', 'r2']);
  assert.deepStrictEqual(store.recent({ sinceMs: now - 25_000 }).map((r) => r.model), ['r3', 'r2']);
  assert.deepStrictEqual(store.recent({ hostLabel: 'gpu-host' }).map((r) => r.model), ['r3', 'r2']);
  assert.deepStrictEqual(store.recent({ hostLabel: '本机' }).map((r) => r.model), ['r1']);
  assert.strictEqual(store.recent({ limit: 0 }).length, 3, '非法 limit 回退默认值');
});

test('csv：UTF-8 BOM + CRLF + RFC 4180 转义 + sinceMs', (t) => {
  const { store } = makeStore(t);
  const now = Date.now();
  store.record(
    baseEvent({
      model: 'model,A',
      inputTokens: 10,
      outputTokens: 5,
      credits: 1.25,
      observedAt: now - 60_000,
      targetTitle: 'my "quoted", title\nline2',
    }),
    { hostLabel: 'gpu-host', workspaceName: 'proj' },
  );
  store.record(baseEvent({ model: 'plain-model', observedAt: now }));

  const csv = store.csv();
  assert.ok(csv.startsWith('\uFEFF'), '需要 UTF-8 BOM');
  assert.ok(csv.includes('\r\n'), '需要 CRLF 换行');
  assert.ok(csv.endsWith('\r\n'), '每行以 CRLF 结尾');

  const lines = csv.slice(1).split('\r\n').filter((line) => line.length > 0);
  assert.strictEqual(lines.length, 3, '表头 + 2 行数据');
  assert.strictEqual(lines[0], 'observed_at,model,source,input_tokens,output_tokens,total_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,usage_complete');
  assert.ok(lines[1].includes('"model,A"'), '含逗号的 model 应被双引号包裹');
  assert.ok(!csv.includes('my "quoted", title'), '原始窗口标题不得导出');
  assert.ok(!csv.includes('gpu-host'), '主机不得导出');
  assert.ok(!csv.includes('proj'), '工作区不得导出');
  assert.ok(!csv.includes('credit_kind'), '积分字段不属于本导出');
  assert.ok(csv.includes('plain-model'));

  // sinceMs 过滤
  const filtered = store.csv({ sinceMs: now - 1000 });
  const filteredLines = filtered.slice(1).split('\r\n').filter((line) => line.length > 0);
  assert.strictEqual(filteredLines.length, 2);
  assert.ok(filtered.includes('plain-model'));
  assert.ok(!filtered.includes('model,A'));

  // 空库：BOM + 表头
  const { store: emptyStore } = makeStore(t);
  const emptyCsv = emptyStore.csv();
  assert.strictEqual(emptyCsv, '\uFEFFobserved_at,model,source,input_tokens,output_tokens,total_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,usage_complete');
});

test('耗时补充合并且保留首个已知值，不增加调用', (t) => {
  const { store } = makeStore(t);
  const event = baseEvent({
    model: 'timed-model',
    sessionId: 'timed-session',
    messageId: 'timed-message',
    observedAt: Date.now(),
  });
  store.record(event);
  store.record({ ...event, firstResponseMs: 120, durationMs: 2500, timingSource: 'network-inferred' });
  store.record({ ...event, firstResponseMs: 999, durationMs: 9999, timingSource: 'other-source' });

  const rows = store.recent();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].first_response_ms, 120);
  assert.strictEqual(rows[0].duration_ms, 2500);
  assert.strictEqual(rows[0].timing_source, 'network-inferred');
  const total = store.summary().total;
  assert.strictEqual(total.timed_calls, 1);
  assert.strictEqual(total.first_response_timed_calls, 1);
  assert.strictEqual(total.duration_ms_sum, 2500);
  assert.strictEqual(total.first_response_ms_sum, 120);
  assert.strictEqual(total.timed_output_tokens, 50);
});

test('debugger-inferred 服务端耗时落库并参与聚合', (t) => {
  const { store } = makeStore(t);
  const event = baseEvent({
    model: 'agent-model',
    sessionId: 'agent-session',
    messageId: 'agent-message',
    observedAt: Date.now(),
  });
  store.record({ ...event, firstResponseMs: 2005, durationMs: 3257, timingSource: 'debugger-inferred' });
  const rows = store.recent();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].first_response_ms, 2005);
  assert.strictEqual(rows[0].duration_ms, 3257);
  assert.strictEqual(rows[0].timing_source, 'debugger-inferred');
  const total = store.summary().total;
  assert.strictEqual(total.timed_calls, 1);
  assert.strictEqual(total.duration_ms_sum, 3257);
  assert.strictEqual(total.first_response_ms_sum, 2005);
});

test('dayModels 按日期和模型聚合全部 Token，不受 recent 限制', (t) => {
  const { store } = makeStore(t);
  const firstDay = Date.UTC(2026, 0, 15, 12);
  const secondDay = Date.UTC(2026, 0, 16, 12);
  for (let index = 0; index < 205; index += 1) {
    store.record(baseEvent({
      model: index % 2 === 0 ? 'model-a' : 'model-b',
      sessionId: `session-${index}`,
      messageId: `message-${index}`,
      observedAt: index % 3 === 0 ? secondDay : firstDay,
      inputTokens: 100 + index,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      reasoningTokens: 2,
    }));
  }

  const summary = store.summary();
  assert.strictEqual(summary.dayModels.length, 4);
  const groupedTotal = summary.dayModels.reduce((sum, row) => sum + row.total_tokens, 0);
  assert.strictEqual(groupedTotal, summary.total.total_tokens);
  const modelA = summary.dayModels.find((row) => row.day === localDay(firstDay) && row.model === 'model-a');
  assert.ok(modelA);
  assert.strictEqual(modelA.cache_read_tokens, modelA.calls * 10);
  assert.strictEqual(modelA.cache_write_tokens, modelA.calls * 5);
  assert.strictEqual(modelA.reasoning_tokens, modelA.calls * 2);
});

test('clear / prune 返回删除条数', (t) => {
  const { store } = makeStore(t);
  const now = Date.now();
  store.record(baseEvent({ model: 'old', observedAt: now - 400 * 24 * 60 * 60 * 1000 }));
  store.record(baseEvent({ model: 'fresh', observedAt: now }));

  assert.strictEqual(store.prune({ retentionDays: 180 }), 1);
  assert.strictEqual(store.recent().length, 1);
  assert.strictEqual(store.recent()[0].model, 'fresh');

  assert.strictEqual(store.clear(), 1);
  assert.strictEqual(store.recent().length, 0);
  assert.strictEqual(store.summary().total.calls, 0);
  assert.throws(() => store.prune({ retentionDays: 0 }), RangeError);
});

test('close：关闭后操作抛清晰错误，可重复关闭', (t) => {
  const { store } = makeStore(t);
  store.record(baseEvent());
  store.close();
  store.close();
  assert.throws(() => store.recent(), /已关闭/);
  assert.throws(() => store.summary(), /已关闭/);
  assert.throws(() => store.csv(), /已关闭/);
  assert.throws(() => store.record(baseEvent()), /已关闭/);
});

test('activityDays：固定 56 天补零、本地日历、与 days 同口径', (t) => {
  const { store } = makeStore(t);
  const { startOfDaysAgo } = require('../src/util');
  const now = Date.now();
  store.record(baseEvent({ observedAt: now, inputTokens: 100, outputTokens: 20 }));
  store.record(baseEvent({ observedAt: now - 10 * 86400000, inputTokens: 200, outputTokens: 30 }));
  store.record(baseEvent({ observedAt: now - 60 * 86400000, inputTokens: 999, outputTokens: 999 }));

  const heat = store.activityDays();
  assert.strictEqual(heat.days.length, 56);
  assert.strictEqual(heat.days[0].day, localDay(startOfDaysAgo(55)));
  assert.strictEqual(heat.days[55].day, localDay(now));
  const empty = heat.days.find((d) => d.day === localDay(now - 5 * 86400000));
  assert.strictEqual(empty.total_tokens, 0);
  assert.strictEqual(empty.calls, 0);
  const today = heat.days[55];
  assert.strictEqual(today.calls, 1);
  const summed = heat.days.reduce((s, d) => s + d.total_tokens, 0);
  const days = store.summary({ sinceMs: startOfDaysAgo(55) }).days;
  assert.strictEqual(summed, days.reduce((s, d) => s + d.total_tokens, 0));
});

test('schema v4：只读旧库无 session 索引仍正确', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-store-v3ro-'));
  const dbPath = path.join(dir, 'usage.db');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_key TEXT, observed_at INTEGER NOT NULL, source TEXT NOT NULL, model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER,
      usage_complete INTEGER NOT NULL DEFAULT 0, credits REAL,
      credit_kind TEXT NOT NULL DEFAULT 'unknown', host_label TEXT, workspace_name TEXT,
      window_title TEXT, session_key TEXT, message_key TEXT, billing_key TEXT,
      endpoint TEXT, first_response_ms INTEGER, duration_ms INTEGER, timing_source TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '3');
    INSERT INTO calls (observed_at, source, model, input_tokens, output_tokens, total_tokens, session_key, message_key, created_at)
    VALUES (${Date.now()}, 'debugger', 'm', 10, 5, 15, 's1', 'm1', ${Date.now()});
  `);
  raw.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new UsageStore(dbPath, { readOnly: true });
  t.after(() => store.close());
  assert.strictEqual(store.activityDays().days.length, 56);
});
