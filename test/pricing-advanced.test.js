const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateUsageCost } = require('../src/pricing');

function event(overrides = {}) {
  return {
    model: 'custom/model',
    inputTokens: 1000,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    observedAt: Date.UTC(2026, 0, 15, 4),
    usageComplete: true,
    ...overrides
  };
}

function prices(version) {
  return { 'custom/model': [version] };
}

test('输入阶梯按总输入选档且非分段累进', () => {
  const version = {
    effectiveFrom: '2026-01-01',
    cacheRead: 0.2,
    inputTiers: [
      { maxInputTokens: 1000, input: 2, output: 8 },
      { maxInputTokens: 2000, input: 4, output: 12 }
    ]
  };
  const atBoundary = estimateUsageCost(event(), prices(version));
  assert.equal(atBoundary.status, 'ok');
  assert.equal(atBoundary.cost, (1000 * 2 + 10 * 8) / 1e6);
  const nextTier = estimateUsageCost(event({ inputTokens: 1001 }), prices(version));
  assert.equal(nextTier.cost, (1001 * 4 + 10 * 12) / 1e6);
});

test('缓存参与总输入选档，创建价默认同档输入价', () => {
  const version = {
    effectiveFrom: '2026-01-01',
    cacheRead: 0.2,
    inputTiers: [
      { maxInputTokens: 1000, input: 2, output: 8 },
      { maxInputTokens: 2000, input: 4, output: 12 }
    ]
  };
  const result = estimateUsageCost(event({
    inputTokens: 1001,
    cacheReadTokens: 100,
    cacheWriteTokens: 100
  }), prices(version));
  assert.equal(result.status, 'ok');
  assert.equal(result.cost, (801 * 4 + 10 * 12 + 100 * 0.2 + 100 * 4) / 1e6);
});

test('思考输出价只在 reasoningTokens 大于零时使用', () => {
  const version = {
    effectiveFrom: '2026-01-01',
    cacheRead: 0.2,
    inputTiers: [{ maxInputTokens: 1000, input: 2, output: 4, reasoningOutput: 10 }]
  };
  const plain = estimateUsageCost(event(), prices(version));
  const reasoning = estimateUsageCost(event({ reasoningTokens: 5 }), prices(version));
  assert.equal(plain.cost, (1000 * 2 + 10 * 4) / 1e6);
  assert.equal(reasoning.cost, (1000 * 2 + 10 * 10) / 1e6);
});

test('北京时间峰谷价格支持跨日和边界', () => {
  const version = {
    effectiveFrom: '2026-01-01',
    input: 2,
    output: 8,
    cacheRead: 0.2,
    cacheWrite: 2,
    peak: { input: 2, output: 8 },
    offPeak: { input: 1, output: 4 },
    offPeakStart: '22:00',
    offPeakEnd: '08:00'
  };
  const peak = estimateUsageCost(event({ observedAt: Date.UTC(2026, 0, 15, 3) }), prices(version));
  const valley = estimateUsageCost(event({ observedAt: Date.UTC(2026, 0, 15, 14) }), prices(version));
  const midnight = estimateUsageCost(event({ observedAt: Date.UTC(2026, 0, 15, 16) }), prices(version));
  assert.equal(peak.cost, (1000 * 2 + 10 * 8) / 1e6);
  assert.equal(valley.cost, (1000 * 1 + 10 * 4) / 1e6);
  assert.equal(midnight.cost, valley.cost);
});

test('峰谷缓存读取价分别参与费用估算', () => {
  const version = {
    effectiveFrom: '2026-01-01',
    input: 2,
    output: 8,
    cacheRead: 0.04,
    cacheWrite: 2,
    peak: { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 2 },
    offPeak: { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 1 },
    offPeakStart: '22:00',
    offPeakEnd: '08:00'
  };
  const usage = { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 500 };
  const peak = estimateUsageCost(event({ ...usage, observedAt: Date.UTC(2026, 0, 15, 3) }), prices(version));
  const valley = estimateUsageCost(event({ ...usage, observedAt: Date.UTC(2026, 0, 15, 14) }), prices(version));
  assert.equal(peak.status, 'ok');
  assert.equal(peak.cost, (500 * 2 + 10 * 8 + 500 * 0.04) / 1e6);
  assert.equal(valley.status, 'ok');
  assert.equal(valley.cost, (500 * 1 + 10 * 4 + 500 * 0.02) / 1e6);
});

test('显式缓存支持5m和1h创建价', () => {
  const version = {
    effectiveFrom: '2026-01-01',
    input: 10,
    output: 30,
    cacheRead: 0.5,
    cacheWriteByTtl: { '5m': 12.5, '1h': 20 }
  };
  const five = estimateUsageCost(event({ cacheWriteTokens: 100 }), prices(version));
  const oneHour = estimateUsageCost(event({ cacheWriteTokens: 100, cacheTtl: '1h' }), prices({ ...version, cacheTtl: '1h' }));
  assert.equal(five.cost, (900 * 10 + 10 * 30 + 100 * 12.5) / 1e6);
  assert.equal(oneHour.cost, (900 * 10 + 10 * 30 + 100 * 20) / 1e6);
});

test('未知缓存命中费率仅在真实命中时拒绝计价', () => {
  const version = { effectiveFrom: '2026-01-01', input: 2, output: 8, cacheRead: 'unknown', cacheWrite: 2 };
  const noHit = estimateUsageCost(event(), prices(version));
  const hit = estimateUsageCost(event({ cacheReadTokens: 1 }), prices(version));
  assert.equal(noHit.status, 'ok');
  assert.equal(hit.status, 'missing-price');
});

test('无效阶梯、超档和峰谷配置返回 missing-price', () => {
  const invalid = { effectiveFrom: '2026-01-01', cacheRead: 0.2, inputTiers: [{ maxInputTokens: 1000, input: 2, output: 8 }] };
  assert.equal(estimateUsageCost(event({ inputTokens: 1001 }), prices(invalid)).status, 'missing-price');
  const unordered = { effectiveFrom: '2026-01-01', cacheRead: 0.2, inputTiers: [{ maxInputTokens: 2000, input: 2, output: 8 }, { maxInputTokens: 1000, input: 4, output: 12 }] };
  assert.equal(estimateUsageCost(event(), prices(unordered)).status, 'missing-price');
  const badPeak = { effectiveFrom: '2026-01-01', input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2, peak: { input: 2, output: 8 }, offPeak: { input: 1, output: 4 } };
  assert.equal(estimateUsageCost(event(), prices(badPeak)).status, 'missing-price');
});

test('用量异常仍优先返回 incomplete', () => {
  const result = estimateUsageCost(event({ inputTokens: -1 }), { 'other/model': [] });
  assert.equal(result.status, 'incomplete');
});
