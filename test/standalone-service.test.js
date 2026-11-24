const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboardService } = require('../src/standalone/service');
const { makeUsageFixture } = require('./harness/standalone');

test('独立数据服务返回费用、四个范围和脱敏记录', (t) => {
  const fixture = makeUsageFixture(t);
  const service = createDashboardService(fixture);
  t.after(() => service.close());
  for (const range of ['today', 'week', 'month', 'all']) {
    const data = service.getDashboard(range);
    assert.equal(data.standalone, true);
    assert.equal(data.range, range);
    assert.equal(data.summary.total.calls, 1);
    assert.equal(data.summary.total.total_tokens, 1200);
    assert.ok(Math.abs(data.summary.total.estimated_cost - 0.00257) < 1e-12);
    assert.equal(data.recent.length, 1);
    assert.equal(data.recent[0].reasoning_tokens, 50);
    assert.equal(data.recent[0].cost_status, 'ok');
    assert.deepEqual(data.warnings, []);
    const serialized = JSON.stringify(data);
    assert.doesNotMatch(serialized, /private-session|private-message|private-host|private-window|must-not-leak/);
  }
  assert.throws(() => service.getDashboard('invalid'), /范围/);
});

test('缺失价格设置时保留 Token 并标记缺价', (t) => {
  const fixture = makeUsageFixture(t);
  const service = createDashboardService({ dbPath: fixture.dbPath, settingsPath: `${fixture.dir}/missing.json` });
  t.after(() => service.close());
  const data = service.getDashboard('all');
  assert.equal(data.summary.total.calls, 1);
  assert.equal(data.summary.total.estimated_cost, null);
  assert.equal(data.recent[0].cost_status, 'missing-price');
  assert.equal(data.warnings.length, 1);
});

test('独立服务 heatmap/默认范围与脱敏', (t) => {
  const fixture = makeUsageFixture(t);
  const fs = require('node:fs');
  const path = require('node:path');
  const settingsPath = path.join(fixture.dir, 'insights.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    'traeTokenCost.defaultRange': 'week',
    'traeTokenCost.modelPrices': { 'custom/gpt-test': [{ effectiveFrom: '2026-01-01', input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 }] }
  }));
  const service = createDashboardService({ dbPath: fixture.dbPath, settingsPath });
  t.after(() => service.close());
  const data = service.getDashboard();
  assert.equal(data.range, 'week');
  assert.equal(data.heatmap.days.length, 56);
  assert.equal(data.config.defaultRange, 'week');
  const serialized = JSON.stringify(data);
  assert.doesNotMatch(serialized, /session_key|message_key|turn_key|private-session/);
});

test('CSV 和 JSON 导出与面板使用同一公开口径', (t) => {
  const fixture = makeUsageFixture(t);
  const service = createDashboardService(fixture);
  t.after(() => service.close());
  const csv = service.exportCsv('all');
  assert.match(csv, /estimated_cost/);
  assert.match(csv, /0\.00257/);
  assert.doesNotMatch(csv, /private-session|private-host|private-window/);
  const json = service.exportJson('all');
  assert.equal(json.records[0].estimated_cost, 0.00257);
  assert.equal(json.summary.hosts.length, 0);
  assert.equal(Object.hasOwn(json.records[0], 'session_key'), false);
});
