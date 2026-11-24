'use strict';

/**
 * src/data/leader.js
 *
 * LeaderElection —— 基于心跳文件的跨进程单 leader 选举（契约 docs/INTERFACES.md §6）。
 *
 * 背景：同一个 Trae 可能打开多个窗口（甚至多个进程），但只能有一个实例启动 CDP collector。
 * 本模块用 <dir>/leader.json 做租约、<dir>/status.json 广播状态，零第三方依赖。
 *
 * 协议：
 * - leader.json = { pid, nonce, startedAt, heartbeatAt, version }，leader 每 heartbeatMs 刷新；
 * - 读取时若 heartbeatAt 超过 staleMs（或记录的 pid 已不存在），视为过期，可重新竞选；
 * - 竞选 = 写入自己的 nonce 后回读，读到的 nonce 是自己才成为 leader（last-writer-wins + 回读确认）；
 * - follower 每 followerCheckMs（默认 1000ms）检查一次，leader 过期则自动重新竞选；
 * - leader 心跳时若发现 leader.json 已被别的 nonce 接管，主动降级为 follower，避免脑裂；
 * - stop() 只删除自己的 leader.json，不碰别人的文件。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const DEFAULT_HEARTBEAT_MS = 2000;
const DEFAULT_STALE_MS = 8000;
const DEFAULT_FOLLOWER_CHECK_MS = 1000;
const LEADER_FILE = 'leader.json';
const STATUS_FILE = 'status.json';

/** 读取扩展版本号（用于 leader.json / status.json 的 version 字段）。 */
function readPackageVersion() {
  try {
    const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function readJsonSync(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    if (!text.trim()) return null;
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** 原子写 JSON：同目录临时文件 + rename，权限 0600。 */
function atomicWriteJsonSync(filePath, value) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
  );
  const text = `${JSON.stringify(value, null, 2)}\n`;
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'w', 0o600);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 表示进程存在但无权限，按存活处理。
    return err && err.code === 'EPERM';
  }
}

function positiveNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

/**
 * @typedef {object} ElectionStatus
 * @property {'leader'|'follower'|'starting'} role
 * @property {number} pid
 * @property {number} startedAt
 * @property {number|null} heartbeatAt
 * @property {boolean} cdpConnected
 * @property {number} targetCount
 * @property {number} collectorCount
 * @property {number} breakpointCount
 * @property {number|null} lastCaptureAt
 * @property {string|null} lastError
 * @property {string|null} appVersion
 * @property {string} platform
 */

class LeaderElection extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.dir 存放 leader.json / status.json 的目录
   * @param {number} [options.heartbeatMs=2000] leader 心跳间隔
   * @param {number} [options.staleMs=8000] leader 记录过期时间
   * @param {number} [options.followerCheckMs=1000] follower 检查间隔
   * @param {Function} [options.logger] 日志函数 (message) => void
   * @param {string|null} [options.version] 扩展版本号（缺省读 package.json）
   * @param {string|null} [options.appVersion] 状态里的 appVersion（扩展层可用 updateStatus 覆盖为 Trae 版本）
   * @param {string} [options.platform=process.platform]
   * @param {Function} [options.now=Date.now] 时间源（单测可注入）
   */
  constructor(options = {}) {
    super();
    const {
      dir,
      heartbeatMs = DEFAULT_HEARTBEAT_MS,
      staleMs = DEFAULT_STALE_MS,
      followerCheckMs = DEFAULT_FOLLOWER_CHECK_MS,
      logger = () => {},
      version = null,
      appVersion = null,
      platform = process.platform,
      now = Date.now,
    } = options;

    if (typeof dir !== 'string' || dir.length === 0) {
      throw new TypeError('LeaderElection: dir 必须是非空字符串');
    }

    this.dir = dir;
    this.heartbeatMs = positiveNumber(heartbeatMs, DEFAULT_HEARTBEAT_MS);
    this.staleMs = positiveNumber(staleMs, DEFAULT_STALE_MS);
    this.followerCheckMs = positiveNumber(followerCheckMs, DEFAULT_FOLLOWER_CHECK_MS);
    this.logger = typeof logger === 'function' ? logger : () => {};
    this.platform = platform || process.platform;
    this.version = version || readPackageVersion();
    this.appVersion = typeof appVersion === 'string' && appVersion.length > 0 ? appVersion : null;

    this._now = typeof now === 'function' ? now : Date.now;
    this._nonce = crypto.randomBytes(16).toString('hex');
    this._pid = process.pid;
    this._startedAt = this._now();

    this._role = 'starting';
    this._running = false;
    this._heartbeatTimer = null;
    this._followerTimer = null;
    this._heartbeatAt = null;
    this._lastStatusSignature = null;
    this._status = this._defaultStatus('starting');
  }

  get leaderFilePath() {
    return path.join(this.dir, LEADER_FILE);
  }

  get statusFilePath() {
    return path.join(this.dir, STATUS_FILE);
  }

  /** @returns {'leader'|'follower'|'starting'} */
  get role() {
    return this._role;
  }

  /** 当前状态快照（leader 写文件，follower 读文件后合并）。 */
  getStatus() {
    return {
      ...this._status,
      role: this._role,
      platform: this.platform,
      appVersion: this._status.appVersion ?? this.appVersion,
    };
  }

  /**
   * 异步开始选举：建立目录 → 首次竞选 → 启动心跳/follower 轮询。
   * @returns {Promise<ElectionStatus>}
   */
  async start() {
    if (this._running) return this.getStatus();
    this._running = true;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      this._running = false;
      this._fail(err);
      return this.getStatus();
    }
    this._elect();
    this._emitStatus();
    return this.getStatus();
  }

  /** 停止选举；只有 leader 会删除自己的 leader.json。可重复调用。 */
  stop() {
    const wasRunning = this._running;
    this._running = false;
    this._stopHeartbeatTimer();
    this._stopFollowerTimer();
    if (this._role === 'leader') this._removeOwnLeaderFile();
    this._role = 'starting';
    this._status = this._defaultStatus('starting');
    this._lastStatusSignature = null;
    this._heartbeatAt = null;
    if (wasRunning) this._log('info', 'stopped');
  }

  /**
   * 仅 leader 生效：合并状态、刷新 heartbeatAt 并写 status.json。
   * @param {Partial<ElectionStatus>} partial
   * @returns {ElectionStatus}
   */
  updateStatus(partial) {
    if (!this._running || this._role !== 'leader') return this.getStatus();
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) return this.getStatus();

    const heartbeatAt = this._now();
    this._status = {
      ...this._status,
      ...partial,
      role: 'leader',
      pid: this._pid,
      startedAt: this._startedAt,
      heartbeatAt,
      platform: this.platform,
      appVersion: (partial && partial.appVersion) ?? this._status.appVersion ?? this.appVersion,
    };
    this._heartbeatAt = heartbeatAt;
    try {
      atomicWriteJsonSync(this.statusFilePath, this._status);
    } catch (err) {
      this._fail(err);
    }
    this._emitStatus();
    return this.getStatus();
  }

  // ---------------------------------------------------------------------------
  // 选举内部实现
  // ---------------------------------------------------------------------------

  _defaultStatus(role) {
    return {
      role,
      pid: this._pid,
      startedAt: this._startedAt,
      heartbeatAt: null,
      cdpConnected: false,
      targetCount: 0,
      collectorCount: 0,
      breakpointCount: 0,
      lastCaptureAt: null,
      lastError: null,
      appVersion: this.appVersion,
      platform: this.platform,
    };
  }

  _log(level, message) {
    try {
      this.logger(`[leader ${level}] ${message}`);
    } catch {
      // 日志函数异常不影响选举。
    }
  }

  _fail(err) {
    const error = err instanceof Error ? err : new Error(String(err));
    this._log('error', error.message);
    // EventEmitter 的 'error' 事件没有监听者时会 throw，这里做保护。
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    }
  }

  _emitStatus() {
    const status = this.getStatus();
    const signature = JSON.stringify(status);
    if (signature === this._lastStatusSignature) return;
    this._lastStatusSignature = signature;
    this.emit('status', status);
  }

  _setRole(role) {
    if (this._role === role) return false;
    this._role = role;
    this._log('info', `role -> ${role}`);
    this.emit('role', role);
    return true;
  }

  /** leader.json 里的记录是否已过期（不存在也算过期）。 */
  _isExpired(record) {
    if (!record || typeof record !== 'object') return true;
    if (record.nonce && record.nonce === this._nonce) return false;
    const heartbeatAt = Number(record.heartbeatAt);
    if (!Number.isFinite(heartbeatAt)) return true;
    if (this._now() - heartbeatAt > this.staleMs) return true;
    // 同机场景：记录里的进程已经不存在，可以立即接管。
    if (Number.isInteger(record.pid) && record.pid > 0 && record.pid !== this._pid && !isProcessAlive(record.pid)) {
      return true;
    }
    return false;
  }

  /** 读 leader.json 并决定竞选 / 成为 follower。 */
  _elect() {
    if (!this._running) return;
    try {
      const current = readJsonSync(this.leaderFilePath);
      if (current && current.nonce === this._nonce) {
        this._becomeLeader();
        return;
      }
      if (current && !this._isExpired(current)) {
        this._becomeFollower();
        return;
      }

      // 写入候选并回读确认（两个进程同时写时，后写者胜出）。
      const claim = {
        pid: this._pid,
        nonce: this._nonce,
        startedAt: this._startedAt,
        heartbeatAt: this._now(),
        version: this.version,
      };
      atomicWriteJsonSync(this.leaderFilePath, claim);
      const verify = readJsonSync(this.leaderFilePath);
      if (verify && verify.nonce === this._nonce) {
        this._becomeLeader();
      } else {
        this._becomeFollower();
      }
    } catch (err) {
      this._fail(err);
      this._becomeFollower();
    }
  }

  _becomeLeader() {
    this._stopFollowerTimer();
    const changed = this._setRole('leader');
    if (changed) {
      // 新 leader 从干净状态开始，避免沿用旧 leader 广播的 collector 字段。
      this._status = this._defaultStatus('leader');
      this._lastStatusSignature = null;
    }
    this._startHeartbeatTimer();
    this._writeHeartbeat();
  }

  _becomeFollower() {
    this._stopHeartbeatTimer();
    const changed = this._setRole('follower');
    if (changed) {
      this._status = this._defaultStatus('follower');
      this._lastStatusSignature = null;
    }
    this._startFollowerTimer();
    this._readLeaderStatus();
    this._emitStatus();
  }

  _startHeartbeatTimer() {
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(() => this._heartbeatTick(), this.heartbeatMs);
    if (typeof this._heartbeatTimer.unref === 'function') this._heartbeatTimer.unref();
  }

  _stopHeartbeatTimer() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _startFollowerTimer() {
    if (this._followerTimer) return;
    this._followerTimer = setInterval(() => this._followerTick(), this.followerCheckMs);
    if (typeof this._followerTimer.unref === 'function') this._followerTimer.unref();
  }

  _stopFollowerTimer() {
    if (this._followerTimer) {
      clearInterval(this._followerTimer);
      this._followerTimer = null;
    }
  }

  _heartbeatTick() {
    if (!this._running || this._role !== 'leader') return;
    try {
      const current = readJsonSync(this.leaderFilePath);
      if (!current || (current.nonce && current.nonce !== this._nonce)) {
        // 被删除或被其它实例接管：主动降级，由 follower 轮询重新竞选。
        this._log('warn', 'leader.json 已丢失或被接管，降级为 follower');
        this._becomeFollower();
        return;
      }
      this._writeHeartbeat();
    } catch (err) {
      this._fail(err);
    }
  }

  _writeHeartbeat() {
    if (!this._running || this._role !== 'leader') return;
    const heartbeatAt = this._now();
    try {
      atomicWriteJsonSync(this.leaderFilePath, {
        pid: this._pid,
        nonce: this._nonce,
        startedAt: this._startedAt,
        heartbeatAt,
        version: this.version,
      });
      this._heartbeatAt = heartbeatAt;
      this._status = {
        ...this._status,
        role: 'leader',
        pid: this._pid,
        startedAt: this._startedAt,
        heartbeatAt,
        platform: this.platform,
        appVersion: this._status.appVersion ?? this.appVersion,
      };
      atomicWriteJsonSync(this.statusFilePath, this._status);
      this._emitStatus();
    } catch (err) {
      this._fail(err);
    }
  }

  _followerTick() {
    if (!this._running || this._role !== 'follower') return;
    try {
      const current = readJsonSync(this.leaderFilePath);
      if (!current || this._isExpired(current)) {
        this._log('info', 'leader 已过期，重新竞选');
        this._elect();
        return;
      }
      this._readLeaderStatus();
      this._emitStatus();
    } catch (err) {
      this._fail(err);
    }
  }

  /** follower 读取 leader 写的 status.json；读不到则维持默认状态。 */
  _readLeaderStatus() {
    const raw = readJsonSync(this.statusFilePath);
    if (!raw) {
      this._status = this._defaultStatus('follower');
      return;
    }
    this._status = {
      ...this._defaultStatus('follower'),
      ...raw,
      role: 'follower',
      platform: raw.platform || this.platform,
      appVersion: raw.appVersion ?? this.appVersion ?? null,
    };
  }

  _removeOwnLeaderFile() {
    try {
      const current = readJsonSync(this.leaderFilePath);
      if (current && current.nonce === this._nonce) {
        fs.unlinkSync(this.leaderFilePath);
      }
    } catch {
      // 文件已不存在 / 不可读：无需清理。
    }
  }
}

module.exports = { LeaderElection };
