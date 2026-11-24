'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LeaderElection } = require('../src/data/leader');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitFor(check, timeoutMs = 3000, intervalMs = 15) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return true;
    await sleep(intervalMs);
  }
  return false;
}

function makeDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-leader-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  return dir;
}

const FAST = { heartbeatMs: 80, staleMs: 400, followerCheckMs: 40 };

function makeElection(t, dir, options = {}) {
  const election = new LeaderElection({ dir, ...FAST, ...options });
  t.after(() => {
    try { election.stop(); } catch { /* ignore */ }
  });
  return election;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('start 后成为 leader，写 leader.json 与 status.json 并持续心跳', async (t) => {
  const dir = makeDir(t);
  const leaderPath = path.join(dir, 'leader.json');
  const statusPath = path.join(dir, 'status.json');

  const election = makeElection(t, dir);
  assert.strictEqual(election.role, 'starting');

  const status = await election.start();
  assert.strictEqual(election.role, 'leader');
  assert.strictEqual(status.role, 'leader');

  const leaderRecord = readJson(leaderPath);
  assert.strictEqual(leaderRecord.pid, process.pid);
  assert.ok(typeof leaderRecord.nonce === 'string' && leaderRecord.nonce.length >= 16);
  assert.ok(Number.isFinite(leaderRecord.startedAt));
  assert.ok(Number.isFinite(leaderRecord.heartbeatAt));
  assert.ok('version' in leaderRecord);

  const firstHeartbeat = leaderRecord.heartbeatAt;
  assert.ok(
    await waitFor(() => readJson(leaderPath).heartbeatAt > firstHeartbeat, 2000),
    'leader.json 心跳应持续刷新',
  );

  const statusRecord = readJson(statusPath);
  const expectedKeys = [
    'role', 'pid', 'startedAt', 'heartbeatAt', 'cdpConnected', 'targetCount',
    'collectorCount', 'breakpointCount', 'lastCaptureAt', 'lastError', 'appVersion', 'platform',
  ];
  for (const key of expectedKeys) assert.ok(key in statusRecord, `status.json 缺少字段 ${key}`);
  assert.strictEqual(statusRecord.role, 'leader');
});

test('updateStatus：leader 合并写 status.json 并 emit status', async (t) => {
  const dir = makeDir(t);
  const election = makeElection(t, dir);
  await election.start();

  const statusEvents = [];
  election.on('status', (status) => statusEvents.push(status));

  const returned = election.updateStatus({
    cdpConnected: true,
    targetCount: 3,
    collectorCount: 2,
    lastError: 'boom',
  });

  assert.strictEqual(returned.cdpConnected, true);
  assert.strictEqual(returned.role, 'leader');
  assert.ok(Number.isFinite(returned.heartbeatAt));
  assert.ok(statusEvents.length >= 1);
  assert.strictEqual(statusEvents[statusEvents.length - 1].targetCount, 3);

  const statusRecord = readJson(path.join(dir, 'status.json'));
  assert.strictEqual(statusRecord.cdpConnected, true);
  assert.strictEqual(statusRecord.collectorCount, 2);
  assert.strictEqual(statusRecord.lastError, 'boom');
  assert.strictEqual(statusRecord.role, 'leader');

  // 非 leader 无法把 role 改成别的
  election.updateStatus({ role: 'follower' });
  assert.strictEqual(election.role, 'leader');
  assert.strictEqual(election.getStatus().role, 'leader');
});

test('follower 实例：不同步写 status.json，updateStatus 无效', async (t) => {
  const dir = makeDir(t);
  const statusPath = path.join(dir, 'status.json');

  const leader = makeElection(t, dir);
  await leader.start();
  leader.updateStatus({ cdpConnected: true, collectorCount: 1 });

  const follower = makeElection(t, dir);
  const roleEvents = [];
  follower.on('role', (role) => roleEvents.push(role));
  await follower.start();

  assert.strictEqual(follower.role, 'follower');
  assert.ok(roleEvents.includes('follower'));
  assert.strictEqual(follower.getStatus().cdpConnected, true, 'follower 应读到 leader 的状态');

  const before = fs.readFileSync(statusPath, 'utf8');
  follower.updateStatus({ cdpConnected: false, targetCount: 99 });
  const after = fs.readFileSync(statusPath, 'utf8');
  assert.strictEqual(after, before, 'follower 不应写 status.json');
  assert.strictEqual(follower.getStatus().targetCount, 0, 'follower 的 updateStatus 应被忽略');
});

test('follower 1s 内同步 leader 的状态变化并 emit status', async (t) => {
  const dir = makeDir(t);
  const leader = makeElection(t, dir);
  await leader.start();

  const follower = makeElection(t, dir);
  const statusEvents = [];
  follower.on('status', (status) => statusEvents.push(status));
  await follower.start();

  leader.updateStatus({ targetCount: 9, breakpointCount: 4 });
  assert.ok(
    await waitFor(() => follower.getStatus().targetCount === 9, 2500),
    'follower 应同步到新的 targetCount',
  );
  assert.ok(statusEvents.some((status) => status.targetCount === 9));
});

test('leader 退出后 follower 自动重新竞选并接管', async (t) => {
  const dir = makeDir(t);
  const leaderPath = path.join(dir, 'leader.json');

  const first = makeElection(t, dir);
  await first.start();
  assert.strictEqual(first.role, 'leader');

  const second = makeElection(t, dir);
  await second.start();
  assert.strictEqual(second.role, 'follower', '第二个实例应为 follower');

  first.stop();
  assert.ok(await waitFor(() => second.role === 'leader', 3000), 'follower 应自动接管成为 leader');

  const leaderRecord = readJson(leaderPath);
  assert.ok(Number.isFinite(leaderRecord.heartbeatAt));
  assert.ok(Number.isFinite(leaderRecord.pid));

  second.stop();
  assert.ok(!fs.existsSync(leaderPath), 'stop() 应清理自己拥有的 leader.json');
});

test('leader 过期（heartbeatAt 超时 / 进程不存在）后可被接管', async (t) => {
  const dir = makeDir(t);
  const leaderPath = path.join(dir, 'leader.json');
  fs.writeFileSync(
    leaderPath,
    JSON.stringify({
      pid: 999999,
      nonce: 'dead-nonce',
      startedAt: Date.now() - 60_000,
      heartbeatAt: Date.now() - 60_000,
      version: '0.1.0',
    }),
    'utf8',
  );

  const election = makeElection(t, dir);
  await election.start();
  assert.strictEqual(election.role, 'leader', '过期记录应允许重新竞选');
  assert.strictEqual(readJson(leaderPath).pid, process.pid);
});

test('损坏的 leader.json 视为过期，可接管', async (t) => {
  const dir = makeDir(t);
  fs.writeFileSync(path.join(dir, 'leader.json'), '{ this is not json', 'utf8');
  const election = makeElection(t, dir);
  await election.start();
  assert.strictEqual(election.role, 'leader');
});

test('leader.json 被其它 nonce 接管时原 leader 降级；stop 不删别人的文件', async (t) => {
  const dir = makeDir(t);
  const leaderPath = path.join(dir, 'leader.json');
  const election = makeElection(t, dir, { staleMs: 5000 });
  await election.start();
  assert.strictEqual(election.role, 'leader');

  fs.writeFileSync(
    leaderPath,
    JSON.stringify({
      pid: process.pid,
      nonce: 'foreign-nonce',
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
      version: '0.1.0',
    }),
    'utf8',
  );

  assert.ok(await waitFor(() => election.role === 'follower', 2000), '发现被接管后应降级为 follower');

  election.stop();
  assert.ok(fs.existsSync(leaderPath), 'stop() 不应删除其它实例的 leader.json');
  assert.strictEqual(readJson(leaderPath).nonce, 'foreign-nonce');
});

test('stop 可重复调用，重新 start 仍可成为 leader', async (t) => {
  const dir = makeDir(t);
  const election = makeElection(t, dir);
  await election.start();
  election.stop();
  election.stop();
  assert.strictEqual(election.role, 'starting');

  await election.start();
  assert.strictEqual(election.role, 'leader');
});

test('目录不可创建时 emit error，不崩溃', async (t) => {
  const dir = makeDir(t);
  const notADir = path.join(dir, 'not-a-dir');
  fs.writeFileSync(notADir, 'x', 'utf8');

  const election = new LeaderElection({ dir: notADir, heartbeatMs: 80, staleMs: 400 });
  t.after(() => election.stop());
  const errors = [];
  election.on('error', (err) => errors.push(err));

  await election.start();
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0] instanceof Error);
  assert.strictEqual(election.role, 'starting');
});
