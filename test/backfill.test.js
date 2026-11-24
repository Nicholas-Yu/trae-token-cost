'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { UsageStore } = require('../src/data/store');

function tmpdb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-backfill-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'usage.db');
}

test('backfillModels：同会话已知模型回填 unknown 行', (t) => {
  const store = new UsageStore(tmpdb(t));
  t.after(() => store.close());
  const base = { source: 'debugger', observedAt: Date.now(), hostLabel: 'gpu-host' };
  store.record({ inputTokens: 100, outputTokens: 10, model: 'unknown', sessionId: 's1', messageId: 'm1', source: 'debugger' }, { hostLabel: 'gpu-host' });
  store.record({ inputTokens: 200, outputTokens: 20, model: 'deepseek-flash', sessionId: 's1', messageId: 'm2', source: 'debugger' }, { hostLabel: 'gpu-host' });
  store.record({ inputTokens: 300, outputTokens: 30, model: 'unknown', sessionId: 's2', messageId: 'm3', source: 'debugger' }, { hostLabel: 'gpu-host' });
  assert.equal(store.backfillModels(), 1);
  const recent = store.recent({ limit: 10 }).sort((a, b) => a.id - b.id);
  const byKey = (model, input) => recent.find((r) => r.model === model && r.input_tokens === input);
  assert.ok(byKey('deepseek-flash', 100), 's1 的 unknown 行应回填为 deepseek-flash');
  assert.ok(byKey('unknown', 300), 's2 没有已知模型，保持 unknown');
  assert.equal(store.backfillModels(), 0, '重复调用幂等');
});
