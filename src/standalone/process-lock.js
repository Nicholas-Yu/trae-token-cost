'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** 原子锁文件防止多个 daemon；IDE 不使用此锁，仍可参与共享选主。 */
class CaptureProcessLock {
  constructor(lockPath) {
    this.lockPath = lockPath;
    this.nonce = crypto.randomBytes(16).toString('hex');
    this.fd = null;
  }

  acquire() {
    if (this.fd !== null) return;
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce: this.nonce }));
          this.fd = fd;
          return;
        } catch (error) {
          fs.closeSync(fd);
          fs.unlinkSync(this.lockPath);
          throw error;
        }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const current = this.read();
        if (current && isProcessAlive(current.pid)) {
          throw new Error(`独立采集服务已运行（PID ${current.pid}），不再启动第二个进程`);
        }
        try { fs.unlinkSync(this.lockPath); } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        }
      }
    }
    throw new Error('独立采集服务锁竞争失败，请稍后重试');
  }

  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
      return value && typeof value === 'object' ? value : null;
    } catch {
      return null;
    }
  }

  close() {
    if (this.fd === null) return;
    const fd = this.fd;
    this.fd = null;
    try {
      // 只有锁的持有者才能删除，避免旧进程误删新实例的锁。
      if (this.read()?.nonce === this.nonce) fs.unlinkSync(this.lockPath);
    } catch {
      // 锁文件已被清理时无需重复处理。
    } finally {
      fs.closeSync(fd);
    }
  }
}

module.exports = { CaptureProcessLock };
