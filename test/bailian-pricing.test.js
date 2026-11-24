'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { estimateUsageCost } = require('../src/pricing');

const MODEL = 'kimi-k3.1-pro';
const EFFECTIVE_AT = Date.UTC(2026, 10, 19);
// 阿里云百炼华北2（北京）按量原价，单位：元/百万 Token。
const BEIJING_PRICE = {
  effectiveFrom: '2026-11-19',
  input: 13,
  output: 68,
  cacheRead: 1.3,
  cacheWrite: 13
};
const PRICES = { [MODEL]: [BEIJING_PRICE] };

function makeEvent(overrides = {}) {
  return {
    model: MODEL,
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    observedAt: EFFECTIVE_AT,
    usageComplete: true,
    ...overrides
  };
}

test('百炼北京价格自2026-11-19生效，输入与输出按官方原价计费', () => {
  assert.deepEqual(estimateUsageCost(makeEvent(), PRICES), {
    cost: 19.8,
    status: 'ok',
    effectiveFrom: '2026-11-19'
  });
});

test('百炼价格在生效日前保持缺价，生效日零点即可使用', () => {
  assert.deepEqual(estimateUsageCost(makeEvent({ observedAt: EFFECTIVE_AT - 1 }), PRICES), {
    cost: null,
    status: 'missing-price',
    effectiveFrom: null
  });
  assert.equal(estimateUsageCost(makeEvent(), PRICES).status, 'ok');
});

test('普通输入扣除缓存读写，缓存创建按标准输入价13元计费', () => {
  const result = estimateUsageCost(makeEvent({
    inputTokens: 1_600_000,
    cacheReadTokens: 400_000,
    cacheWriteTokens: 200_000
  }), PRICES);
  assert.equal(result.status, 'ok');
  // 普通输入100万、缓存读40万、缓存写20万、输出10万。
  assert.ok(Math.abs(result.cost - (13 + 0.52 + 2.6 + 6.8)) < 1e-12);
});

test('百炼推理Token已包含在输出中，不重复计费', () => {
  const withoutReasoning = estimateUsageCost(makeEvent(), PRICES);
  const withReasoning = estimateUsageCost(makeEvent({ reasoningTokens: 80_000 }), PRICES);
  assert.deepEqual(withReasoning, withoutReasoning);
});
