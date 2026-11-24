const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts/import-bailian-pricing.py');
const dataPath = path.join(root, 'data/bailian-model-prices.json');

function loadCandidate() {
  execFileSync('python3', [script], { cwd: root, stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
}

test('官方快照生成四家族费率并保留来源哈希', () => {
  const candidate = loadCandidate();
  const source = fs.readFileSync('/tmp/bailian-model-pricing.html');
  const expectedHash = crypto.createHash('sha256').update(source).digest('hex');
  assert.equal(candidate.sourceSha256, expectedHash);
  assert.match(candidate.sourceUrl, /model-pricing/);
  assert.ok(Object.keys(candidate.modelPrices).length >= 50);
  for (const family of ['kimi', 'qwen', 'deepseek', 'glm']) {
    assert.ok(Object.keys(candidate.modelPrices).some((model) => model.toLowerCase().includes(family)), family);
  }
  assert.equal(Object.hasOwn(candidate.modelPrices, 'qwen3.8-omni-flash'), false);
});

test('关键模型价格、阶梯、峰谷和缓存口径正确', () => {
  const { modelPrices } = loadCandidate();
  assert.deepEqual(modelPrices['kimi-k3.1-pro'][0], {
    effectiveFrom: '2026-11-19', input: 13, output: 68, cacheRead: 1.3, cacheWrite: 13
  });
  const deepseek = modelPrices['deepseek-v4.1-flash-1017'][0];
  assert.equal(deepseek.peak.input, 2);
  assert.equal(deepseek.peak.output, 8);
  assert.equal(deepseek.offPeak.input, 1);
  assert.equal(deepseek.offPeak.output, 4);
  assert.equal(deepseek.offPeakStart, '22:00');
  assert.equal(deepseek.offPeakEnd, '08:00');
  assert.equal(deepseek.cacheRead, 0.04);
  assert.equal(deepseek.peak.cacheRead, 0.04);
  assert.equal(deepseek.offPeak.cacheRead, 0.02);

  const glm = modelPrices['glm-5.1'][0];
  assert.deepEqual(glm.inputTiers.map((tier) => tier.maxInputTokens), [32000, 200000]);
  assert.deepEqual(glm.inputTiers.map((tier) => tier.input), [6, 8]);
  // GLM 缓存命中费率来自官方「上下文缓存」页（北京地域）：5.3 系列 25%、5.1/5 20%（占输入单价）。
  assert.equal(modelPrices['glm-5.3'][0].cacheRead, 2);
  assert.equal(modelPrices['glm-5.3-prime'][0].cacheRead, 4);
  assert.equal(modelPrices['glm-5.2'][0].cacheRead, 2);
  assert.equal(modelPrices['glm-5.2-fast-preview'][0].cacheRead, 4);
  assert.deepEqual(glm.inputTiers.map((tier) => tier.cacheRead), [1.2, 1.6]);
  for (const tier of modelPrices['glm-5'][0].inputTiers) {
    assert.equal(tier.cacheRead, Math.round(tier.input * 0.2 * 10000) / 10000);
  }

  const qwen37 = modelPrices['qwen3.7-plus'][0];
  assert.deepEqual(qwen37.inputTiers.map((tier) => tier.input), [1.6, 4.8]);
  assert.deepEqual(qwen37.inputTiers.map((tier) => tier.output), [6.4, 19.2]);

  const qwenPlus = modelPrices['qwen-plus-2025-12-01'][0];
  assert.deepEqual(qwenPlus.inputTiers.map((tier) => tier.output), [2, 20, 48]);
  assert.deepEqual(qwenPlus.inputTiers.map((tier) => tier.reasoningOutput), [8, 24, 64]);
  assert.equal(modelPrices['qwen4-max'][0].cacheRead, 0.5);
});

test('未公开缓存命中不得猜价，限时免费与 Batch 不混入', () => {
  const { modelPrices } = loadCandidate();
  assert.equal(modelPrices['deepseek-v4-pro'][0].cacheRead, 'unknown');
  assert.equal(modelPrices['deepseek-r1-distill-qwen-1.5b'][0].input, 0);
  assert.equal(modelPrices['deepseek-r1-distill-qwen-1.5b'][0].output, 0);
  assert.equal(modelPrices['qwen-max'][0].input, 2.4);
  assert.equal(modelPrices['qwen-max'][0].output, 9.6);
  assert.equal(modelPrices['qwen3.8-max'][0].inputTiers[0].input, 12);
  assert.equal(modelPrices['qwen3.8-max'][0].inputTiers[0].output, 36);
  assert.equal(modelPrices['qwen4-max'][0].cacheWriteByTtl, undefined);
});
