const test = require('node:test');
const assert = require('node:assert/strict');

const {
  toPublicUsageRecord,
  decorateSummaryWithCosts,
  recordsToCsv,
  formatCost
} = require('../src/cost-view');

const observedAt = new Date(2026, 10, 19, 10, 30, 0).getTime();
const prices = {
  'custom/gpt-test': [
    { effectiveFrom: '2026-01-01', input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 }
  ]
};

function completeRow(overrides = {}) {
  return {
    observed_at: observedAt,
    model: 'custom/gpt-test',
    source: 'debugger',
    input_tokens: 1000,
    output_tokens: 200,
    total_tokens: 1200,
    cache_read_tokens: 600,
    cache_write_tokens: 100,
    reasoning_tokens: 50,
    usage_complete: 1,
    session_key: 'private-session',
    message_key: 'private-message',
    turn_key: 'private-turn',
    billing_key: 'private-billing',
    host_label: 'private-host',
    workspace_name: 'private-workspace',
    window_title: 'private-window',
    endpoint: 'https://private.example.com',
    ...overrides
  };
}

function localDay(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

test('公开记录计算现金费用并剔除内部标识', () => {
  const record = toPublicUsageRecord(completeRow(), prices, 'CNY');
  assert.equal(record.estimated_cost, 0.00257);
  assert.equal(record.cost_status, 'ok');
  assert.equal(record.currency, 'CNY');
  assert.equal(record.reasoning_tokens, 50);
  assert.equal(record.price_effective_from, '2026-01-01');
  for (const key of ['session_key', 'message_key', 'turn_key', 'billing_key', 'host_label', 'workspace_name', 'window_title', 'endpoint', 'credits']) {
    assert.equal(Object.hasOwn(record, key), false, `不应导出 ${key}`);
  }
});

test('公开记录包含耗时但不泄露网络标识', () => {
  const record = toPublicUsageRecord(completeRow({
    first_response_ms: 120,
    duration_ms: 2500,
    timing_source: 'network-inferred',
    request_id: 'private-request',
    url: 'https://private.example.com/stream'
  }), prices, 'CNY');
  assert.equal(record.first_response_ms, 120);
  assert.equal(record.duration_ms, 2500);
  assert.equal(record.timing_source, 'network-inferred');
  assert.equal(Object.hasOwn(record, 'request_id'), false);
  assert.equal(Object.hasOwn(record, 'url'), false);
  const csv = recordsToCsv([record]);
  assert.match(csv, /first_response_ms/);
  assert.match(csv, /duration_ms/);
  assert.doesNotMatch(csv, /private-request|private\.example\.com/);
});

test('耗时覆盖率、平均值和加权 TPS 按有效记录计算', () => {
  const summary = {
    total: {
      calls: 4,
      timed_calls: 2,
      first_response_timed_calls: 1,
      duration_ms_sum: 5000,
      first_response_ms_sum: 200,
      timed_output_tokens: 250
    },
    models: [],
    days: []
  };
  const result = decorateSummaryWithCosts(summary, [], prices, 'CNY');
  assert.equal(result.total.timing_coverage, 0.5);
  assert.equal(result.total.avg_duration_ms, 2500);
  assert.equal(result.total.avg_first_response_ms, 200);
  assert.equal(result.total.output_tps, 50);
});

test('费用聚合保留已定价合计并报告未定价数量', () => {
  const rows = [
    completeRow(),
    completeRow({ model: 'missing-price-model' }),
    completeRow({ usage_complete: 0 })
  ];
  const summary = {
    total: { calls: 3 },
    models: [
      { model: 'custom/gpt-test' },
      { model: 'missing-price-model' }
    ],
    days: [{ day: localDay(observedAt) }]
  };
  const decorated = decorateSummaryWithCosts(summary, rows, prices, 'CNY');
  assert.equal(decorated.total.estimated_cost, 0.00257);
  assert.equal(decorated.total.priced_calls, 1);
  assert.equal(decorated.total.unpriced_calls, 2);
  assert.equal(decorated.total.cost_complete, false);
  assert.equal(decorated.models[0].estimated_cost, 0.00257);
  assert.equal(decorated.models[1].estimated_cost, null);
  assert.equal(decorated.days[0].unpriced_calls, 2);
  assert.deepEqual(decorated.hosts, []);
});

test('无已定价记录时费用为 null，空汇总费用为零', () => {
  const summary = { total: { calls: 1 }, models: [{ model: 'unknown' }], days: [] };
  const decorated = decorateSummaryWithCosts(summary, [completeRow({ model: 'unknown' })], prices, 'CNY');
  assert.equal(decorated.total.estimated_cost, null);
  assert.equal(decorated.total.priced_calls, 0);
  const empty = decorateSummaryWithCosts({ total: { calls: 0 }, models: [], days: [] }, [], prices, 'CNY');
  assert.equal(empty.total.estimated_cost, 0);
  assert.equal(empty.total.cost_complete, true);
});

test('CSV 包含费用与完整性且不包含隐私字段', () => {
  const csv = recordsToCsv([toPublicUsageRecord(completeRow(), prices, 'CNY')]);
  assert.match(csv, /estimated_cost/);
  assert.match(csv, /usage_complete/);
  assert.match(csv, /0\.00257/);
  assert.match(csv, /2026-11-19T/);
  assert.doesNotMatch(csv, /private-session|private-host|private\.example\.com/);
});

test('formatCost 区分空值与小额费用', () => {
  assert.equal(formatCost(null, 'CNY'), '—');
  assert.equal(formatCost(0.00257, 'CNY'), 'CNY 0.002570');
  assert.equal(formatCost(12.5, 'CNY'), 'CNY 12.50');
});

test('decorate  models 带 price_hint', () => {
  const { decorateSummaryWithCosts } = require('../src/cost-view');
  const summary = { total: { calls: 1 }, models: [{ model: 'custom/gpt-test', calls: 1 }], days: [] };
  const decorated = decorateSummaryWithCosts(summary, [completeRow()], prices, 'CNY');
  assert.ok(Math.abs(decorated.total.estimated_cost - 0.00257) < 1e-12);
  const hint = decorated.models[0].price_hint;
  assert.equal(hint.input, 2);
  assert.equal(hint.output, 8);
  assert.equal(hint.tiered, false);
  assert.equal(hint.time_variant, false);
  assert.equal(hint.effective_from, '2026-01-01');
});

test('price_hint：阶梯取首档、峰谷标记、cacheRead unknown、缺价 null', () => {
  const { decorateSummaryWithCosts } = require('../src/cost-view');
  const variantPrices = {
    'custom/gpt-test': [{
      effectiveFrom: '2026-01-01',
      inputTiers: [{ min: 0, input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 }],
      peak: { input: 4, output: 16 },
      offPeak: { input: 2, output: 8 },
      offPeakStart: '00:30',
      offPeakEnd: '08:30',
      cacheRead: 'unknown'
    }]
  };
  const summary = { total: { calls: 1 }, models: [{ model: 'custom/gpt-test', calls: 1 }, { model: 'no-price', calls: 1 }], days: [] };
  const decorated = decorateSummaryWithCosts(summary, [completeRow()], variantPrices, 'CNY');
  const hint = decorated.models[0].price_hint;
  assert.equal(hint.tiered, true);
  assert.equal(hint.time_variant, true);
  assert.equal(hint.input, 2);
  assert.equal(hint.cache_read, 'unknown');
  assert.equal(decorated.models[1].price_hint, null);
});
