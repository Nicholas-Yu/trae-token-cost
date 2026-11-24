'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { UsageStore } = require('../src/data/store');

class FakeCollector extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.started = false;
    this.stopped = false;
  }

  start() {
    this.started = true;
  }

  stop() {
    this.stopped = true;
  }
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-capture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    dbPath: path.join(dir, 'usage.db'),
    sharedDir: path.join(dir, 'shared')
  };
}

function usageEvent(overrides = {}) {
  return {
    observedAt: Date.now(),
    model: 'kimi-k3.1-pro',
    source: 'debugger',
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    usageComplete: true,
    sessionId: 'session-1',
    messageId: 'message-1',
    targetTitle: 'demo [SSH: gpu-host] — Trae CN',
    ...overrides
  };
}

function createRuntime(options) {
  const { StandaloneCaptureRuntime } = require('../src/standalone/capture-runtime');
  const collectors = [];
  const runtime = new StandaloneCaptureRuntime({
    ...options,
    collectorFactory(collectorOptions) {
      const collector = new FakeCollector(collectorOptions);
      collectors.push(collector);
      return collector;
    }
  });
  return { runtime, collectors };
}

test('runtime 将独立 WebSocket 实现注入采集器', async (t) => {
  const paths = fixture(t);
  const webSocketImpl = class {};
  const { runtime, collectors } = createRuntime({ ...paths, webSocketImpl, timingEnabled: false });
  t.after(() => runtime.close());
  await runtime.start();
  assert.equal(collectors[0].options.webSocketImpl, webSocketImpl);
  assert.equal(collectors[0].options.timingEnabled, false);
});

test('leader 只开启 Debugger 采集并写入脱敏用量和状态', async (t) => {
  const paths = fixture(t);
  const { runtime, collectors } = createRuntime({ ...paths, cdpPort: 9333, retentionDays: 180 });
  t.after(() => runtime.close());
  await runtime.start();

  assert.equal(runtime.election.role, 'leader');
  assert.equal(collectors.length, 1);
  assert.equal(collectors[0].started, true);
  assert.equal(collectors[0].options.port, 9333);
  assert.equal(collectors[0].options.debuggerEnabled, true);
  assert.equal(collectors[0].options.networkEnabled, false);

  collectors[0].emit('status', {
    connected: true,
    targetCount: 2,
    collectorCount: 1,
    breakpointCount: 4,
    lastCaptureAt: null,
    lastError: null
  });
  const status = JSON.parse(fs.readFileSync(path.join(paths.sharedDir, 'status.json'), 'utf8'));
  assert.equal(status.cdpConnected, true);
  assert.equal(status.targetCount, 2);
  assert.equal(status.breakpointCount, 4);

  collectors[0].emit('usage', usageEvent());
  collectors[0].emit('usage', usageEvent({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }));
  const rows = runtime.store.recent();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total_tokens, 120);
  assert.equal(rows[0].host_label, 'gpu-host');
  assert.equal(rows[0].workspace_name, null);
  assert.equal(rows[0].window_title, null);
  assert.ok(status.lastCaptureAt === null);
});

test('follower 不采集，leader 关闭后自动接管且只写一份', async (t) => {
  const paths = fixture(t);
  const first = createRuntime({ ...paths, cdpPort: 9333 });
  const second = createRuntime({ ...paths, cdpPort: 9333 });
  t.after(() => { first.runtime.close(); second.runtime.close(); });
  await first.runtime.start();
  await second.runtime.start();

  assert.equal(first.runtime.election.role, 'leader');
  assert.equal(second.runtime.election.role, 'follower');
  assert.equal(first.collectors.length, 1);
  assert.equal(second.collectors.length, 0);

  first.runtime.close();
  assert.equal(await waitFor(() => second.runtime.election.role === 'leader' && second.collectors.length === 1), true);
  second.collectors[0].emit('usage', usageEvent());

  const store = new UsageStore(paths.dbPath, { readOnly: true });
  t.after(() => store.close());
  assert.equal(store.summary({}).total.calls, 1);
  assert.equal(second.collectors[0].options.networkEnabled, false);
});

test('close 幂等并屏蔽迟到用量', async (t) => {
  const paths = fixture(t);
  const { runtime, collectors } = createRuntime(paths);
  await runtime.start();
  runtime.close();
  runtime.close();

  collectors[0].emit('usage', usageEvent());
  const store = new UsageStore(paths.dbPath, { readOnly: true });
  t.after(() => store.close());
  assert.equal(store.summary({}).total.calls, 0);
  assert.equal(collectors[0].stopped, true);
});

test('启动为 leader 时按保留期清理历史记录', async (t) => {
  const paths = fixture(t);
  const store = new UsageStore(paths.dbPath);
  store.record(usageEvent({ observedAt: Date.now() - 181 * 24 * 60 * 60 * 1000 }));
  store.close();

  const { runtime } = createRuntime({ ...paths, retentionDays: 180 });
  t.after(() => runtime.close());
  await runtime.start();
  assert.equal(runtime.store.summary({}).total.calls, 0);
});

test('采集落库后只读 API 可见，CDP 断开不影响 HTTP', async (t) => {
  const paths = fixture(t);
  const settingsPath = path.join(paths.dir, 'settings.json');
  fs.writeFileSync(settingsPath, '{}');
  const { runtime, collectors } = createRuntime(paths);
  await runtime.start();
  const { startStandaloneServer } = require('../src/standalone/server');
  const app = await startStandaloneServer({ dbPath: paths.dbPath, settingsPath, port: 0 });
  t.after(async () => { await app.close(); runtime.close(); });

  collectors[0].emit('usage', usageEvent());
  const response = await fetch(`${app.url}/api/dashboard?range=all`);
  const data = await response.json();
  assert.equal(data.summary.total.calls, 1);
  assert.equal(data.recent[0].total_tokens, 120);

  collectors[0].emit('status', { connected: false, targetCount: 0, collectorCount: 0, breakpointCount: 0 });
  const afterDisconnect = await fetch(`${app.url}/api/dashboard?range=all`);
  assert.equal(afterDisconnect.status, 200);
  assert.equal((await afterDisconnect.json()).summary.total.calls, 1);
});
