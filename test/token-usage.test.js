'use strict';

/**
 * ai-chat v2 token_usage 捕获（真实 Trae 3.4.16 抓包形状）单元测试。
 * 数据来源：probe-v2/paused/*.json（本地 CDP 断点抓到的 fireTokenUsageReceived 参数）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractTraeV2UsageEvents } = require('../src/capture/collector');

function usagePayload(overrides = {}) {
  return {
    sessionId: 'session-1',
    tokenUsage: {
      input: '0.000',
      output: '0.000',
      last_turn_total_tokens: 35820,
      max_tokens: 1179648,
      completion_tokens: 25,
      prompt_tokens: 35795,
      reasoning_tokens: 15,
      total_tokens: 35820,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 34816,
      prompt_tokens_total: 0,
      completion_tokens_total: 0,
      reply_to_message_id: 'reply-1',
      __packet_seq__: 10,
      ...overrides
    }
  };
}

test('extractTraeV2UsageEvents：真实 v2 tokenUsage 形状', () => {
  const models = new Map();
  const recentUsage = new Map();
  const local = { e: usagePayload() };
  const events = extractTraeV2UsageEvents(local, { models, recentUsage, inherited: { source: 'debugger' } });
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.inputTokens, 35795);
  assert.equal(ev.outputTokens, 25);
  assert.equal(ev.totalTokens, 35820);
  assert.equal(ev.cacheReadTokens, 34816);
  assert.equal(ev.cacheWriteTokens, 0);
  assert.equal(ev.reasoningTokens, 15);
  assert.equal(ev.usageComplete, true);
  assert.equal(ev.sessionId, 'session-1');
  assert.equal(ev.messageId, 'reply-1:10');
  assert.equal(ev.source, 'debugger');
  assert.equal(ev.model, 'unknown');
});

test('extractTraeV2UsageEvents：metadata 事件补 model，并用于后续 token 事件', () => {
  const models = new Map();
  const recentUsage = new Map();
  const md = extractTraeV2UsageEvents({
    e: { sessionId: 'session-1', metadata: { model: 'Seed-2.1-Pro', message_id: 'reply-1' } }
  }, { models, recentUsage });
  assert.deepEqual(md, []);
  assert.equal(models.get('session-1'), 'Seed-2.1-Pro');

  const events = extractTraeV2UsageEvents({ e: usagePayload() }, { models, recentUsage });
  assert.equal(events.length, 1);
  assert.equal(events[0].model, 'Seed-2.1-Pro');
});

test('extractTraeV2UsageEvents：同一个 token 包被多个断点命中时只产出一次', () => {
  const models = new Map();
  const recentUsage = new Map();
  const local = { e: usagePayload() };
  assert.equal(extractTraeV2UsageEvents(local, { models, recentUsage }).length, 1);
  assert.equal(extractTraeV2UsageEvents(local, { models, recentUsage }).length, 0, '重复包应被去重');
});

test('extractTraeV2UsageEvents：同一轮里不同 packet_seq 是多次 LLM 调用，分别记录', () => {
  const models = new Map();
  const recentUsage = new Map();
  const a = extractTraeV2UsageEvents({ e: usagePayload({ prompt_tokens: 109504, completion_tokens: 162, total_tokens: 109666, __packet_seq__: 16 }) }, { models, recentUsage });
  const b = extractTraeV2UsageEvents({ e: usagePayload({ prompt_tokens: 109912, completion_tokens: 1107, total_tokens: 111019, __packet_seq__: 42 }) }, { models, recentUsage });
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.notEqual(a[0].messageId, b[0].messageId);
  assert.equal(a[0].totalTokens + b[0].totalTokens, 109666 + 111019);
});

test('extractTraeV2UsageEvents：无用量的事件返回空数组且不抛错', () => {
  const models = new Map();
  const recentUsage = new Map();
  assert.deepEqual(extractTraeV2UsageEvents(null, { models, recentUsage }), []);
  assert.deepEqual(extractTraeV2UsageEvents({ e: { sessionId: 's' } }, { models, recentUsage }), []);
  assert.deepEqual(extractTraeV2UsageEvents({ e: { sessionId: 's', tokenUsage: {} } }, { models, recentUsage }), []);
});

test('extractTraeV2UsageEvents：无需外层 e 嵌套（直接传 token 事件对象）也可解析', () => {
  const models = new Map();
  const recentUsage = new Map();
  const events = extractTraeV2UsageEvents({ sessionId: 's2', tokenUsage: usagePayload().tokenUsage }, { models, recentUsage });
  assert.equal(events.length, 1);
  assert.equal(events[0].messageId, 'reply-1:10');
});

test('extractTraeV2UsageEvents：handle 闭包形状（local.t + local.e + local.r.tracking.model）', () => {
  const models = new Map();
  const recentUsage = new Map();
  const local = {
    e: {
      input: '0.000',
      output: '0.000',
      completion_tokens: 162,
      prompt_tokens: 109504,
      total_tokens: 109666,
      cache_read_input_tokens: 109184,
      cache_creation_input_tokens: 0,
      reasoning_tokens: 21,
      reply_to_message_id: 'reply-9',
      __packet_seq__: 16
    },
    t: 'session-9',
    r: {
      sessionId: 'session-9',
      tracking: { model: 'deepseek-flash', modelStrategy: 'manual', modelProviderName: 'deepseek-flash' }
    }
  };
  const events = extractTraeV2UsageEvents(local, { models, recentUsage });
  assert.equal(events.length, 1);
  assert.equal(events[0].inputTokens, 109504);
  assert.equal(events[0].outputTokens, 162);
  assert.equal(events[0].cacheReadTokens, 109184);
  assert.equal(events[0].sessionId, 'session-9');
  assert.equal(events[0].messageId, 'reply-9:16');
  assert.equal(events[0].model, 'deepseek-flash');
  assert.equal(models.get('session-9'), 'deepseek-flash');
});
