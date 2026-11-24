'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { runStandaloneCli } = require('../src/standalone/cli');

function baseConfig() {
  return {
    dbPath: '/tmp/standalone-cli/usage.db',
    sharedDir: '/tmp/standalone-cli/shared',
    settingsPath: '/tmp/standalone-cli/settings.json',
    port: 0,
    noOpen: true,
    capture: false,
    cdpPort: 9333,
    pollIntervalMs: 3000,
    retentionDays: 180
  };
}

function dependencies(overrides = {}) {
  return {
    resolveConfig: () => baseConfig(),
    openUrl: () => {},
    signalTarget: new EventEmitter(),
    exit: () => {},
    log: () => {},
    createProcessLock: () => ({ acquire: () => {}, close: () => {} }),
    ...overrides
  };
}

function fakeRuntime(order) {
  return {
    async start() { order.push('runtime-start'); },
    close() { order.push('runtime-close'); }
  };
}

test('普通 CLI 不启动采集 runtime', async () => {
  let captureCalls = 0;
  const app = await runStandaloneCli([], dependencies({
    createCaptureRuntime() {
      captureCalls += 1;
      return fakeRuntime([]);
    },
    async startServer(config) {
      assert.equal(config.capture, false);
      return { url: 'http://127.0.0.1:1234', close: async () => {} };
    }
  }));
  assert.equal(captureCalls, 0);
  assert.equal(app.url, 'http://127.0.0.1:1234');
});

test('capture 先启动采集再启动 HTTP，信号关闭幂等', async () => {
  const order = [];
  const signalTarget = new EventEmitter();
  const runtime = fakeRuntime(order);
  await runStandaloneCli(['--capture'], dependencies({
    createProcessLock() {
      return { acquire: () => order.push('lock-acquire'), close: () => order.push('lock-close') };
    },
    resolveConfig(argv) {
      assert.deepEqual(argv, ['--capture']);
      return { ...baseConfig(), capture: true };
    },
    createCaptureRuntime(config) {
      assert.equal(config.cdpPort, 9333);
      assert.equal(config.sharedDir, '/tmp/standalone-cli/shared');
      return runtime;
    },
    async startServer() {
      order.push('server-start');
      return { url: 'http://127.0.0.1:1234', close: async () => order.push('server-close') };
    },
    signalTarget,
    exit(code) { order.push(`exit-${code}`); }
  }));

  assert.deepEqual(order, ['lock-acquire', 'runtime-start', 'server-start']);
  signalTarget.emit('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  signalTarget.emit('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['lock-acquire', 'runtime-start', 'server-start', 'runtime-close', 'server-close', 'lock-close', 'exit-0']);
});

test('已有常驻进程时拒绝启动，不创建采集器或 HTTP', async () => {
  let runtimeCalls = 0;
  let serverCalls = 0;
  await assert.rejects(runStandaloneCli(['--capture'], dependencies({
    resolveConfig: () => ({ ...baseConfig(), capture: true }),
    createProcessLock() {
      return { acquire() { throw new Error('独立采集服务已运行'); }, close() {} };
    },
    createCaptureRuntime() { runtimeCalls += 1; },
    async startServer() { serverCalls += 1; }
  })), /已运行/);
  assert.equal(runtimeCalls, 0);
  assert.equal(serverCalls, 0);
});

test('HTTP 启动失败时回收已启动的采集 runtime', async () => {
  const order = [];
  await assert.rejects(runStandaloneCli(['--capture'], dependencies({
    resolveConfig: () => ({ ...baseConfig(), capture: true }),
    createProcessLock() {
      return { acquire: () => order.push('lock-acquire'), close: () => order.push('lock-close') };
    },
    createCaptureRuntime: () => fakeRuntime(order),
    async startServer() { throw new Error('端口占用'); }
  })), /端口占用/);
  assert.deepEqual(order, ['lock-acquire', 'runtime-start', 'runtime-close', 'lock-close']);
});
