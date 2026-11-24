'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-process-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'capture-service.lock');
}

function createLock(lockPath) {
  const { CaptureProcessLock } = require('../src/standalone/process-lock');
  return new CaptureProcessLock(lockPath);
}

test('同一共享目录只允许一个常驻采集进程', (t) => {
  const lockPath = fixture(t);
  const first = createLock(lockPath);
  const second = createLock(lockPath);
  first.acquire();
  t.after(() => { first.close(); second.close(); });

  assert.throws(() => second.acquire(), /已运行/);
  first.close();
  assert.doesNotThrow(() => second.acquire());
  assert.throws(() => first.acquire(), /已运行/);
  second.close();
  assert.equal(fs.existsSync(lockPath), false);
});

test('异常退出留下的死进程锁可自动恢复', (t) => {
  const lockPath = fixture(t);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, nonce: 'dead-process' }));
  const lock = createLock(lockPath);
  t.after(() => lock.close());
  assert.doesNotThrow(() => lock.acquire());
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, process.pid);
});

test('旧锁关闭不会删除新进程的锁文件', (t) => {
  const lockPath = fixture(t);
  const first = createLock(lockPath);
  const second = createLock(lockPath);
  first.acquire();
  first.close();
  second.acquire();
  first.close();
  assert.equal(fs.existsSync(lockPath), true);
  second.close();
});
