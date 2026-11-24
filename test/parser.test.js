'use strict';

/**
 * parser.js 单元测试：JSON / SSE / 嵌套对象 / 字段别名 / 去重 / 模型名归一化 / 账单。
 * 全部使用合成 fixture，零网络。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseResponseBody,
  extractUsageEvents,
  looksLikeUsage,
  normalizeModelName,
  parseJsonValues,
  extractBillingEvents,
  endpointOfUrl
} = require('../src/capture/parser');

// ---------------------------------------------------------------------------
// normalizeModelName
// ---------------------------------------------------------------------------

test('normalizeModelName: 去空白与“正式版”后缀', () => {
  assert.equal(normalizeModelName('  DeepSeek-V3.1 正式版 '), 'DeepSeek-V3.1');
  assert.equal(normalizeModelName('Claude Sonnet 4（正式版）'), 'Claude Sonnet 4');
  assert.equal(normalizeModelName('Trae 1.0 - 正式版'), 'Trae 1.0');
  assert.equal(normalizeModelName('模型-正式版'), '模型');
  assert.equal(normalizeModelName('Qwen3-Coder 正式版'), 'Qwen3-Coder');
});

test('normalizeModelName: 空值/非字符串 -> unknown，正常名保持不变', () => {
  assert.equal(normalizeModelName(undefined), 'unknown');
  assert.equal(normalizeModelName(null), 'unknown');
  assert.equal(normalizeModelName(''), 'unknown');
  assert.equal(normalizeModelName('   '), 'unknown');
  assert.equal(normalizeModelName(123), 'unknown');
  assert.equal(normalizeModelName({}), 'unknown');
  assert.equal(normalizeModelName('GPT-5'), 'GPT-5');
  assert.equal(normalizeModelName('Kimi  K2'), 'Kimi K2');
  assert.equal(normalizeModelName('正式版'), 'unknown');
});

// ---------------------------------------------------------------------------
// JSON payload
// ---------------------------------------------------------------------------

test('parseResponseBody: 标准 OpenAI 风格 usage（prompt/completion/total）', () => {
  const body = JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model: 'Doubao-1.5-pro',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }],
    usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 }
  });
  const events = parseResponseBody(body, { url: 'https://api.trae.ai/api/chat/completions?x=1#frag' });
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.inputTokens, 120);
  assert.equal(event.outputTokens, 80);
  assert.equal(event.totalTokens, 200);
  assert.equal(event.cacheReadTokens, 0);
  assert.equal(event.cacheWriteTokens, 0);
  assert.equal(event.model, 'Doubao-1.5-pro');
  assert.equal(event.credits, null);
  assert.equal(event.source, 'network');
  assert.equal(event.endpoint, 'https://api.trae.ai/api/chat/completions');
  assert.equal(event.sessionId, null);
  assert.equal(event.messageId, null);
  assert.ok(Number.isFinite(event.observedAt));
});

test('parseResponseBody: 脱敏自定义模型 OpenAI 兼容事件包含 reasoningTokens 且用量完整', () => {
  const body = JSON.stringify({
    id: 'chatcmpl-sanitized',
    model: 'custom/local-qwen',
    choices: [{ index: 0, message: { role: 'assistant', content: 'sanitized' } }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 2,
      completion_tokens_details: { reasoning_tokens: 3 }
    }
  });
  const [event] = parseResponseBody(body, { url: 'https://example.test/v1/chat/completions' });
  assert.equal(event.model, 'custom/local-qwen');
  assert.equal(event.reasoningTokens, 3);
  assert.equal(event.usageComplete, true);
});

test('extractUsageEvents: 原始四字段缺失、NaN 或负数时 usageComplete=false', () => {
  const complete = {
    input_tokens: 8,
    output_tokens: 3,
    cache_read_input_tokens: 1,
    cache_creation_input_tokens: 0
  };
  const cases = [
    { input_tokens: undefined },
    { output_tokens: undefined },
    { cache_read_input_tokens: undefined },
    { cache_creation_input_tokens: undefined },
    { input_tokens: Number.NaN },
    { output_tokens: Number.NaN },
    { cache_read_input_tokens: Number.NaN },
    { cache_creation_input_tokens: Number.NaN },
    { input_tokens: -1 },
    { output_tokens: -1 },
    { cache_read_input_tokens: -1 },
    { cache_creation_input_tokens: -1 }
  ];
  for (const override of cases) {
    const [event] = extractUsageEvents({ usage: { ...complete, ...override } });
    assert.equal(event.usageComplete, false, JSON.stringify(override));
    assert.equal(event.reasoningTokens, null);
  }
  const [missingInput] = extractUsageEvents({ usage: { ...complete, input_tokens: undefined } });
  assert.equal(missingInput.inputTokens, 0, '归一化缺省值不应被误判为原始字段完整');
});

test('parseResponseBody: 字段别名（input_tokens/camel/嵌套 details 缓存）', () => {
  const body = JSON.stringify({
    usage: {
      input_tokens: 300,
      output_tokens: 42,
      input_tokens_details: { cached_tokens: 100 },
      cache_creation_input_tokens: 20,
      model_name: 'Claude Sonnet 4 正式版'
    }
  });
  const [event] = parseResponseBody(body);
  assert.equal(event.inputTokens, 300);
  assert.equal(event.outputTokens, 42);
  assert.equal(event.totalTokens, 342);
  assert.equal(event.cacheReadTokens, 100);
  assert.equal(event.cacheWriteTokens, 20);
  assert.equal(event.model, 'Claude Sonnet 4');
});

test('parseResponseBody: camelCase 别名 + 嵌套 response.usage 继承 model/session', () => {
  const body = JSON.stringify({
    session_id: 'sess-abc',
    response: {
      model: 'GPT-5',
      usage: { inputTokens: 11, completionTokens: 7, totalTokens: 18, cacheReadInputTokens: 3 }
    }
  });
  const [event] = parseResponseBody(body);
  assert.equal(event.inputTokens, 11);
  assert.equal(event.outputTokens, 7);
  assert.equal(event.totalTokens, 18);
  assert.equal(event.cacheReadTokens, 3);
  assert.equal(event.model, 'GPT-5');
  assert.equal(event.sessionId, 'sess-abc');
});

test('parseResponseBody: 深层嵌套对象中的 usage 与 message_id', () => {
  const body = JSON.stringify({
    code: 0,
    data: {
      session_id: 'sess-1',
      message_id: 'msg-1',
      result: {
        content: 'hello',
        llm: { usage: { prompt_tokens: 50, completion_tokens: 25, model: 'Kimi-K2' } }
      }
    }
  });
  const events = parseResponseBody(body);
  assert.equal(events.length, 1);
  assert.equal(events[0].inputTokens, 50);
  assert.equal(events[0].outputTokens, 25);
  assert.equal(events[0].model, 'Kimi-K2');
  assert.equal(events[0].sessionId, 'sess-1');
  assert.equal(events[0].messageId, 'msg-1');
});

test('parseResponseBody: 只有 total_tokens 时降级为 output', () => {
  const events = parseResponseBody(JSON.stringify({ usage: { total_tokens: 66 } }));
  assert.equal(events.length, 1);
  assert.equal(events[0].inputTokens, 0);
  assert.equal(events[0].outputTokens, 66);
  assert.equal(events[0].totalTokens, 66);
});

test('parseResponseBody: 缺字段/全零 -> 不产出事件', () => {
  assert.deepEqual(parseResponseBody(JSON.stringify({ usage: {} })), []);
  assert.deepEqual(parseResponseBody(JSON.stringify({ usage: { input_tokens: 0, output_tokens: 0 } })), []);
  assert.deepEqual(parseResponseBody(JSON.stringify({ hello: 'world' })), []);
  assert.deepEqual(parseResponseBody('not json at all'), []);
  assert.deepEqual(parseResponseBody(''), []);
  assert.deepEqual(parseResponseBody(null), []);
  assert.deepEqual(parseResponseBody(undefined), []);
});

test('parseResponseBody: fee_usage.credits 作为明确积分', () => {
  const body = JSON.stringify({
    usage: { input_tokens: 10, output_tokens: 5 },
    fee_usage: { credits: 2.25 }
  });
  const [event] = parseResponseBody(body);
  assert.equal(event.credits, 2.25);
});

test('parseResponseBody: 数组 payload（JSON 数组）产出多条', () => {
  const body = JSON.stringify([
    { usage: { input_tokens: 1, output_tokens: 2, model: 'm1' } },
    { usage: { input_tokens: 3, output_tokens: 4, model: 'm2' } }
  ]);
  const events = parseResponseBody(body);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.model).sort(), ['m1', 'm2']);
});

test('parseResponseBody: payload 内同一条用量只产出一次（数组重复）', () => {
  const usage = {
    input_tokens: 9,
    output_tokens: 4,
    model: 'same-model',
    session_id: 's',
    message_id: 'm'
  };
  const events = parseResponseBody(JSON.stringify({ data: [usage, usage, { ...usage }] }));
  assert.equal(events.length, 1);
});

test('parseResponseBody: 嵌套 JSON 字符串中的用量', () => {
  const inner = JSON.stringify({ usage: { prompt_tokens: 7, completion_tokens: 3, model: 'nested' } });
  const body = JSON.stringify({ body: inner });
  const events = parseResponseBody(body);
  assert.equal(events.length, 1);
  assert.equal(events[0].inputTokens, 7);
  assert.equal(events[0].outputTokens, 3);
  assert.equal(events[0].model, 'nested');
});

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

test('parseResponseBody: SSE 两段 usage + [DONE] + 非 JSON 行', () => {
  const sse = [
    'event: message',
    'data: {"id":"c1","usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"model":"DeepSeek-V3"}}',
    '',
    ': keep-alive comment',
    'data: not-json-at-all',
    '',
    'data: {"usage":{"input_tokens":200,"output_tokens":30,"cache_read_input_tokens":10,"model":"DeepSeek-V3"}}',
    '',
    'data: [DONE]',
    ''
  ].join('\n');
  const events = parseResponseBody(sse, { url: 'https://api.trae.ai/v1/chat' });
  assert.equal(events.length, 2);
  assert.equal(events[0].inputTokens, 100);
  assert.equal(events[0].outputTokens, 20);
  assert.equal(events[1].inputTokens, 200);
  assert.equal(events[1].outputTokens, 30);
  assert.equal(events[1].cacheReadTokens, 10);
  assert.equal(events[1].totalTokens, 230);
  assert.equal(events[0].endpoint, 'https://api.trae.ai/v1/chat');
});

test('parseResponseBody: SSE 重复相同用量块去重', () => {
  const chunk = 'data: {"usage":{"prompt_tokens":5,"completion_tokens":5,"model":"dup"}}';
  const sse = [chunk, chunk, chunk, 'data: [DONE]'].join('\n');
  assert.equal(parseResponseBody(sse).length, 1);
});

test('parseResponseBody: SSE 跨多行 data: 的 JSON 也能解析', () => {
  const sse = [
    'data: {"usage":',
    'data: {"input_tokens": 8, "output_tokens": 2}}',
    'data: [DONE]'
  ].join('\n');
  const events = parseResponseBody(sse);
  assert.equal(events.length, 1);
  assert.equal(events[0].inputTokens, 8);
  assert.equal(events[0].outputTokens, 2);
});

// ---------------------------------------------------------------------------
// extractUsageEvents / looksLikeUsage / inherited
// ---------------------------------------------------------------------------

test('extractUsageEvents: inherited 上下文生效（debugger 通道）', () => {
  const events = extractUsageEvents(
    { payload: { usage: { prompt_tokens: 12, completion_tokens: 3 } } },
    { source: 'debugger', observedAt: 1700000000000, targetId: 't1', targetTitle: 'Trae CN', model: 'Kimi 正式版' }
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'debugger');
  assert.equal(events[0].observedAt, 1700000000000);
  assert.equal(events[0].targetId, 't1');
  assert.equal(events[0].targetTitle, 'Trae CN');
  assert.equal(events[0].model, 'Kimi');
});

test('extractUsageEvents: 非对象输入零异常', () => {
  assert.deepEqual(extractUsageEvents(null), []);
  assert.deepEqual(extractUsageEvents(42), []);
  assert.deepEqual(extractUsageEvents('plain text'), []);
  assert.deepEqual(extractUsageEvents({ a: { b: null } }), []);
});

test('looksLikeUsage: 识别用量对象与嵌套 usage', () => {
  assert.equal(looksLikeUsage({ usage: { prompt_tokens: 1 } }), true);
  assert.equal(looksLikeUsage({ input_tokens: 0, output_tokens: 0 }), true);
  assert.equal(looksLikeUsage({ data: { token_usage: { total_tokens: 3 } } }), true);
  assert.equal(looksLikeUsage({ credits_float: 1.5 }), true);
  assert.equal(looksLikeUsage({ fee_usage: { credits: 0.3 } }), true);
  assert.equal(looksLikeUsage({ foo: 'bar' }), false);
  assert.equal(looksLikeUsage(null), false);
  assert.equal(looksLikeUsage([{ usage: { total_tokens: 1 } }]), true);
});

// ---------------------------------------------------------------------------
// 附加导出：parseJsonValues / extractBillingEvents / endpointOfUrl
// ---------------------------------------------------------------------------

test('parseJsonValues: JSONL 与 SSE 混合行', () => {
  const text = '{"a":1}\n{"b":2}\n';
  assert.equal(parseJsonValues(text).length, 2);
  const sse = 'event: x\ndata: {"usage":{"input_tokens":1}}\ndata: [DONE]\n';
  assert.equal(parseJsonValues(sse).length, 1);
  assert.deepEqual(parseJsonValues('  '), []);
});

test('extractBillingEvents: credits_float + session_id -> source=billing', () => {
  const body = {
    code: 0,
    data: {
      credits_float: 12.5,
      session_id: 'bill-session-1'
    }
  };
  const events = extractBillingEvents(JSON.parse(JSON.stringify(body)), { observedAt: 123 });
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.source, 'billing');
  assert.equal(event.credits, 12.5);
  assert.equal(event.billingId, 'bill-session-1');
  assert.equal(event.sessionId, 'bill-session-1');
  assert.equal(event.observedAt, 123);
  assert.equal(event.inputTokens, 0);
  assert.equal(event.outputTokens, 0);
});

test('extractBillingEvents: 带 token 与 model 的账单响应', () => {
  const body = {
    data: {
      credits_float: 3.75,
      session_id: 's2',
      usage: { input_tokens: 100, output_tokens: 50, model: 'Doubao-Seed 正式版' }
    }
  };
  const events = extractBillingEvents(body);
  assert.equal(events.length, 1);
  assert.equal(events[0].credits, 3.75);
  assert.equal(events[0].inputTokens, 100);
  assert.equal(events[0].outputTokens, 50);
  assert.equal(events[0].totalTokens, 150);
  assert.equal(events[0].model, 'Doubao-Seed');
  assert.equal(events[0].billingId, 's2');
});

test('extractBillingEvents: 无 credits 的 payload 不产出；重复 credits 去重', () => {
  assert.deepEqual(extractBillingEvents({ data: { usage: { input_tokens: 1 } } }), []);
  const dup = { credits_float: 1.5, session_id: 's' };
  const events = extractBillingEvents({ data: [dup, { ...dup }] });
  assert.equal(events.length, 1);
});

test('endpointOfUrl: 去 query 与 hash', () => {
  assert.equal(endpointOfUrl('https://api.trae.ai/api/chat?x=1#y'), 'https://api.trae.ai/api/chat');
  assert.equal(endpointOfUrl('http://127.0.0.1:9222/json/list'), 'http://127.0.0.1:9222/json/list');
  assert.equal(endpointOfUrl('/relative/path?x=1'), '/relative/path');
  assert.equal(endpointOfUrl(null), null);
  assert.equal(endpointOfUrl(''), null);
});

test('parseResponseBody: 账单 JSON 的 token 事件不丢失（credits 由 billing 通道另行标注）', () => {
  const body = JSON.stringify({
    code: 0,
    data: {
      credits_float: 6.5,
      session_id: 'bill-2',
      usage: { input_tokens: 30, output_tokens: 10 }
    }
  });
  const events = parseResponseBody(body, { url: 'https://api.trae.ai/api/get_session_usage?x=1' });
  assert.equal(events.length, 1);
  assert.equal(events[0].inputTokens, 30);
  assert.equal(events[0].outputTokens, 10);
  assert.equal(events[0].sessionId, 'bill-2');
  assert.equal(events[0].endpoint, 'https://api.trae.ai/api/get_session_usage');
});
