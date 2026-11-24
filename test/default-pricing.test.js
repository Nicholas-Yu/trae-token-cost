'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('内置百炼价格覆盖四家族并保留用户自定义覆盖', () => {
  const { mergeModelPrices } = require('../src/default-pricing');
  const defaults = mergeModelPrices({});
  for (const model of ['kimi-k3.1-pro', 'qwen-max', 'deepseek-v4-pro', 'glm-5.2']) {
    assert.ok(defaults[model], `缺少内置模型 ${model}`);
  }

  const configured = {
    'kimi-k3.1-pro': [{ effectiveFrom: '2026-01-01', input: 99, output: 199, cacheRead: 9, cacheWrite: 99 }],
    'custom/model': [{ effectiveFrom: '2026-01-01', input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }]
  };
  const merged = mergeModelPrices(configured);
  assert.equal(merged['kimi-k3.1-pro'][0].input, 99);
  assert.equal(merged['custom/model'][0].output, 2);
  assert.ok(merged['qwen-max']);
  assert.equal(configured['kimi-k3.1-pro'][0].input, 99);
});
