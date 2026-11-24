'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveStandaloneConfig } = require('./config');
const { startStandaloneServer } = require('./server');
const { StandaloneCaptureRuntime } = require('./capture-runtime');
const { CaptureProcessLock } = require('./process-lock');

function openPlatformUrl(url) {
  let command;
  let args;
  if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  const child = spawn(command, args, { stdio: 'ignore' });
  child.on('error', (error) => console.error(`无法自动打开浏览器：${error.message}`));
}

/** 前台启动；终端信号触发统一资源释放。 */
async function runStandaloneCli(argv = process.argv.slice(2), dependencies = {}) {
  const resolveConfig = dependencies.resolveConfig || ((args) => resolveStandaloneConfig(args, process.env));
  const startServer = dependencies.startServer || startStandaloneServer;
  const openUrl = dependencies.openUrl || openPlatformUrl;
  const signalTarget = dependencies.signalTarget || process;
  const exit = dependencies.exit || ((code) => process.exit(code));
  const log = dependencies.log || console.log;
  const createCaptureRuntime = dependencies.createCaptureRuntime || ((config) => new StandaloneCaptureRuntime({
    ...config,
    // 独立 Node 使用 ws，规避 undici 读取大型 CDP 脚本时的异常断连；IDE 保持原实现。
    webSocketImpl: require('ws'),
    logger: (level, message) => console.log(`[capture:${level}] ${message}`)
  }));
  const createProcessLock = dependencies.createProcessLock || ((config) => new CaptureProcessLock(path.join(config.sharedDir, 'capture-service.lock')));

  const config = resolveConfig(argv);
  let captureRuntime = null;
  let captureLock = null;
  let app = null;
  try {
    if (config.capture) {
      captureLock = createProcessLock(config);
      captureLock.acquire();
      captureRuntime = createCaptureRuntime(config);
      await captureRuntime.start();
    }
    app = await startServer(config);
  } catch (error) {
    try { await captureRuntime?.close(); } catch { /* 保留原始启动错误 */ }
    try { captureLock?.close(); } catch { /* 保留原始启动错误 */ }
    throw error;
  }

  log(`本地网页看板：${app.url}`);
  if (!config.noOpen) openUrl(app.url);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await captureRuntime?.close();
    } finally {
      try { await app.close(); } finally {
        try { captureLock?.close(); } finally { exit(0); }
      }
    }
  };
  signalTarget.once('SIGINT', shutdown);
  signalTarget.once('SIGTERM', shutdown);
  signalTarget.once('SIGHUP', shutdown);
  return app;
}

if (require.main === module) {
  runStandaloneCli().catch((error) => {
    console.error(`启动本地网页看板失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { runStandaloneCli, openPlatformUrl };
