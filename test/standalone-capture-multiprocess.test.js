'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { UsageStore } = require('../src/data/store');

const CHILD_SCRIPT = String.raw`
const { EventEmitter } = require('node:events');
const { StandaloneCaptureRuntime } = require(process.argv[1]);
const dbPath = process.argv[2];
const sharedDir = process.argv[3];
let collector = null;
const runtime = new StandaloneCaptureRuntime({
  dbPath,
  sharedDir,
  collectorFactory() {
    collector = new EventEmitter();
    collector.start = () => {};
    collector.stop = () => {};
    return collector;
  },
  logger: () => {}
});
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}
async function handle(message) {
  if (message.command === 'role') return send({ id: message.id, role: runtime.election.role });
  if (message.command === 'directUsage') {
    runtime.handleUsage(message.event);
    return send({ id: message.id, done: true });
  }
  if (message.command === 'collectorUsage') {
    collector?.emit('usage', message.event);
    return send({ id: message.id, done: true });
  }
  if (message.command === 'close') {
    runtime.close();
    send({ id: message.id, done: true });
    setImmediate(() => process.exit(0));
  }
}
let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  const lines = buffered.split('\n');
  buffered = lines.pop();
  for (const line of lines) if (line) handle(JSON.parse(line));
});
runtime.start().then(() => send({ ready: true, pid: process.pid, role: runtime.election.role }));
`;

function eventFixture(overrides = {}) {
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
    sessionId: 'shared-session',
    messageId: 'shared-message',
    targetTitle: 'Agent',
    ...overrides
  };
}

async function startChild(dbPath, sharedDir) {
  const runtimePath = path.resolve(__dirname, '../src/standalone/capture-runtime.js');
  const processHandle = spawn(process.execPath, ['-e', CHILD_SCRIPT, runtimePath, dbPath, sharedDir], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buffered = '';
  let errorOutput = '';
  let nextId = 0;
  const pending = new Map();
  processHandle.stderr.on('data', (chunk) => { errorOutput += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('子进程启动超时')), 5000);
    processHandle.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`子进程提前退出：${code}\n${errorOutput}`));
    });
    processHandle.stdout.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.ready) {
          clearTimeout(timeout);
          resolve(message);
        }
        if (message.id && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      }
    });
  });
  await ready;
  return {
    processHandle,
    send(message) {
      return new Promise((resolve) => {
        nextId += 1;
        pending.set(nextId, resolve);
        processHandle.stdin.write(JSON.stringify({ ...message, id: nextId }) + '\n');
      });
    },
    async close() {
      if (processHandle.exitCode !== null) return;
      await this.send({ command: 'close' });
      await once(processHandle, 'exit');
    }
  };
}

test('独立进程共享选主、自动接管并合并相同事件', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-multiprocess-'));
  const dbPath = path.join(dir, 'usage.db');
  const sharedDir = path.join(dir, 'shared');
  const first = await startChild(dbPath, sharedDir);
  const second = await startChild(dbPath, sharedDir);
  t.after(async () => {
    await Promise.all([first.close(), second.close()]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const roles = [await first.send({ command: 'role' }), await second.send({ command: 'role' })].map((item) => item.role);
  assert.deepEqual(roles.sort(), ['follower', 'leader']);

  const duplicate = eventFixture();
  await Promise.all([
    first.send({ command: 'directUsage', event: duplicate }),
    second.send({ command: 'directUsage', event: duplicate })
  ]);

  await first.close();
  let secondRole = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    secondRole = (await second.send({ command: 'role' })).role;
    if (secondRole === 'leader') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(secondRole, 'leader');
  await second.send({
    command: 'collectorUsage',
    event: eventFixture({ sessionId: 'after-takeover', messageId: 'after-takeover', inputTokens: 200, outputTokens: 40, totalTokens: 240 })
  });
  await second.close();

  const store = new UsageStore(dbPath, { readOnly: true });
  t.after(() => store.close());
  const rows = store.recent();
  assert.equal(rows.length, 2, '重复事件合并一条，接管后的新事件新增一条');
  assert.equal(store.summary({}).total.calls, 2);
  assert.equal(store._db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
