'use strict';

/**
 * collector.js 集成测试：用“假 CDP”替换全局 fetch / WebSocket，
 * 端到端驱动 TraeCollector 的轮询、断点扫描、paused 读作用域、网络响应体、WebSocket 帧兜底。
 * 全程本地、无真实 CDP / 不启动 Trae。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { TraeCollector, extractTraeV2UsageEvents } = require('../src/capture/collector');

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function waitFor(predicate, timeoutMs = 3000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (err) {
        reject(err);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`waitFor 超时：${label}`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return obj;
    }
  };
}

// ---------------------------------------------------------------------------
// 假 CDP（HTTP 发现 + WebSocket 目标）
// ---------------------------------------------------------------------------

function installFakeCdp(config = {}) {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;

  const state = {
    sockets: [],
    commands: [],
    pausedCount: 0,
    resumeCount: 0,
    getResponseBodyCalls: [],
    breakpointSeq: 0,
    pauseEmitted: false
  };

  const defaultTarget = {
    id: 'page-1',
    type: 'page',
    title: 'Trae CN — proj',
    url: 'vscode-file://vscode-app/out/vs/code/electron-sandbox/workbench/workbench.html',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/page-1'
  };
  const targets = Array.isArray(config.targets) ? config.targets : [defaultTarget];

  globalThis.fetch = async (url) => {
    if (config.discoveryError) throw new Error('fake ECONNREFUSED');
    const text = String(url);
    if (text.endsWith('/json/version')) {
      return jsonResponse({ Browser: 'Trae CN/3.4.15', 'Protocol-Version': '1.3' });
    }
    if (text.endsWith('/json/list')) return jsonResponse(targets);
    return jsonResponse({}, 404);
  };

  class FakeWebSocket {
    constructor(url) {
      if (Array.isArray(config.failUrls) && config.failUrls.some((fragment) => url.includes(fragment))) {
        throw new Error(`假 WebSocket 拒绝连接：${url}`);
      }
      this.url = url;
      this.readyState = 0;
      this._listeners = new Map();
      state.sockets.push(this);
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this._emit('open', {});
      }, 0);
    }

    addEventListener(type, callback) {
      let set = this._listeners.get(type);
      if (!set) {
        set = new Set();
        this._listeners.set(type, set);
      }
      set.add(callback);
    }

    removeEventListener(type, callback) {
      const set = this._listeners.get(type);
      if (set) set.delete(callback);
    }

    send(raw) {
      const message = JSON.parse(raw);
      state.commands.push({ url: this.url, method: message.method, params: message.params });
      setTimeout(() => {
        try {
          this._handleCommand(message);
        } catch (err) {
          this.emitMessage({ id: message.id, error: { code: -32000, message: String(err && err.message) } });
        }
        if (Array.isArray(config.closeAfterMethods) && config.closeAfterMethods.includes(message.method)) {
          setTimeout(() => this.close(), 0);
        }
      }, 0);
    }

    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this._emit('close', { code: 1000, reason: 'normal' });
    }

    emitMessage(payload) {
      this._emit('message', { data: JSON.stringify(payload) });
    }

    emitServerEvent(method, params) {
      this.emitMessage({ method, params });
    }

    _respond(message, result) {
      this.emitMessage({ id: message.id, result });
    }

    _fail(message, text) {
      this.emitMessage({ id: message.id, error: { code: -32000, message: text } });
    }

    _handleCommand(message) {
      const params = message.params || {};
      switch (message.method) {
        case 'Runtime.enable':
          this._respond(message, {});
          return;
        case 'Network.enable':
          this._respond(message, {});
          this._emitNetworkRequestStarts();
          setTimeout(() => this._emitNetworkEvents(), config.networkDelayMs != null ? config.networkDelayMs : 5);
          return;
        case 'Debugger.enable':
          this._respond(message, {});
          setTimeout(() => this._emitScriptParsedEvents(), 5);
          return;
        case 'Debugger.getScriptSource': {
          const script = (config.scripts || []).find((item) => item.scriptId === params.scriptId);
          this._respond(message, { scriptSource: script ? script.source : '' });
          return;
        }
        case 'Debugger.setBreakpoint':
        case 'Debugger.setBreakpointByUrl': {
          state.breakpointSeq += 1;
          this._respond(message, {
            breakpointId: `bp-${state.breakpointSeq}`,
            actualLocation: params.location || { lineNumber: params.lineNumber }
          });
          if (!state.pauseEmitted && config.pauseOnBreakpoint !== false) {
            state.pauseEmitted = true;
            setTimeout(() => this._emitPaused(), 5);
          }
          return;
        }
        case 'Debugger.resume':
          state.resumeCount += 1;
          this._respond(message, {});
          return;
        case 'Runtime.getProperties': {
          if (config.hangGetProperties) return; // 故意不响应，验证 1s 兜底 resume
          if (config.getPropertiesError) {
            this._fail(message, 'fake getProperties error');
            return;
          }
          const entry = (config.objects || {})[params.objectId];
          this._respond(message, { result: entry ? entry.result : [] });
          return;
        }
        case 'Network.getResponseBody': {
          state.getResponseBodyCalls.push(params.requestId);
          const entry = (config.network || []).find((item) => item.requestId === params.requestId);
          if (!entry) {
            this._fail(message, 'No resource with given identifier found');
            return;
          }
          this._respond(message, { body: entry.body, base64Encoded: Boolean(entry.base64Encoded) });
          return;
        }
        default:
          this._respond(message, {});
      }
    }

    _emitScriptParsedEvents() {
      for (const script of config.scripts || []) {
        this.emitServerEvent('Debugger.scriptParsed', {
          scriptId: script.scriptId,
          url: script.url
        });
      }
    }

    _emitNetworkRequestStarts() {
      for (const entry of config.network || []) {
        this.emitServerEvent('Network.requestWillBeSent', {
          requestId: entry.requestId,
          timestamp: entry.startTimestamp ?? 0,
          request: { url: entry.url }
        });
      }
    }

    _emitNetworkEvents() {
      for (const entry of config.network || []) {
        this.emitServerEvent('Network.responseReceived', {
          requestId: entry.requestId,
          timestamp: entry.responseTimestamp ?? entry.startTimestamp ?? 0,
          type: entry.type || 'XHR',
          response: {
            url: entry.url,
            status: entry.status != null ? entry.status : 200,
            mimeType: entry.mimeType || 'application/json'
          }
        });
        setTimeout(() => {
          this.emitServerEvent(entry.failed ? 'Network.loadingFailed' : 'Network.loadingFinished', {
            requestId: entry.requestId,
            timestamp: entry.finishTimestamp ?? entry.startTimestamp ?? 0,
            encodedDataLength: (entry.body || '').length
          });
        }, 2);
      }
      for (const frame of config.wsFrames || []) {
        setTimeout(() => {
          this.emitServerEvent('Network.webSocketFrameReceived', {
            requestId: frame.requestId || 'ws-1',
            response: { opcode: 1, mask: false, payloadData: frame.payloadData }
          });
        }, 3);
      }
    }

    _emitPaused() {
      state.pausedCount += 1;
      this.emitServerEvent('Debugger.paused', {
        reason: 'other',
        callFrames: [
          {
            callFrameId: 'cf-1',
            functionName: config.pausedFunctionName || 'reportTokenUsage',
            url: (config.scripts && config.scripts[0] && config.scripts[0].url) || 'workbench.js',
            scopeChain: [
              {
                type: 'local',
                object: { type: 'object', objectId: config.scopeObjectId || 'scope-1' }
              }
            ],
            arguments: config.pausedArguments || []
          }
        ]
      });
    }

    _emit(type, event) {
      const set = this._listeners.get(type);
      if (!set) return;
      for (const callback of [...set]) {
        try {
          callback(event);
        } catch {
          /* ignore */
        }
      }
    }
  }

  globalThis.WebSocket = FakeWebSocket;

  return {
    state,
    restore() {
      globalThis.fetch = originalFetch;
      globalThis.WebSocket = originalWebSocket;
    }
  };
}

function makeCollector(options = {}) {
  const usages = [];
  const statuses = [];
  const logs = [];
  const diagnostics = [];
  const collector = new TraeCollector({
    port: 9222,
    pollIntervalMs: 40,
    ...options,
    logger: (level, message) => logs.push({ level, message })
  });
  collector.on('usage', (event) => usages.push(event));
  collector.on('status', (status) => statuses.push(status));
  collector.on('log', (entry) => logs.push(entry));
  collector.on('diagnostic', (entry) => diagnostics.push(entry));
  return { collector, usages, statuses, logs, diagnostics };
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

test('TraeCollector: 初始状态符合契约', () => {
  const collector = new TraeCollector({ port: 9222 });
  const status = collector.getStatus();
  assert.deepEqual(status, {
    connected: false,
    targetCount: 0,
    collectorCount: 0,
    breakpointCount: 0,
    lastCaptureAt: null,
    lastError: null
  });
  collector.stop(); // 未 start 时 stop 应安全
});

test('TraeCollector: 三条通道采集（调试器断点 / 网络响应体 / WebSocket 帧）+ 账单', async (t) => {
  const usageSource = [
    'function reportTokenUsage(payload) {',
    '  const usage = payload.usage;',
    '  return usage;',
    '}'
  ].join('\n');

  const fake = installFakeCdp({
    scripts: [
      {
        scriptId: 'script-1',
        url: 'vscode-file://vscode-app/out/vs/code/electron-sandbox/workbench/workbench.html',
        source: usageSource
      }
    ],
    objects: {
      'scope-1': {
        result: [
          { name: 'e', enumerable: true, value: { type: 'object', objectId: 'event-1', description: 'Object' } },
          { name: 'messages', enumerable: true, value: { type: 'object', objectId: 'private-messages', description: 'Array' } }
        ]
      },
      'event-1': {
        result: [
          { name: 'tokenUsage', enumerable: true, value: { type: 'object', objectId: 'usage-1', description: 'Object' } },
          { name: 'sessionId', enumerable: true, value: { type: 'string', value: 'dbg-session-1' } },
          { name: 'requestHeaders', enumerable: true, value: { type: 'object', objectId: 'private-headers' } }
        ]
      },
      'usage-1': {
        result: [
          { name: 'input_tokens', enumerable: true, value: { type: 'number', value: 1234 } },
          { name: 'output_tokens', enumerable: true, value: { type: 'number', value: 567 } },
          { name: 'cache_read_input_tokens', enumerable: true, value: { type: 'number', value: 890 } },
          { name: 'cache_creation_input_tokens', enumerable: true, value: { type: 'number', value: 0 } },
          { name: 'reasoning_tokens', enumerable: true, value: { type: 'number', value: 31 } },
          { name: 'reply_to_message_id', enumerable: true, value: { type: 'string', value: 'dbg-message-1' } },
          { name: 'model', enumerable: true, value: { type: 'string', value: 'Doubao-Seed-1.6 正式版' } }
        ]
      }
    },
    network: [
      {
        requestId: 'net-chat',
        url: 'https://api.trae.ai/api/chat/completions?trace=1#x',
        status: 200,
        body: JSON.stringify({
          usage: { prompt_tokens: 100, completion_tokens: 20, model: 'Kimi-K2 正式版' }
        })
      },
      {
        requestId: 'net-billing',
        url: 'https://api.trae.ai/api/get_session_usage?x=1',
        status: 200,
        body: JSON.stringify({
          code: 0,
          data: { credits_float: 9.5, session_id: 'bill-session-1' }
        })
      },
      {
        requestId: 'net-ignored',
        url: 'https://api.trae.ai/api/user/profile',
        status: 200,
        body: JSON.stringify({ usage: { input_tokens: 999, output_tokens: 999, model: 'SHOULD-NOT-APPEAR' } })
      }
    ],
    wsFrames: [
      {
        requestId: 'ws-1',
        payloadData: 'data: {"usage":{"input_tokens":55,"output_tokens":5,"model":"WS-Model"}}'
      }
    ]
  });
  t.after(() => fake.restore());

  const { collector, usages, statuses, diagnostics, logs } = makeCollector();
  t.after(() => collector.stop());
  collector.start();

  await waitFor(
    () => usages.some((event) => event.source === 'debugger'),
    4000,
    'debugger usage'
  );
  await waitFor(() => usages.some((event) => event.source === 'billing'), 4000, 'billing usage');
  await waitFor(
    () => usages.some((event) => event.source === 'network' && event.model === 'Kimi-K2'),
    4000,
    'chat usage'
  );
  await waitFor(() => usages.some((event) => event.model === 'WS-Model'), 4000, 'ws usage');

  // ---- 调试器通道 ----
  const debuggerEvent = usages.find((event) => event.source === 'debugger');
  assert.equal(debuggerEvent.inputTokens, 1234);
  assert.equal(debuggerEvent.outputTokens, 567);
  assert.equal(debuggerEvent.totalTokens, 1801);
  assert.equal(debuggerEvent.cacheReadTokens, 890);
  assert.equal(debuggerEvent.cacheWriteTokens, 0);
  assert.equal(debuggerEvent.reasoningTokens, 31);
  assert.equal(debuggerEvent.usageComplete, true);
  assert.equal(debuggerEvent.model, 'Doubao-Seed-1.6');
  assert.equal(debuggerEvent.sessionId, 'dbg-session-1');
  assert.equal(debuggerEvent.messageId, 'dbg-message-1');
  assert.equal(debuggerEvent.targetId, 'page-1');
  assert.equal(debuggerEvent.targetTitle, 'Trae CN — proj');
  assert.ok(Number.isFinite(debuggerEvent.observedAt));
  const readObjectIds = fake.state.commands
    .filter((command) => command.method === 'Runtime.getProperties')
    .map((command) => command.params.objectId);
  assert.equal(readObjectIds.includes('private-messages'), false);
  assert.equal(readObjectIds.includes('private-headers'), false);

  // ---- 网络通道 ----
  const chatEvent = usages.find((event) => event.model === 'Kimi-K2');
  assert.equal(chatEvent.source, 'network');
  assert.equal(chatEvent.inputTokens, 100);
  assert.equal(chatEvent.outputTokens, 20);
  assert.equal(chatEvent.endpoint, 'https://api.trae.ai/api/chat/completions');
  assert.equal(chatEvent.targetId, 'page-1');

  // ---- 账单通道 ----
  const billingEvent = usages.find((event) => event.source === 'billing');
  assert.equal(billingEvent.credits, 9.5);
  assert.equal(billingEvent.billingId, 'bill-session-1');
  assert.equal(billingEvent.sessionId, 'bill-session-1');
  assert.equal(billingEvent.endpoint, 'https://api.trae.ai/api/get_session_usage');
  assert.equal(billingEvent.model, 'unknown');

  // ---- WebSocket 帧兜底 ----
  const wsEvent = usages.find((event) => event.model === 'WS-Model');
  assert.equal(wsEvent.source, 'network');
  assert.equal(wsEvent.inputTokens, 55);
  assert.equal(wsEvent.outputTokens, 5);
  assert.equal(wsEvent.endpoint, null);
  assert.equal(wsEvent.targetId, 'page-1');

  // ---- 非白名单 URL 不采集 ----
  assert.equal(usages.some((event) => event.model === 'SHOULD-NOT-APPEAR'), false);
  assert.equal(fake.state.getResponseBodyCalls.includes('net-ignored'), false);

  // ---- 命令序列 ----
  // resume 是异步发送的：等待 fake 收到 Debugger.resume，避免与断点暂停事件竞态（CI 上偶发）
  await waitFor(() => fake.state.resumeCount >= 1, 4000, 'debugger resume');
  const methods = fake.state.commands.map((command) => command.method);
  assert.ok(methods.includes('Runtime.enable'));
  assert.ok(methods.includes('Network.enable'));
  assert.ok(methods.includes('Debugger.enable'));
  assert.ok(methods.includes('Debugger.getScriptSource'));
  assert.ok(methods.includes('Debugger.setBreakpoint'));
  assert.ok(methods.includes('Runtime.getProperties'));
  assert.ok(methods.includes('Debugger.resume'));
  assert.equal(fake.state.pauseEmitted, true);
  assert.ok(fake.state.resumeCount >= 1, '正常路径至少 resume 一次');
  assert.equal(fake.state.pausedCount, 1);

  // ---- 状态 ----
  const status = collector.getStatus();
  assert.equal(status.connected, true);
  assert.equal(status.targetCount, 1);
  assert.equal(status.collectorCount, 1);
  assert.ok(status.breakpointCount >= 1, `breakpointCount=${status.breakpointCount}`);
  assert.ok(Number.isFinite(status.lastCaptureAt));
  assert.equal(status.lastError, null);
  assert.ok(statuses.some((item) => item.connected === true && item.targetCount === 1));

  // ---- 诊断/日志 ----
  assert.ok(diagnostics.some((entry) => entry.type === 'discovery'));
  assert.ok(diagnostics.some((entry) => entry.type === 'target-attached'));
  assert.ok(diagnostics.some((entry) => entry.type === 'breakpoint-set'));
  assert.ok(diagnostics.some((entry) => entry.type === 'paused' && entry.eventCount === 1));
  assert.ok(diagnostics.some((entry) => entry.type === 'network-capture'));
  assert.ok(diagnostics.some((entry) => entry.type === 'websocket-capture'));
  assert.ok(logs.some((entry) => entry.level === 'info' && /已接入 CDP 目标/.test(entry.message)));

  // 已停止后不再轮询
  collector.stop();
  const statusAfterStop = collector.getStatus();
  assert.equal(statusAfterStop.connected, false);
  assert.equal(statusAfterStop.targetCount, 0);
});

test('TraeCollector: 账单事件按 session_id 与最近用量归并（供 store 回填积分）', async (t) => {
  const fake = installFakeCdp({
    networkDelayMs: 300, // 确保调试器通道先捕获到本轮用量
    scripts: [
      {
        scriptId: 'script-1',
        url: 'vscode-file://vscode-app/out/vs/code/electron-sandbox/workbench/workbench.html',
        source: 'function reportTokenUsage(payload) {\n  return payload.usage;\n}'
      }
    ],
    objects: {
      'scope-1': {
        result: [
          { name: 'e', enumerable: true, value: { type: 'object', objectId: 'event-1' } }
        ]
      },
      'event-1': {
        result: [
          { name: 'tokenUsage', enumerable: true, value: { type: 'object', objectId: 'usage-1' } },
          { name: 'sessionId', enumerable: true, value: { type: 'string', value: 'shared-sess' } }
        ]
      },
      'usage-1': {
        result: [
          { name: 'input_tokens', enumerable: true, value: { type: 'number', value: 100 } },
          { name: 'output_tokens', enumerable: true, value: { type: 'number', value: 50 } },
          { name: 'cache_read_input_tokens', enumerable: true, value: { type: 'number', value: 20 } },
          { name: 'cache_creation_input_tokens', enumerable: true, value: { type: 'number', value: 0 } },
          { name: 'reply_to_message_id', enumerable: true, value: { type: 'string', value: 'msg-1' } },
          { name: 'model', enumerable: true, value: { type: 'string', value: 'Model-A 正式版' } }
        ]
      }
    },
    network: [
      {
        requestId: 'net-billing',
        url: 'https://api.trae.ai/api/get_session_usage',
        status: 200,
        body: JSON.stringify({ code: 0, data: { credits_float: 4.5, session_id: 'shared-sess' } })
      }
    ]
  });
  t.after(() => fake.restore());

  const { collector, usages, diagnostics } = makeCollector();
  t.after(() => collector.stop());
  collector.start();

  await waitFor(() => usages.some((event) => event.source === 'debugger'), 4000, 'debugger capture first');
  await waitFor(() => usages.some((event) => event.source === 'billing'), 4000, 'billing capture');

  const billingEvent = usages.find((event) => event.source === 'billing');
  assert.equal(billingEvent.credits, 4.5);
  assert.equal(billingEvent.billingId, 'shared-sess');
  assert.equal(billingEvent.sessionId, 'shared-sess');
  assert.equal(billingEvent.messageId, 'msg-1', '归并后带 messageId 便于 turn_key 合并');
  assert.equal(billingEvent.model, 'Model-A');
  assert.equal(billingEvent.inputTokens, 100);
  assert.equal(billingEvent.outputTokens, 50);
  assert.equal(billingEvent.totalTokens, 150);
  assert.equal(billingEvent.cacheReadTokens, 20);
  assert.ok(diagnostics.some((entry) => entry.type === 'billing-enriched'));
});

test('TraeCollector: 发现失败时优雅降级（connected=false，不崩溃）', async (t) => {
  const fake = installFakeCdp({ discoveryError: true });
  t.after(() => fake.restore());

  const { collector, statuses, logs } = makeCollector({ pollIntervalMs: 30 });
  t.after(() => collector.stop());
  collector.start();

  await waitFor(() => collector.getStatus().lastError != null, 2000, 'discovery failure recorded');
  const status = collector.getStatus();
  assert.equal(status.connected, false);
  assert.match(status.lastError, /发现失败/);
  assert.equal(status.targetCount, 0);
  assert.ok(statuses.some((item) => item.connected === false));
  assert.ok(logs.some((entry) => entry.level === 'warn' && /发现失败/.test(entry.message)));
});

test('TraeCollector: 单目标接入失败不影响其他目标', async (t) => {
  const fake = installFakeCdp({
    targets: [
      {
        id: 'page-good',
        type: 'page',
        title: 'Trae CN — good',
        url: 'vscode-file://vscode-app/workbench.html',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/page-good'
      },
      {
        id: 'page-bad',
        type: 'webview',
        title: 'bad target',
        url: 'https://example.test/webview',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/bad-refused'
      }
    ],
    failUrls: ['bad-refused'],
    scripts: [
      {
        scriptId: 'script-1',
        url: 'vscode-file://vscode-app/out/vs/code/electron-sandbox/workbench/workbench.html',
        source: 'function reportTokenUsage(payload) {\n  return payload.usage;\n}'
      }
    ],
    objects: {
      'scope-1': {
        result: [
          { name: 'e', enumerable: true, value: { type: 'object', objectId: 'event-1' } }
        ]
      },
      'event-1': {
        result: [
          { name: 'input_tokens', enumerable: true, value: { type: 'number', value: 7 } },
          { name: 'output_tokens', enumerable: true, value: { type: 'number', value: 3 } }
        ]
      }
    }
  });
  t.after(() => fake.restore());

  const { collector, usages, logs } = makeCollector();
  t.after(() => collector.stop());
  collector.start();

  await waitFor(() => usages.some((event) => event.source === 'debugger'), 4000, 'good target capture');
  const status = collector.getStatus();
  assert.equal(status.connected, true);
  assert.equal(status.targetCount, 2);
  assert.equal(status.collectorCount, 1);
  assert.ok(logs.some((entry) => entry.level === 'warn' && /接入目标失败/.test(entry.message)));
});

test('TraeCollector: 目标在初始化期间断开时优雅失败（不标 ready，不崩）', async (t) => {
  const fake = installFakeCdp({ closeAfterMethods: ['Runtime.enable'] });
  t.after(() => fake.restore());

  const { collector, logs } = makeCollector();
  t.after(() => collector.stop());
  collector.start();

  await waitFor(() => logs.some((entry) => /接入目标失败/.test(entry.message)), 3000, 'attach failure logged');
  const status = collector.getStatus();
  assert.equal(status.connected, true);
  assert.equal(status.targetCount, 1);
  assert.equal(status.collectorCount, 0);
  assert.equal(status.lastError, null);
});

test('TraeCollector: getProperties 抛错时 finally 仍强制 resume，不产出事件', async (t) => {
  const fake = installFakeCdp({
    getPropertiesError: true,
    scripts: [
      {
        scriptId: 'script-1',
        url: 'vscode-file://vscode-app/out/vs/code/electron-sandbox/workbench/workbench.html',
        source: 'function reportTokenUsage(payload) {\n  return payload.usage;\n}'
      }
    ],
    objects: {
      'scope-1': { result: [] }
    }
  });
  t.after(() => fake.restore());

  const { collector, usages, logs } = makeCollector();
  t.after(() => collector.stop());
  collector.start();

  await waitFor(() => fake.state.resumeCount >= 1, 3000, 'resume after error');
  assert.equal(fake.state.resumeCount, 1);
  assert.equal(usages.length, 0);
  assert.ok(logs.some((entry) => entry.level === 'warn' && /读取断点作用域失败/.test(entry.message)));
});

test('TraeCollector: getProperties 永久挂起时兜底 resume', async (t) => {
  const fake = installFakeCdp({
    hangGetProperties: true,
    scripts: [
      {
        scriptId: 'script-1',
        url: 'vscode-file://vscode-app/out/vs/code/electron-sandbox/workbench/workbench.html',
        source: 'function reportTokenUsage(payload) {\n  return payload.usage;\n}'
      }
    ],
    objects: {
      'scope-1': { result: [] }
    }
  });
  t.after(() => fake.restore());

  const { collector, logs } = makeCollector();
  t.after(() => collector.stop());
  collector.start();

  await waitFor(() => fake.state.resumeCount >= 1, 4000, 'fallback resume');
  assert.ok(logs.some((entry) => entry.level === 'warn' && /强制 Debugger\.resume/.test(entry.message)));
});

test('TraeCollector: v1 只读取白名单参数并保留用量与模型关联', async (t) => {
  const fake = installFakeCdp({
    pausedArguments: [
      { type: 'object', objectId: 'v1-usage' },
      { type: 'object', objectId: 'v1-context' }
    ],
    scripts: [
      {
        scriptId: 'script-v1',
        url: 'https://example.test/workbench.js',
        source: 'function reportTokenUsage(usage, context) { return usage; }'
      }
    ],
    objects: {
      'scope-1': {
        result: [
          { name: 'chatTranscript', enumerable: true, value: { type: 'object', objectId: 'private-v1-transcript' } }
        ]
      },
      'v1-usage': {
        result: [
          { name: 'prompt_tokens', enumerable: true, value: { type: 'number', value: 40 } },
          { name: 'completion_tokens', enumerable: true, value: { type: 'number', value: 9 } },
          { name: 'cache_read_input_tokens', enumerable: true, value: { type: 'number', value: 4 } },
          { name: 'cache_creation_input_tokens', enumerable: true, value: { type: 'number', value: 0 } },
          { name: 'reasoning_tokens', enumerable: true, value: { type: 'number', value: 2 } },
          { name: 'toolArguments', enumerable: true, value: { type: 'object', objectId: 'private-v1-tools' } }
        ]
      },
      'v1-context': {
        result: [
          { name: 'sessionId', enumerable: true, value: { type: 'string', value: 'v1-session' } },
          { name: 'agentMessageId', enumerable: true, value: { type: 'string', value: 'v1-message' } },
          { name: 'chatFirstTokenPayload', enumerable: true, value: { type: 'object', objectId: 'v1-first-token' } },
          { name: 'requestHeaders', enumerable: true, value: { type: 'object', objectId: 'private-v1-headers' } }
        ]
      },
      'v1-first-token': {
        result: [
          { name: 'model', enumerable: true, value: { type: 'string', value: 'Custom-Sanitized' } },
          { name: 'messages', enumerable: true, value: { type: 'object', objectId: 'private-v1-messages' } }
        ]
      }
    }
  });
  t.after(() => fake.restore());
  const { collector, usages } = makeCollector();
  t.after(() => collector.stop());
  collector.start();

  await waitFor(() => usages.some((event) => event.source === 'debugger'), 4000, 'v1 whitelist capture');
  const [event] = usages;
  assert.equal(event.model, 'Custom-Sanitized');
  assert.equal(event.sessionId, 'v1-session');
  assert.equal(event.messageId, 'v1-message');
  assert.equal(event.reasoningTokens, 2);
  assert.equal(event.usageComplete, true);
  const readObjectIds = fake.state.commands
    .filter((command) => command.method === 'Runtime.getProperties')
    .map((command) => command.params.objectId);
  for (const privateId of ['private-v1-transcript', 'private-v1-tools', 'private-v1-headers', 'private-v1-messages']) {
    assert.equal(readObjectIds.includes(privateId), false, `${privateId} 不应被读取`);
  }
});

test('TraeCollector: 未知 paused 结构不做通用遍历且诊断不含原始值', async (t) => {
  const fake = installFakeCdp({
    pausedFunctionName: 'minifiedUnknown',
    pausedArguments: [{ type: 'object', objectId: 'private-argument' }],
    scripts: [
      {
        scriptId: 'script-unknown',
        url: 'https://example.test/workbench.js?access_token=private-url-token',
        source: 'function fireTokenUsageReceived(payload) { return payload; }'
      }
    ],
    objects: {
      'scope-1': {
        result: [
          { name: 'payload', enumerable: true, value: { type: 'object', objectId: 'private-payload' } },
          { name: 'authorization', enumerable: true, value: { type: 'string', value: 'Bearer private-secret' } }
        ]
      },
      'private-payload': {
        result: [
          { name: 'usage', enumerable: true, value: { type: 'object', objectId: 'private-usage' } },
          { name: 'content', enumerable: true, value: { type: 'string', value: 'private chat content' } }
        ]
      },
      'private-usage': {
        result: [
          { name: 'input_tokens', enumerable: true, value: { type: 'number', value: 99 } },
          { name: 'output_tokens', enumerable: true, value: { type: 'number', value: 9 } }
        ]
      }
    }
  });
  t.after(() => fake.restore());
  const { collector, usages, diagnostics } = makeCollector();
  t.after(() => collector.stop());
  collector.start();

  await waitFor(() => diagnostics.some((entry) => entry.type === 'paused'), 4000, 'unknown paused diagnostic');
  await waitFor(() => fake.state.resumeCount >= 1, 4000, 'unknown paused resume');
  assert.equal(usages.length, 0);
  const readObjectIds = fake.state.commands
    .filter((command) => command.method === 'Runtime.getProperties')
    .map((command) => command.params.objectId);
  assert.deepEqual(readObjectIds, ['scope-1']);
  const paused = diagnostics.find((entry) => entry.type === 'paused');
  assert.equal(paused.eventCount, 0);
  assert.equal(paused.functionName, 'minifiedUnknown');
  assert.equal(paused.url, undefined);
  assert.match(paused.scriptUrlHash, /^[a-f0-9]{16}$/);
  const diagnosticText = JSON.stringify(paused);
  assert.equal(diagnosticText.includes('private-secret'), false);
  assert.equal(diagnosticText.includes('private-url-token'), false);
  assert.equal(diagnosticText.includes('private chat content'), false);
});

function makeTimingFixture(network, networkDelayMs = 0) {
  return {
    networkDelayMs,
    network,
    scripts: [{
      scriptId: 'script-1',
      url: 'workbench.js',
      source: 'function reportTokenUsage(payload) { return payload.usage; }'
    }],
    objects: {
      'scope-1': {
        result: [{ name: 'e', enumerable: true, value: { type: 'object', objectId: 'event-1' } }]
      },
      'event-1': {
        result: [
          { name: 'tokenUsage', enumerable: true, value: { type: 'object', objectId: 'usage-1' } },
          { name: 'sessionId', enumerable: true, value: { type: 'string', value: 'dbg-session-1' } }
        ]
      },
      'usage-1': {
        result: [
          { name: 'input_tokens', enumerable: true, value: { type: 'number', value: 1000 } },
          { name: 'output_tokens', enumerable: true, value: { type: 'number', value: 200 } },
          { name: 'cache_read_input_tokens', enumerable: true, value: { type: 'number', value: 100 } },
          { name: 'cache_creation_input_tokens', enumerable: true, value: { type: 'number', value: 50 } },
          { name: 'reasoning_tokens', enumerable: true, value: { type: 'number', value: 10 } },
          { name: 'reply_to_message_id', enumerable: true, value: { type: 'string', value: 'dbg-message-1' } },
          { name: 'model', enumerable: true, value: { type: 'string', value: 'custom/gpt-test' } }
        ]
      }
    }
  };
}

function timingRequest(requestId, overrides = {}) {
  return {
    requestId,
    url: 'https://api.example.com/chat/completions',
    body: '{}',
    startTimestamp: 100,
    responseTimestamp: 100.12,
    finishTimestamp: 102.5,
    ...overrides
  };
}

test('网络耗时：完成事件先到时唯一候选直接关联且不读正文', async (t) => {
  const fake = installFakeCdp(makeTimingFixture([timingRequest('timing-1')]));
  const app = makeCollector({ networkEnabled: false, timingEnabled: true });
  t.after(() => { app.collector.stop(); fake.restore(); });
  app.collector.start();
  await waitFor(() => app.usages.some((event) => event.durationMs === 2500));
  const event = app.usages.find((item) => item.durationMs === 2500);
  assert.equal(event.firstResponseMs, 120);
  assert.equal(event.timingSource, 'network-inferred');
  assert.equal(event.sessionId, 'dbg-session-1');
  assert.equal(event.messageId, 'dbg-message-1');
  assert.equal(Object.hasOwn(event, 'requestId'), false);
  assert.equal(Object.hasOwn(event, 'url'), false);
  assert.equal(fake.state.getResponseBodyCalls.length, 0);
});

test('网络耗时：usage 先到时完成后发送去重补充事件', async (t) => {
  const fake = installFakeCdp(makeTimingFixture([timingRequest('timing-1')], 200));
  const app = makeCollector({ networkEnabled: false, timingEnabled: true });
  t.after(() => { app.collector.stop(); fake.restore(); });
  app.collector.start();
  await waitFor(() => app.usages.some((event) => event.durationMs === 2500));
  assert.equal(app.usages.filter((event) => event.durationMs === 2500).length, 1);
  assert.equal(fake.state.getResponseBodyCalls.length, 0);
});

test('网络耗时：多候选和失败请求均不错配', async (t) => {
  const fake = installFakeCdp(makeTimingFixture([
    timingRequest('timing-1'),
    timingRequest('timing-2'),
    timingRequest('timing-3', { failed: true })
  ]));
  const app = makeCollector({ networkEnabled: false, timingEnabled: true });
  t.after(() => { app.collector.stop(); fake.restore(); });
  app.collector.start();
  await waitFor(() => app.usages.length > 0);
  assert.equal(app.usages.every((event) => event.durationMs == null), true);
  assert.equal(fake.state.getResponseBodyCalls.length, 0);
});

test('网络耗时：辅助接口与查询参数不误判为生成请求', async (t) => {
  const fake = installFakeCdp(makeTimingFixture([
    timingRequest('usage-aux', { url: 'https://api.example.com/api/get_session_usage' }),
    timingRequest('plugins', { url: 'https://api.example.com/api/remote/v1/plugins?plugin=chat' }),
    timingRequest('generation', { url: 'https://api.example.com/api/commercial/v1/chat/completions?trace=1' })
  ]));
  const app = makeCollector({ networkEnabled: false, timingEnabled: true });
  t.after(() => { app.collector.stop(); fake.restore(); });
  app.collector.start();
  await waitFor(() => app.usages.some((event) => event.durationMs === 2500));
  assert.equal(app.usages.filter((event) => event.durationMs === 2500).length, 1);
  assert.equal(fake.state.getResponseBodyCalls.length, 0);
});

test('网络耗时：未完成请求不附带半截耗时，改配后只携带新请求完整耗时', () => {
  const { collector } = makeCollector({ networkEnabled: false, timingEnabled: true });
  const session = collector._createSession({
    id: 'target-timing',
    type: 'page',
    title: 'timing',
    url: '',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/timing'
  });
  const usage = {
    source: 'debugger',
    targetId: session.id,
    model: 'custom/gpt-test',
    sessionId: 's-1',
    messageId: 'm-1',
    inputTokens: 100,
    outputTokens: 10
  };
  collector._onTimingRequest(session, { requestId: 'A', timestamp: 100, request: { url: 'https://api.example.com/v1/chat/completions' } });
  collector._onTimingResponse(session, { requestId: 'A', timestamp: 100.275 });
  const firstAttach = collector._attachTiming(session, usage);
  // 请求未完成时不得把首响应单独挂到 usage 上，避免与其他请求的总耗时跨请求拼接。
  assert.equal(firstAttach.firstResponseMs ?? null, null);
  assert.equal(firstAttach.durationMs ?? null, null);

  collector._onTimingFinished(session, { requestId: 'A', timestamp: 101 }, true);
  collector._onTimingRequest(session, { requestId: 'B', timestamp: 102, request: { url: 'https://api.example.com/v1/chat/completions' } });
  collector._onTimingResponse(session, { requestId: 'B', timestamp: 102.15 });
  collector._onTimingFinished(session, { requestId: 'B', timestamp: 102.212 }, false);
  const secondAttach = collector._attachTiming(session, { ...usage, outputTokens: 20 });
  assert.equal(secondAttach.firstResponseMs, 150);
  assert.equal(secondAttach.durationMs, 212);
  assert.equal(secondAttach.timingSource, 'network-inferred');
  collector.stop();
});

// ---------------------------------------------------------------------------
// 服务端耗时（debugger-inferred）：Agent/SSH 模式生成请求不经本机渲染进程，
// 从断点 tracking.serverTimingEvents 读取 Trae 回传的逐调用服务端耗时。
// ---------------------------------------------------------------------------

function v2UsageLocal(sessionId, overrides = {}) {
  return {
    e: {
      sessionId,
      tokenUsage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        total_tokens: 1200,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
        reply_to_message_id: 'msg-1',
        __packet_seq__: 1,
        ...overrides
      }
    }
  };
}

test('服务端耗时：handle 帧缓存 tracking，定义帧 usage 事件附带逐调用耗时', () => {
  const trackings = new Map();
  // handle 帧：只有 r（stream 上下文），无 e → 不产出 usage，但缓存服务端耗时。
  const handleEvents = extractTraeV2UsageEvents({
    r: {
      sessionId: 's-timing',
      tracking: {
        serverTimingEvents: { server_processing_time: 3257, platform_first_token_timing: 2005, name: 'llm_raw_chat_v2' }
      }
    }
  }, { trackings });
  assert.deepEqual(handleEvents, []);
  assert.equal(trackings.has('s-timing'), true);

  // 定义帧：只有 e（usage payload）→ 从缓存取同会话服务端耗时。
  const events = extractTraeV2UsageEvents(v2UsageLocal('s-timing'), { trackings });
  assert.equal(events.length, 1);
  assert.equal(events[0].durationMs, 3257);
  assert.equal(events[0].firstResponseMs, 2005);
  assert.equal(events[0].timingSource, 'debugger-inferred');
});

test('服务端耗时：同帧含 e 与 r.tracking 时直接附带', () => {
  const local = v2UsageLocal('s-both');
  local.r = {
    sessionId: 's-both',
    tracking: { serverTimingEvents: { server_processing_time: 2844, platform_first_token_timing: 2074 } }
  };
  const events = extractTraeV2UsageEvents(local, { trackings: new Map() });
  assert.equal(events.length, 1);
  assert.equal(events[0].durationMs, 2844);
  assert.equal(events[0].firstResponseMs, 2074);
  assert.equal(events[0].timingSource, 'debugger-inferred');
});

test('服务端耗时：缺失/非法/零值不附带，陈旧缓存不跨调用错配', () => {
  // 缺失 serverTimingEvents → 无耗时。
  const none = extractTraeV2UsageEvents(v2UsageLocal('s-none'), { trackings: new Map() });
  assert.equal(none[0].durationMs ?? null, null);
  assert.equal(none[0].timingSource ?? null, null);

  // 零值/负数/非数值 → 对应字段为 null，不写 timingSource。
  const trackings = new Map();
  extractTraeV2UsageEvents({
    r: { sessionId: 's-bad', tracking: { serverTimingEvents: { server_processing_time: 0, platform_first_token_timing: -5 } } }
  }, { trackings });
  const bad = extractTraeV2UsageEvents(v2UsageLocal('s-bad'), { trackings });
  assert.equal(bad[0].durationMs ?? null, null);
  assert.equal(bad[0].firstResponseMs ?? null, null);
  assert.equal(bad[0].timingSource ?? null, null);

  // 只有首响应有效时允许半对（同一调用同一来源，不存在跨请求拼接）。
  const trackings2 = new Map();
  extractTraeV2UsageEvents({
    r: { sessionId: 's-half', tracking: { serverTimingEvents: { platform_first_token_timing: 1800 } } }
  }, { trackings: trackings2 });
  const half = extractTraeV2UsageEvents(v2UsageLocal('s-half'), { trackings: trackings2 });
  assert.equal(half[0].firstResponseMs, 1800);
  assert.equal(half[0].durationMs ?? null, null);
  assert.equal(half[0].timingSource, 'debugger-inferred');

  // 陈旧缓存（超过新鲜窗口）→ 不附带，避免把上一次调用的耗时错配给新调用。
  const stale = new Map();
  stale.set('s-stale', { at: Date.now() - 60 * 1000, serverTimingEvents: { server_processing_time: 9999, platform_first_token_timing: 999 } });
  const staleEvents = extractTraeV2UsageEvents(v2UsageLocal('s-stale'), { trackings: stale });
  assert.equal(staleEvents[0].durationMs ?? null, null);
  assert.equal(staleEvents[0].timingSource ?? null, null);
});

test('网络耗时：OPTIONS 预检不算生成候选，0ms 完成不附带', () => {
  const { collector } = makeCollector({ networkEnabled: false, timingEnabled: true });
  const session = collector._createSession({
    id: 'target-preflight', type: 'page', title: 'preflight', url: '',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/preflight'
  });
  const usage = {
    source: 'debugger', targetId: session.id, model: 'm', sessionId: 's-p', messageId: 'm-p',
    inputTokens: 100, outputTokens: 10
  };
  // 预检请求瞬时完成（0ms），不得成为耗时候选。
  collector._onTimingRequest(session, { requestId: 'OPT', timestamp: 100, request: { method: 'OPTIONS', url: 'https://api.example.com/v1/chat/completions' } });
  collector._onTimingResponse(session, { requestId: 'OPT', timestamp: 100 });
  collector._onTimingFinished(session, { requestId: 'OPT', timestamp: 100 }, false);
  assert.equal(session.timing.size, 0);

  // 0ms 的 POST（异常/缓存命中）同样不附带耗时。
  collector._onTimingRequest(session, { requestId: 'ZERO', timestamp: 200, request: { method: 'POST', url: 'https://api.example.com/v1/chat/completions' } });
  collector._onTimingResponse(session, { requestId: 'ZERO', timestamp: 200 });
  collector._onTimingFinished(session, { requestId: 'ZERO', timestamp: 200 }, false);
  const attached = collector._attachTiming(session, usage);
  assert.equal(attached.durationMs ?? null, null);
  assert.equal(attached.firstResponseMs ?? null, null);
  assert.equal(attached.timingSource ?? null, null);
  collector.stop();
});

test('TraeCollector: 关闭 debugger/network 通道时只发 Runtime.enable', async (t) => {
  const fake = installFakeCdp({
    targets: [
      {
        id: 'page-1',
        type: 'page',
        title: 'Trae CN',
        url: 'vscode-file://vscode-app/workbench.html',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/page-1'
      }
    ]
  });
  t.after(() => fake.restore());

  const { collector, statuses } = makeCollector({ debuggerEnabled: false, networkEnabled: false, timingEnabled: false });
  t.after(() => collector.stop());
  collector.start();

  await waitFor(() => statuses.some((item) => item.collectorCount === 1), 3000, 'target attached');
  const methods = fake.state.commands.map((command) => command.method);
  assert.ok(methods.includes('Runtime.enable'));
  assert.equal(methods.includes('Network.enable'), false);
  assert.equal(methods.includes('Debugger.enable'), false);
});

test('TraeCollector: stop 幂等且清理定时器', async (t) => {
  const fake = installFakeCdp();
  t.after(() => fake.restore());
  const { collector } = makeCollector();
  collector.start();
  await delay(100);
  collector.stop();
  collector.stop();
  assert.equal(collector.getStatus().connected, false);
});
