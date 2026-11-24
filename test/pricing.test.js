'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveModelPrice, estimateUsageCost } = require('../src/pricing');

const OBSERVED_AT = Date.UTC(2026, 0, 15, 12);
const PRICE = {
  effectiveFrom: '2026-01-01',
  input: 2,
  output: 8,
  cacheRead: 0.2,
  cacheWrite: 2.5
};

function makeEvent(overrides = {}) {
  return {
    model: 'Seed-2.1-Pro',
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    observedAt: OBSERVED_AT,
    usageComplete: true,
    ...overrides
  };
}

function makePrices(versions = [PRICE]) {
  return { 'Seed-2.1-Pro': versions };
}

test('resolveModelPrice：规范化请求模型和价格设置键', () => {
  const prices = { '  Seed-2.1-Pro   正式版 ': [PRICE] };
  const resolved = resolveModelPrice(' Seed-2.1-Pro 正式版 ', prices, OBSERVED_AT);
  assert.equal(resolved, PRICE);
});

test('resolveModelPrice：从无序版本中选择请求时间之前最新生效版本', () => {
  const oldPrice = { ...PRICE, effectiveFrom: '2025-01-01', input: 1 };
  const currentPrice = { ...PRICE, effectiveFrom: '2026-01-15', input: 3 };
  const futurePrice = { ...PRICE, effectiveFrom: '2026-02-01', input: 4 };
  const prices = makePrices([futurePrice, oldPrice, currentPrice]);
  assert.equal(resolveModelPrice('Seed-2.1-Pro', prices, OBSERVED_AT), currentPrice);
});

test('resolveModelPrice：生效日前、非法生效日期和非法观测时间返回 null', () => {
  assert.equal(resolveModelPrice('Seed-2.1-Pro', makePrices(), Date.UTC(2025, 11, 31, 23, 59, 59, 999)), null);
  assert.equal(resolveModelPrice('Seed-2.1-Pro', makePrices([{ ...PRICE, effectiveFrom: '2026-02-30' }]), OBSERVED_AT), null);
  assert.equal(resolveModelPrice('Seed-2.1-Pro', makePrices([{ ...PRICE, effectiveFrom: '2026/01/01' }]), OBSERVED_AT), null);
  assert.equal(resolveModelPrice('Seed-2.1-Pro', makePrices(), Number.NaN), null);
  assert.equal(resolveModelPrice('Seed-2.1-Pro', makePrices(), Number.POSITIVE_INFINITY), null);
});

test('resolveModelPrice：无模型、空版本或无效价格设置返回 null', () => {
  assert.equal(resolveModelPrice('other-model', makePrices(), OBSERVED_AT), null);
  assert.equal(resolveModelPrice('Seed-2.1-Pro', makePrices([]), OBSERVED_AT), null);
  assert.equal(resolveModelPrice('Seed-2.1-Pro', null, OBSERVED_AT), null);
  assert.equal(resolveModelPrice('Seed-2.1-Pro', makePrices(null), OBSERVED_AT), null);
});

test('estimateUsageCost：普通输入、输出、缓存读写按百万 Token 计费', () => {
  const event = makeEvent({
    inputTokens: 1_100_000,
    outputTokens: 200_000,
    cacheReadTokens: 500_000,
    cacheWriteTokens: 100_000
  });
  const result = estimateUsageCost(event, makePrices());
  assert.equal(result.status, 'ok');
  assert.equal(result.effectiveFrom, '2026-01-01');
  assert.ok(Math.abs(result.cost - 2.95) < 1e-12);
});

test('estimateUsageCost：reasoningTokens 是输出子集，不重复收费', () => {
  const withoutReasoning = estimateUsageCost(makeEvent(), makePrices());
  const withReasoning = estimateUsageCost(makeEvent({ reasoningTokens: 90_000 }), makePrices());
  assert.deepEqual(withReasoning, withoutReasoning);
  assert.equal(withReasoning.cost, 2.8);
});

test('estimateUsageCost：费用不在单条记录上舍入', () => {
  const price = { ...PRICE, input: 1.234567, output: 0, cacheRead: 0, cacheWrite: 0 };
  const result = estimateUsageCost(makeEvent({ inputTokens: 1, outputTokens: 0 }), makePrices([price]));
  assert.deepEqual(result, {
    cost: 1.234567 / 1_000_000,
    status: 'ok',
    effectiveFrom: '2026-01-01'
  });
});

test('estimateUsageCost：零 Token 和零价格可成功计算', () => {
  const zeroPrice = { ...PRICE, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const result = estimateUsageCost(makeEvent({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  }), makePrices([zeroPrice]));
  assert.deepEqual(result, { cost: 0, status: 'ok', effectiveFrom: '2026-01-01' });
});

test('estimateUsageCost：缺少模型价格返回 missing-price', () => {
  assert.deepEqual(estimateUsageCost(makeEvent({ model: 'unknown-model' }), makePrices()), {
    cost: null,
    status: 'missing-price',
    effectiveFrom: null
  });
});

test('estimateUsageCost：任一必需 Token 字段缺失均返回 incomplete', () => {
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    const event = makeEvent();
    delete event[field];
    assert.deepEqual(estimateUsageCost(event, makePrices()), {
      cost: null,
      status: 'incomplete',
      effectiveFrom: null
    }, field);
  }
});

test('estimateUsageCost：usageComplete=false 返回 incomplete', () => {
  assert.deepEqual(estimateUsageCost(makeEvent({ usageComplete: false }), makePrices()), {
    cost: null,
    status: 'incomplete',
    effectiveFrom: null
  });
});

test('estimateUsageCost：负数、NaN、Infinity 和非数值 Token 返回 incomplete', () => {
  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
  for (const field of fields) {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, '100']) {
      const result = estimateUsageCost(makeEvent({ [field]: value }), makePrices());
      assert.equal(result.cost, null, `${field}=${value}`);
      assert.equal(result.status, 'incomplete', `${field}=${value}`);
      assert.equal(result.effectiveFrom, null, `${field}=${value}`);
    }
  }
});

test('estimateUsageCost：缓存 Token 超过总输入时普通输入为负，返回 incomplete', () => {
  const result = estimateUsageCost(makeEvent({
    inputTokens: 100,
    cacheReadTokens: 60,
    cacheWriteTokens: 41
  }), makePrices());
  assert.deepEqual(result, { cost: null, status: 'incomplete', effectiveFrom: null });
});

test('estimateUsageCost：四项价格必须全部存在且为有限非负数', () => {
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined]) {
      const invalidPrice = { ...PRICE, [field]: value };
      const result = estimateUsageCost(makeEvent(), makePrices([invalidPrice]));
      assert.deepEqual(result, {
        cost: null,
        status: 'missing-price',
        effectiveFrom: null
      }, `${field}=${value}`);
    }
  }
});

test('estimateUsageCost：不完整的用量优先于缺失价格返回 incomplete', () => {
  const result = estimateUsageCost(makeEvent({ model: 'unknown-model', inputTokens: -1 }), makePrices());
  assert.deepEqual(result, { cost: null, status: 'incomplete', effectiveFrom: null });
});
