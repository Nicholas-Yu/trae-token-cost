'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseJsonc } = require('../setup/argv');
const { mergeModelPrices } = require('../default-pricing');
const { normalizeRange } = require('../util');

function defaultStandalonePaths(home = os.homedir()) {
  const userDir = path.join(home, 'Library', 'Application Support', 'Trae CN', 'User');
  return {
    dbPath: path.join(userDir, 'globalStorage', 'local.trae-token-cost', 'usage.db'),
    settingsPath: path.join(userDir, 'settings.json')
  };
}

function readOption(argv, index) {
  if (index + 1 >= argv.length) throw new Error(`缺少参数值：${argv[index]}`);
  return argv[index + 1];
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`无效的端口：${value}`);
  return port;
}

function parseCdpPort(value) {
  const port = parsePort(value);
  if (port === 0) throw new Error(`无效的端口：${value}`);
  return port;
}

function readCaptureSettings(settingsPath) {
  try {
    const settings = parseJsonc(fs.readFileSync(settingsPath, 'utf8'));
    const result = {};
    const ranges = {
      cdpPort: ['traeTokenCost.cdpPort', 1, 65535],
      pollIntervalMs: ['traeTokenCost.pollIntervalMs', 1000, 60000],
      retentionDays: ['traeTokenCost.retentionDays', 1, 3650]
    };
    for (const [target, [key, minimum, maximum]] of Object.entries(ranges)) {
      const value = Number(settings[key]);
      if (Number.isInteger(value) && value >= minimum && value <= maximum) result[target] = value;
    }
    if (typeof settings['traeTokenCost.timingEnabled'] === 'boolean') {
      result.timingEnabled = settings['traeTokenCost.timingEnabled'];
    }
    return result;
  } catch {
    return {};
  }
}

/** CLI 参数优先于环境变量，默认使用 Trae CN 用户数据目录。 */
function resolveStandaloneConfig(argv = [], env = {}, home = os.homedir()) {
  const defaults = defaultStandalonePaths(home);
  const config = {
    ...defaults,
    port: env.TRAE_TOKEN_COST_PORT === undefined ? 0 : parsePort(env.TRAE_TOKEN_COST_PORT),
    noOpen: env.TRAE_TOKEN_COST_NO_OPEN === '1',
    capture: false,
    timingEnabled: true,
    cdpPort: 9333,
    pollIntervalMs: 3000,
    retentionDays: 180
  };
  const overridden = { cdpPort: env.TRAE_TOKEN_COST_CDP_PORT !== undefined };
  if (env.TRAE_TOKEN_COST_DB) config.dbPath = env.TRAE_TOKEN_COST_DB;
  if (env.TRAE_TOKEN_COST_SETTINGS) config.settingsPath = env.TRAE_TOKEN_COST_SETTINGS;
  if (overridden.cdpPort) config.cdpPort = parseCdpPort(env.TRAE_TOKEN_COST_CDP_PORT);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') {
      config.dbPath = readOption(argv, index);
      index += 1;
    } else if (arg === '--settings') {
      config.settingsPath = readOption(argv, index);
      index += 1;
    } else if (arg === '--port') {
      config.port = parsePort(readOption(argv, index));
      index += 1;
    } else if (arg === '--cdp-port') {
      config.cdpPort = parseCdpPort(readOption(argv, index));
      overridden.cdpPort = true;
      index += 1;
    } else if (arg === '--capture') {
      config.capture = true;
    } else if (arg === '--no-open') {
      config.noOpen = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }

  const captureSettings = readCaptureSettings(config.settingsPath);
  for (const key of ['cdpPort', 'pollIntervalMs', 'retentionDays']) {
    if (!overridden[key] && captureSettings[key] !== undefined) config[key] = captureSettings[key];
  }
  if (captureSettings.timingEnabled !== undefined) config.timingEnabled = captureSettings.timingEnabled;
  config.sharedDir = path.join(path.dirname(config.dbPath), 'shared');
  return config;
}

/** 只提取看板需要的公开设置，原始 settings 不进入响应。 */
function loadPriceConfig(settingsPath) {
  const fallback = { modelPrices: mergeModelPrices({}), currency: 'CNY', defaultRange: 'today', warnings: [] };
  if (!fs.existsSync(settingsPath)) {
    return { ...fallback, warnings: ['未找到用户价格设置，使用内置百炼价格'] };
  }
  try {
    const settings = parseJsonc(fs.readFileSync(settingsPath, 'utf8'));
    const modelPrices = settings['traeTokenCost.modelPrices'];
    const currency = settings['traeTokenCost.currency'];
    return {
      modelPrices: mergeModelPrices(modelPrices),
      currency: typeof currency === 'string' && currency.trim() ? currency.trim() : 'CNY',
      defaultRange: normalizeRange(settings['traeTokenCost.defaultRange']),
      warnings: []
    };
  } catch {
    return { ...fallback, warnings: ['用户价格设置读取失败，使用内置百炼价格'] };
  }
}

module.exports = {
  defaultStandalonePaths,
  resolveStandaloneConfig,
  loadPriceConfig
};
