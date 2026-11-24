const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageStore } = require('../../src/data/store');

function makeUsageFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-standalone-'));
  const dbPath = path.join(dir, 'usage.db');
  const settingsPath = path.join(dir, 'settings.json');
  const store = new UsageStore(dbPath);
  store.record({
    observedAt: Date.now(),
    model: 'custom/gpt-test',
    source: 'debugger',
    inputTokens: 1000,
    outputTokens: 200,
    totalTokens: 1200,
    cacheReadTokens: 600,
    cacheWriteTokens: 100,
    reasoningTokens: 50,
    usageComplete: true,
    sessionId: 'private-session',
    messageId: 'private-message',
    targetTitle: 'private-window'
  }, { hostLabel: 'private-host' });
  store.close();
  fs.writeFileSync(settingsPath, `{
    // 注释与尾逗号用于验证 JSONC
    "traeTokenCost.currency": "CNY",
    "traeTokenCost.modelPrices": {
      "custom/gpt-test": [
        {"effectiveFrom":"2026-01-01","input":2,"output":8,"cacheRead":0.2,"cacheWrite":2.5}
      ]
    },
    "secret.token": "must-not-leak"
  }`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, dbPath, settingsPath };
}

module.exports = { makeUsageFixture };
