'use strict';

const path = require('node:path');
const { TraeCollector } = require('../capture/collector');
const { UsageStore } = require('../data/store');
const { LeaderElection } = require('../data/leader');
const { deriveHostLabel } = require('../host');

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/** 纯 Node 采集生命周期；与 IDE 共用选主和数据库，但不依赖 VS Code。 */
class StandaloneCaptureRuntime {
  constructor(options) {
    this.dbPath = options.dbPath;
    this.sharedDir = options.sharedDir || path.join(path.dirname(options.dbPath), 'shared');
    this.cdpPort = options.cdpPort || 9333;
    this.pollIntervalMs = options.pollIntervalMs || 3000;
    this.timingEnabled = options.timingEnabled !== false;
    this.retentionDays = options.retentionDays || 180;
    this.pruneIntervalMs = options.pruneIntervalMs || SIX_HOURS_MS;
    this.collectorFactory = options.collectorFactory || ((collectorOptions) => new TraeCollector(collectorOptions));
    this.webSocketImpl = options.webSocketImpl || null;
    this.logger = options.logger || (() => {});
    this.store = null;
    this.election = null;
    this.collector = null;
    this.pruneTimer = null;
    this.lastUsageAt = 0;
    this.started = false;
    this.closed = false;
  }

  async start() {
    if (this.started) return;
    if (this.closed) throw new Error('独立采集 runtime 已关闭');
    this.started = true;
    try {
      this.store = new UsageStore(this.dbPath);
      this.election = new LeaderElection({
        dir: this.sharedDir,
        logger: (message) => this.log('info', message)
      });
      this.election.on('role', (role) => this.onRole(role));
      this.election.on('error', (error) => this.log('error', `选主失败：${error.message}`));
      await this.election.start();
      this.pruneTimer = setInterval(() => {
        if (this.election?.role === 'leader') this.prune();
      }, this.pruneIntervalMs);
      this.pruneTimer.unref();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  onRole(role) {
    if (this.closed) return;
    if (role === 'leader') {
      this.startCollector();
      this.prune();
      try {
        this.store.backfillModels();
      } catch (error) {
        this.log('error', `历史模型回填失败：${error.message}`);
      }
      return;
    }
    this.stopCollector();
  }

  startCollector() {
    this.stopCollector();
    this.collector = this.collectorFactory({
      host: '127.0.0.1',
      port: this.cdpPort,
      debuggerEnabled: true,
      // 常驻端只读取 Token 事件，禁止读取网络响应正文。
      networkEnabled: false,
      timingEnabled: this.timingEnabled,
      pollIntervalMs: this.pollIntervalMs,
      webSocketImpl: this.webSocketImpl,
      logger: (level, message) => this.log(level, message)
    });
    this.collector.on('usage', (event) => this.handleUsage(event));
    this.collector.on('status', (status) => this.handleCollectorStatus(status));
    this.collector.on('diagnostic', (event) => {
      if (event?.error && event.type !== 'handler-error') this.log('warn', `${event.type}: ${event.error}`);
    });
    this.collector.start();
  }

  stopCollector() {
    if (!this.collector) return;
    try {
      this.collector.stop();
    } catch (error) {
      this.log('error', `采集器停止失败：${error.message}`);
    }
    this.collector = null;
  }

  handleCollectorStatus(status) {
    if (this.closed || !status) return;
    this.election?.updateStatus({
      cdpConnected: Boolean(status.connected),
      targetCount: status.targetCount || 0,
      collectorCount: status.collectorCount || 0,
      breakpointCount: status.breakpointCount || 0,
      lastCaptureAt: this.lastUsageAt || status.lastCaptureAt || null,
      lastError: status.lastError || null,
      platform: process.platform
    });
  }

  handleUsage(raw) {
    if (this.closed || !raw) return;
    if (!(raw.inputTokens > 0 || raw.outputTokens > 0 || raw.totalTokens > 0)) return;
    try {
      this.store.record(
        { ...raw, observedAt: Number(raw.observedAt) || Date.now() },
        { hostLabel: deriveHostLabel(raw.targetTitle || '') }
      );
      this.lastUsageAt = Date.now();
      this.election?.updateStatus({ lastCaptureAt: this.lastUsageAt });
      this.log('info', `usage: model=${raw.model} in=${raw.inputTokens} out=${raw.outputTokens} complete=${raw.usageComplete !== false}`);
    } catch (error) {
      this.log('error', `用量写入失败：${error.message}`);
    }
  }

  prune() {
    try {
      this.store?.prune({ retentionDays: this.retentionDays });
    } catch (error) {
      this.log('error', `历史记录清理失败：${error.message}`);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    this.stopCollector();
    try { this.election?.stop(); } catch { /* 已尽力释放租约 */ }
    try { this.store?.close(); } catch { /* 允许重复关闭 */ }
    this.election = null;
    this.store = null;
  }

  log(level, message) {
    try { this.logger(level, message); } catch { /* 日志不影响采集 */ }
  }
}

module.exports = { StandaloneCaptureRuntime };
