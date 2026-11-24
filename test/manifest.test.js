const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('扩展使用独立 ID、命令前缀和费用配置', () => {
  assert.equal(manifest.name, 'trae-token-cost');
  assert.match(manifest.displayName, /费用/);
  assert.equal(manifest.contributes.configuration.title, 'Trae Token 费用');
  const commands = manifest.contributes.commands.map((item) => item.command);
  assert.ok(commands.includes('traeTokenCost.openDashboard'));
  assert.ok(commands.includes('traeTokenCost.exportJson'));
  assert.equal(commands.some((id) => id.startsWith('traeToken.')), false);
});

test('默认只开启 Debugger，价格使用每百万 Token 费率', () => {
  const properties = manifest.contributes.configuration.properties;
  assert.equal(properties['traeTokenCost.cdpPort'].default, 9333);
  assert.equal(properties['traeTokenCost.captureNetwork'].default, false);
  assert.equal(properties['traeTokenCost.timingEnabled'].default, true);
  assert.equal(properties['traeTokenCost.currency'].default, 'CNY');
  assert.deepEqual(properties['traeTokenCost.modelPrices'].default, {});
  assert.deepEqual(properties['traeTokenCost.statusBar.metric'].enum, ['tokens', 'cost', 'both']);
  assert.equal(properties['traeTokenCost.creditRates'], undefined);
  assert.equal(properties['traeTokenCost.dailyCreditBudget'], undefined);
});

test('新增 defaultRange 配置项', () => {
  const properties = manifest.contributes.configuration.properties;
  const defaultRange = properties['traeTokenCost.defaultRange'];
  assert.equal(defaultRange.type, 'string');
  assert.deepEqual(defaultRange.enum, ['today', 'week', 'month', 'all']);
  assert.equal(defaultRange.default, 'today');
  assert.equal(properties['traeTokenCost.modelContextWindows'], undefined);
});

test('独立常驻采集声明并锁定 ws 生产依赖', () => {
  assert.equal(typeof manifest.dependencies?.ws, 'string');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].dependencies.ws, manifest.dependencies.ws);
  assert.equal(lock.packages['node_modules/ws'].dev, undefined);
});

test('VSIX 排除计划、旧验证材料和本地产物', () => {
  const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  assert.match(ignore, /^\.trae\/\*\*$/m);
  assert.match(ignore, /^VERIFICATION\.md$/m);
  assert.match(ignore, /^\*\.vsix$/m);
  assert.match(ignore, /^\*\.log$/m);
});

test('只读 E2E 自检使用新扩展 ID 和存储目录', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/e2e-check.mjs'), 'utf8');
  assert.match(script, /local\.trae-token-cost/);
  assert.match(script, /readArgvFile/);
  assert.doesNotMatch(script, /local\.trae-token-usage/);
});

test('README 保留上游来源和固定版本', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /shaoeric\/trae-token-usage/);
  assert.match(readme, /1720421/);
});
