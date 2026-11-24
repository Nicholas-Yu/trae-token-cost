'use strict';

/**
 * 最小 CDP（Chrome DevTools Protocol）客户端与目标发现。
 *
 * 运行时只依赖全局 `WebSocket` / `fetch`（Trae 扩展宿主 Electron 39 / Node 22.21.1
 * 以及本机开发用的 Node 24 均内置），零第三方运行时依赖。
 *
 * 契约见 docs/INTERFACES.md 第 2 节：
 *   class CdpConnection { constructor(wsUrl); async connect(); send(method, params); on(); off(); close(); }
 *   async discoverTargets({ host, port, timeoutMs }) -> { version, targets }
 */

const CONNECT_TIMEOUT_MS = 5000;
const DISCOVER_TIMEOUT_MS = 1500;
const DISCOVERY_ACCEPT = 'application/json';

function errorMessage(err) {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function toError(value, fallbackMessage) {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' && value ? value : fallbackMessage);
}

/** 从 WebSocket 的 error 事件里提取 Error（不同实现字段不同）。 */
function extractWsError(event) {
  if (event instanceof Error) return event;
  if (event && event.error instanceof Error) return event.error;
  if (event && typeof event.message === 'string' && event.message) return new Error(event.message);
  return new Error('CDP WebSocket 连接错误');
}

/** 从 WebSocket 的 message 事件里取出文本数据。 */
function extractMessageData(event) {
  if (typeof event === 'string') return event;
  if (event && typeof event === 'object' && 'data' in event) {
    const data = event.data;
    if (typeof data === 'string') return data;
    // 兼容 Buffer / ArrayBuffer（Node 的 WebSocket 文本帧始终是 string，这里仅兜底）
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
    if (Buffer.isBuffer(data)) return data.toString('utf8');
  }
  return null;
}

/**
 * 单条 CDP WebSocket 连接。
 *
 * 事件：除 'close' | 'error' 外，CDP 事件（如 'Debugger.paused'）会以事件名直接 emit，
 * 另外统一 emit 'event' ({ method, params }) 便于调试。
 */
class CdpConnection {
  /** @param {string} wsUrl 目标 webSocketDebuggerUrl */
  constructor(wsUrl, options = {}) {
    if (typeof wsUrl !== 'string' || !wsUrl) {
      throw new TypeError('CdpConnection 需要合法的 webSocketDebuggerUrl');
    }
    this.wsUrl = wsUrl;
    this.WebSocketImpl = options.WebSocketImpl || null;
    /** @type {any} */
    this._ws = null;
    this._nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function, method: string}>} */
    this._pending = new Map();
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
    this._connected = false;
    this._closed = false;
    this._closeEmitted = false;
    this._connectPromise = null;
  }

  get connected() {
    return this._connected;
  }

  get closed() {
    return this._closed;
  }

  /**
   * 建立连接；默认 5s 超时。
   * 说明：契约里的 `connect()` 无参；可选 options 为向后兼容的内部增强（仅测试/内部使用）。
   * @param {{ timeoutMs?: number }} [options]
   */
  async connect(options = {}) {
    if (this._closed) throw new Error('CDP 连接已关闭');
    if (this._connected) return this;
    if (this._connectPromise) return this._connectPromise;

    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : CONNECT_TIMEOUT_MS;
    const WS = this.WebSocketImpl || globalThis.WebSocket;
    if (typeof WS !== 'function') {
      throw new Error('当前环境不支持全局 WebSocket（需要 Node 22.21+ / Electron 39）');
    }

    this._connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let socket = null;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        fn(value);
      };

      try {
        socket = new WS(this.wsUrl);
      } catch (err) {
        finish(reject, toError(err, `无法创建 WebSocket：${this.wsUrl}`));
        return;
      }
      this._ws = socket;

      timer = setTimeout(() => {
        finish(reject, new Error(`CDP 连接超时（${timeoutMs}ms）：${this.wsUrl}`));
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      socket.addEventListener('open', () => {
        this._connected = true;
        this._emit('open', { url: this.wsUrl });
        finish(resolve, this);
      });
      socket.addEventListener('message', (event) => {
        try {
          this._handleMessage(event);
        } catch (err) {
          this._emit('error', new Error(`处理 CDP 消息失败：${errorMessage(err)}`));
        }
      });
      socket.addEventListener('error', (event) => {
        const err = extractWsError(event);
        if (!settled) finish(reject, err);
        this._emit('error', err);
      });
      socket.addEventListener('close', (event) => {
        this._handleSocketClose(event);
        if (!settled) {
          finish(reject, new Error(`CDP 连接在建立完成前被关闭：${this.wsUrl}`));
        }
      });
    });

    try {
      return await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  /**
   * 发送 CDP 命令；成功 resolve result，错误 reject。
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (this._closed) {
        reject(new Error('CDP 连接已关闭'));
        return;
      }
      const socket = this._ws;
      if (!socket || !this._connected) {
        reject(new Error(`CDP 尚未连接，无法发送 ${method}`));
        return;
      }
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject, method });
      try {
        socket.send(JSON.stringify({ id, method, params: params || {} }));
      } catch (err) {
        this._pending.delete(id);
        reject(toError(err, `发送 CDP 命令失败：${method}`));
      }
    });
  }

  /**
   * 监听事件。event 可为 CDP 事件名（'Debugger.paused'）或 'close' | 'error' | 'open' | 'event'。
   * @param {string} event
   * @param {Function} callback
   */
  on(event, callback) {
    if (typeof event !== 'string' || typeof callback !== 'function') return this;
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(callback);
    return this;
  }

  /**
   * 取消监听。callback 省略时清空该事件全部监听。
   * @param {string} event
   * @param {Function} [callback]
   */
  off(event, callback) {
    if (typeof event !== 'string') return this;
    const set = this._listeners.get(event);
    if (!set) return this;
    if (typeof callback === 'function') set.delete(callback);
    else set.clear();
    if (set.size === 0) this._listeners.delete(event);
    return this;
  }

  /** 关闭连接；挂起的 send 会 reject，并 emit 一次 'close'。 */
  close() {
    if (this._closed) return;
    this._closed = true;
    this._connected = false;
    const socket = this._ws;
    this._ws = null;
    this._failPending(new Error('CDP 连接已关闭'));
    if (socket) {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      this._emitCloseOnce({ code: null, reason: 'client-closed' });
    } else {
      this._emitCloseOnce({ code: null, reason: 'client-closed' });
    }
  }

  _handleMessage(event) {
    const text = extractMessageData(event);
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return; // 非 JSON（理论上不会出现），忽略
    }
    if (!message || typeof message !== 'object') return;

    if (typeof message.id === 'number' && this._pending.has(message.id)) {
      const pending = this._pending.get(message.id);
      this._pending.delete(message.id);
      if (message.error) {
        const err = new Error(
          typeof message.error.message === 'string' && message.error.message
            ? message.error.message
            : `CDP 命令失败：${pending.method}`
        );
        err.method = pending.method;
        if (message.error.code != null) err.code = message.error.code;
        if (message.error.data != null) err.data = message.error.data;
        pending.reject(err);
      } else {
        pending.resolve(message.result === undefined ? {} : message.result);
      }
      return;
    }

    if (typeof message.method === 'string') {
      const params = message.params && typeof message.params === 'object' ? message.params : {};
      this._emit(message.method, params);
      this._emit('event', { method: message.method, params });
    }
  }

  _handleSocketClose(event) {
    this._connected = false;
    this._closed = true;
    this._failPending(new Error('CDP 连接已关闭'));
    this._emitCloseOnce({
      code: event && event.code != null ? event.code : null,
      reason: event && typeof event.reason === 'string' ? event.reason : 'socket-closed'
    });
  }

  _failPending(err) {
    if (this._pending.size === 0) return;
    const pending = [...this._pending.values()];
    this._pending.clear();
    for (const item of pending) {
      try {
        item.reject(err);
      } catch {
        /* ignore */
      }
    }
  }

  _emitCloseOnce(payload) {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this._emit('close', payload);
  }

  _emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set || set.size === 0) return;
    for (const callback of [...set]) {
      try {
        callback(payload);
      } catch {
        // 监听器异常隔离：单条连接的事件回调失败不应影响采集主流程
      }
    }
  }
}

/**
 * 通过 HTTP 发现 CDP 目标：先 /json/version，再 /json/list。
 * @param {{ host?: string, port: number, timeoutMs?: number }} options
 * @returns {Promise<{version: object|null, targets: Array<{id:string,type:string,title:string,url:string,webSocketDebuggerUrl:string}>}>}
 */
async function discoverTargets(options = {}) {
  const host = typeof options.host === 'string' && options.host ? options.host : '127.0.0.1';
  const port = Number(options.port);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new TypeError(`discoverTargets 需要合法的 port（收到 ${String(options.port)}）`);
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DISCOVER_TIMEOUT_MS;
  const base = `http://${host}:${Math.trunc(port)}`;

  const version = await fetchJson(`${base}/json/version`, timeoutMs, '/json/version');
  const list = await fetchJson(`${base}/json/list`, timeoutMs, '/json/list');
  return { version: version && typeof version === 'object' ? version : null, targets: normalizeTargetList(list) };
}

async function fetchJson(url, timeoutMs, label) {
  const fetchFn = globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('当前环境不支持全局 fetch（需要 Node 22.21+ / Electron 39）');
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  if (controller) {
    timer = setTimeout(() => {
      try {
        controller.abort(new Error(`timeout ${label}`));
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  let response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: { accept: DISCOVERY_ACCEPT },
      ...(controller ? { signal: controller.signal } : {})
    });
  } catch (err) {
    if (controller && controller.signal.aborted) {
      throw new Error(`discoverTargets 请求超时（${timeoutMs}ms）：${label}`);
    }
    throw new Error(`discoverTargets 请求失败（${label}）：${errorMessage(err)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response || typeof response !== 'object' || response.ok !== true) {
    const status = response && response.status != null ? response.status : 'unknown';
    throw new Error(`discoverTargets 响应异常（${label}）：HTTP ${status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`discoverTargets 响应不是合法 JSON（${label}）`);
  }
}

function normalizeTargetList(list) {
  if (!Array.isArray(list)) {
    throw new Error('discoverTargets /json/list 返回的不是数组');
  }
  const targets = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const webSocketDebuggerUrl = typeof item.webSocketDebuggerUrl === 'string' ? item.webSocketDebuggerUrl : '';
    if (!webSocketDebuggerUrl) continue; // 没有调试地址的目标无法采集
    targets.push({
      id: item.id != null ? String(item.id) : '',
      type: typeof item.type === 'string' ? item.type : 'unknown',
      title: typeof item.title === 'string' ? item.title : '',
      url: typeof item.url === 'string' ? item.url : '',
      webSocketDebuggerUrl
    });
  }
  return targets;
}

module.exports = {
  CdpConnection,
  discoverTargets,
  CONNECT_TIMEOUT_MS,
  DISCOVER_TIMEOUT_MS
};
