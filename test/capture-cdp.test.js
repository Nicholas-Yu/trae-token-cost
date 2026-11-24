'use strict';

/**
 * cdp.js 测试：CdpConnection 用注入的全局 WebSocket 假实现；
 * discoverTargets 用本地临时 HTTP server（127.0.0.1 随机端口），不依赖外网。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { CdpConnection, discoverTargets } = require('../src/capture/cdp');

// ---------------------------------------------------------------------------
// 假 WebSocket
// ---------------------------------------------------------------------------

function installFakeWebSocket(behavior = {}) {
  const original = globalThis.WebSocket;
  const state = { behavior, instances: [] };

  class FakeWebSocket {
    constructor(url) {
      if (typeof behavior.throwOnConstruct === 'function' && behavior.throwOnConstruct(url)) {
        throw new Error(`假 WebSocket 构造失败：${url}`);
      }
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this._listeners = new Map();
      state.instances.push(this);
      if (behavior.openMode === 'never') return;
      if (behavior.openMode === 'error') {
        setTimeout(() => this._emit('error', { message: '假连接错误' }), 0);
        return;
      }
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
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        throw new Error('假 WebSocket 收到非 JSON 数据');
      }
      this.sent.push(message);
      if (typeof behavior.onSend === 'function') {
        setTimeout(() => {
          try {
            behavior.onSend(this, message);
          } catch (err) {
            this._emit('error', { message: err instanceof Error ? err.message : String(err) });
          }
        }, 0);
      }
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
    instances: state.instances,
    restore() {
      globalThis.WebSocket = original;
    }
  };
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
// 本地 HTTP server 工具
// ---------------------------------------------------------------------------

async function startHttpServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    port,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

// ---------------------------------------------------------------------------
// CdpConnection
// ---------------------------------------------------------------------------

test('CdpConnection: 显式 WebSocketImpl 优先于全局实现', async (t) => {
  const injected = installFakeWebSocket();
  const WebSocketImpl = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor() { throw new Error('不应使用全局 WebSocket'); }
  };
  t.after(() => injected.restore());

  const connection = new CdpConnection('ws://127.0.0.1/injected', { WebSocketImpl });
  await connection.connect();
  assert.equal(injected.instances.length, 1);
  assert.equal(injected.instances[0].url, 'ws://127.0.0.1/injected');
  connection.close();
});

test('CdpConnection: connect 后 send 往返、CDP 事件分发、off 生效', async (t) => {
  const fake = installFakeWebSocket({
    onSend: (ws, message) => ws.emitMessage({ id: message.id, result: { ok: true, method: message.method } })
  });
  t.after(() => fake.restore());

  const conn = new CdpConnection('ws://127.0.0.1:9222/devtools/page/1');
  await conn.connect();
  assert.equal(conn.connected, true);
  assert.equal(fake.instances.length, 1);

  const result = await conn.send('Runtime.enable');
  assert.deepEqual(result, { ok: true, method: 'Runtime.enable' });

  const pausedEvents = [];
  const listener = (params) => pausedEvents.push(params);
  conn.on('Debugger.paused', listener);
  fake.instances[0].emitServerEvent('Debugger.paused', { reason: 'other', callFrames: [] });
  assert.equal(pausedEvents.length, 1);
  assert.equal(pausedEvents[0].reason, 'other');

  conn.off('Debugger.paused', listener);
  fake.instances[0].emitServerEvent('Debugger.paused', { reason: 'other2' });
  assert.equal(pausedEvents.length, 1);

  conn.close();
});

test('CdpConnection: send 在连接建立前/关闭后 reject', async () => {
  const fake = installFakeWebSocket();
  try {
    const conn = new CdpConnection('ws://127.0.0.1:9222/devtools/page/2');
    await assert.rejects(() => conn.send('Runtime.enable'), /尚未连接/);
    await conn.connect({ timeoutMs: 500 });
    const pending = conn.send('Network.enable');
    conn.close();
    await assert.rejects(() => pending, /已关闭/);
    await assert.rejects(() => conn.send('Runtime.enable'), /已关闭/);
  } finally {
    fake.restore();
  }
});

test('CdpConnection: connect 超时（假连接不 open）', async (t) => {
  const fake = installFakeWebSocket({ openMode: 'never' });
  t.after(() => fake.restore());
  const conn = new CdpConnection('ws://127.0.0.1:9222/devtools/page/3');
  await assert.rejects(() => conn.connect({ timeoutMs: 40 }), /连接超时/);
  assert.equal(conn.connected, false);
});

test('CdpConnection: WebSocket error 事件导致 connect reject', async (t) => {
  const fake = installFakeWebSocket({ openMode: 'error' });
  t.after(() => fake.restore());
  const conn = new CdpConnection('ws://127.0.0.1:9222/devtools/page/4');
  await assert.rejects(() => conn.connect({ timeoutMs: 500 }), /假连接错误/);
});

test('CdpConnection: 构造 WebSocket 抛错时 connect reject', async (t) => {
  const fake = installFakeWebSocket({
    throwOnConstruct: (url) => url.includes('/bad')
  });
  t.after(() => fake.restore());
  const conn = new CdpConnection('ws://127.0.0.1:9222/devtools/page/bad');
  await assert.rejects(() => conn.connect({ timeoutMs: 500 }), /构造失败/);
});

test('CdpConnection: CDP error 响应 reject 且带 code/method', async (t) => {
  const fake = installFakeWebSocket({
    onSend: (ws, message) => ws.emitMessage({ id: message.id, error: { code: -32601, message: 'method not found' } })
  });
  t.after(() => fake.restore());
  const conn = new CdpConnection('ws://127.0.0.1:9222/devtools/page/5');
  await conn.connect();
  await assert.rejects(() => conn.send('Nope.enable'), (err) => {
    assert.match(err.message, /method not found/);
    assert.equal(err.code, -32601);
    assert.equal(err.method, 'Nope.enable');
    return true;
  });
  conn.close();
});

test('CdpConnection: close 事件只 emit 一次，挂起命令被 reject', async (t) => {
  const fake = installFakeWebSocket({
    onSend: (ws, message) => ws.emitMessage({ id: message.id, result: {} })
  });
  t.after(() => fake.restore());
  const conn = new CdpConnection('ws://127.0.0.1:9222/devtools/page/6');
  await conn.connect();
  let closeCount = 0;
  conn.on('close', () => {
    closeCount += 1;
  });
  const pending = conn.send('Debugger.enable');
  conn.close();
  await assert.rejects(() => pending, /已关闭/);
  assert.equal(closeCount, 1);
  assert.equal(conn.connected, false);
});

test('CdpConnection: 非法 wsUrl 构造抛 TypeError', () => {
  assert.throws(() => new CdpConnection(''), TypeError);
  assert.throws(() => new CdpConnection(null), TypeError);
});

// ---------------------------------------------------------------------------
// discoverTargets
// ---------------------------------------------------------------------------

test('discoverTargets: 先 /json/version 再 /json/list，返回规范化目标', async (t) => {
  const requests = [];
  let server;
  const version = { Browser: 'Trae CN/3.4.15', 'Protocol-Version': '1.3' };
  const list = [
    {
      id: 'T1',
      type: 'page',
      title: 'Trae CN — workspace',
      url: 'vscode-file://vscode-app/out/vs/code/electron-sandbox/workbench/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/T1'
    },
    { id: 'T2', type: 'service_worker', title: 'sw', url: 'https://example.test/sw.js' },
    {
      id: 'T3',
      type: 'webview',
      title: 'webview',
      url: 'https://example.test/webview',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/T3'
    }
  ];
  const started = await startHttpServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/json/version') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(version));
    } else if (req.url === '/json/list') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(list));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  server = started.server;
  t.after(() => started.close());

  const result = await discoverTargets({ host: '127.0.0.1', port: started.port, timeoutMs: 1000 });
  assert.deepEqual(result.version, version);
  assert.equal(result.targets.length, 2);
  assert.deepEqual(result.targets.map((target) => target.id), ['T1', 'T3']);
  assert.equal(result.targets[0].title, 'Trae CN — workspace');
  assert.equal(result.targets[0].type, 'page');
  assert.deepEqual(requests, ['/json/version', '/json/list']);
});

test('discoverTargets: HTTP 500 抛错', async (t) => {
  const started = await startHttpServer((req, res) => {
    res.statusCode = 500;
    res.end('oops');
  });
  t.after(() => started.close());
  await assert.rejects(
    () => discoverTargets({ port: started.port, timeoutMs: 1000 }),
    /响应异常.*HTTP 500/
  );
});

test('discoverTargets: 连接被拒抛错', async () => {
  // 先占用再释放端口，保证端口大概率无监听
  const started = await startHttpServer((req, res) => res.end('{}'));
  const { port } = started;
  await started.close();
  await assert.rejects(() => discoverTargets({ port, timeoutMs: 1000 }), /请求失败/);
});

test('discoverTargets: 超时（server 不响应）', async (t) => {
  const started = await startHttpServer(() => {
    /* 故意不响应，由 AbortController 超时 */
  });
  t.after(() => started.close());
  await assert.rejects(
    () => discoverTargets({ port: started.port, timeoutMs: 80 }),
    /请求超时/
  );
});

test('discoverTargets: /json/list 不是数组时抛错', async (t) => {
  const started = await startHttpServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/json/version' ? { Browser: 'x' } : { notAnArray: true }));
  });
  t.after(() => started.close());
  await assert.rejects(() => discoverTargets({ port: started.port, timeoutMs: 1000 }), /不是数组/);
});

test('discoverTargets: 非法 port 抛 TypeError', async () => {
  await assert.rejects(() => discoverTargets({ port: 0 }), TypeError);
  await assert.rejects(() => discoverTargets({}), TypeError);
  await assert.rejects(() => discoverTargets({ port: 70000 }), TypeError);
});
