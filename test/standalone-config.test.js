const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  resolveStandaloneConfig,
  loadPriceConfig
} = require('../src/standalone/config');

test('配置解析遵循 CLI、环境变量、默认路径优先级', () => {
  const home = path.join(path.sep, 'tmp', 'home');
  const defaults = resolveStandaloneConfig([], {}, home);
  assert.equal(defaults.dbPath, path.join(home, 'Library', 'Application Support', 'Trae CN', 'User', 'globalStorage', 'local.trae-token-cost', 'usage.db'));
  assert.equal(defaults.settingsPath, path.join(home, 'Library', 'Application Support', 'Trae CN', 'User', 'settings.json'));
  assert.equal(defaults.port, 0);
  assert.equal(defaults.noOpen, false);
  assert.equal(defaults.capture, false);
  assert.equal(defaults.timingEnabled, true);
  assert.equal(defaults.cdpPort, 9333);
  assert.equal(defaults.pollIntervalMs, 3000);
  assert.equal(defaults.retentionDays, 180);
  assert.equal(defaults.sharedDir, path.join(path.dirname(defaults.dbPath), 'shared'));

  const env = {
    TRAE_TOKEN_COST_DB: '/env/usage.db',
    TRAE_TOKEN_COST_SETTINGS: '/env/settings.json',
    TRAE_TOKEN_COST_PORT: '9000',
    TRAE_TOKEN_COST_CDP_PORT: '9444',
    TRAE_TOKEN_COST_NO_OPEN: '1'
  };
  const fromEnv = resolveStandaloneConfig([], env, home);
  assert.equal(fromEnv.dbPath, '/env/usage.db');
  assert.equal(fromEnv.settingsPath, '/env/settings.json');
  assert.equal(fromEnv.port, 9000);
  assert.equal(fromEnv.cdpPort, 9444);
  assert.equal(fromEnv.noOpen, true);

  const fromCli = resolveStandaloneConfig(['--db', '/cli/usage.db', '--settings', '/cli/settings.json', '--port', '9001', '--cdp-port', '9555', '--capture', '--no-open'], env, home);
  assert.equal(fromCli.dbPath, '/cli/usage.db');
  assert.equal(fromCli.settingsPath, '/cli/settings.json');
  assert.equal(fromCli.port, 9001);
  assert.equal(fromCli.cdpPort, 9555);
  assert.equal(fromCli.capture, true);
  assert.equal(fromCli.sharedDir, '/cli/shared');
  assert.equal(fromCli.noOpen, true);
  assert.throws(() => resolveStandaloneConfig(['--port', 'invalid'], {}, home), /端口/);
  assert.throws(() => resolveStandaloneConfig(['--cdp-port', '0'], {}, home), /端口/);
});

test('采集设置遵循 CLI 覆盖 settings，数据库目录派生共享目录', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-capture-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    'traeTokenCost.cdpPort': 9666,
    'traeTokenCost.pollIntervalMs': 4500,
    'traeTokenCost.retentionDays': 90,
    'traeTokenCost.timingEnabled': false,
    'secret.token': 'must-not-leak'
  }));

  const fromSettings = resolveStandaloneConfig(['--settings', settingsPath], {}, dir);
  assert.equal(fromSettings.cdpPort, 9666);
  assert.equal(fromSettings.pollIntervalMs, 4500);
  assert.equal(fromSettings.retentionDays, 90);
  assert.equal(fromSettings.timingEnabled, false);
  assert.equal(JSON.stringify(fromSettings).includes('must-not-leak'), false);

  const overridden = resolveStandaloneConfig(['--settings', settingsPath, '--db', path.join(dir, 'custom', 'usage.db'), '--cdp-port', '9777'], {}, dir);
  assert.equal(overridden.cdpPort, 9777);
  assert.equal(overridden.sharedDir, path.join(dir, 'custom', 'shared'));
});

test('价格设置只提取币种和模型价格，不泄露其他配置', (t) => {
  const { settingsPath } = require('./harness/standalone').makeUsageFixture(t);
  const result = loadPriceConfig(settingsPath);
  assert.equal(result.currency, 'CNY');
  assert.equal(result.modelPrices['custom/gpt-test'].length, 1);
  assert.deepEqual(result.warnings, []);
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
});

test('loadPriceConfig 提取 defaultRange 并校验', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-insights-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    'traeTokenCost.defaultRange': 'week',
    'secret.token': 'must-not-leak'
  }));
  const result = loadPriceConfig(settingsPath);
  assert.equal(result.defaultRange, 'week');
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);

  fs.writeFileSync(settingsPath, JSON.stringify({ 'traeTokenCost.defaultRange': 'bogus' }));
  const invalid = loadPriceConfig(settingsPath);
  assert.equal(invalid.defaultRange, 'today');

  const missing = loadPriceConfig(path.join(dir, 'missing.json'));
  assert.equal(missing.defaultRange, 'today');
});

test('设置缺失或损坏时降级为无价格模式并给出警告', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const missing = loadPriceConfig(path.join(dir, 'missing.json'));
  assert.ok(missing.modelPrices['kimi-k3.1-pro']);
  assert.equal(missing.currency, 'CNY');
  assert.match(missing.warnings[0], /内置百炼价格/);
  const badPath = path.join(dir, 'bad.json');
  fs.writeFileSync(badPath, '{ invalid');
  const broken = loadPriceConfig(badPath);
  assert.ok(broken.modelPrices['kimi-k3.1-pro']);
  assert.match(broken.warnings[0], /内置百炼价格/);
});
