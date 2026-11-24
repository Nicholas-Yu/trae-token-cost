#!/usr/bin/env node
/**
 * M0 探针：连接 Trae 本机 CDP（--remote-debugging-port），
 * 枚举 targets、抓脚本、在 reportTokenUsage 上打断点、抓网络响应体与 WebSocket 帧。
 *
 * 用法：node scripts/probe-cdp.mjs --port 9222 --out probe-output --seconds 600
 * 输出：probe-output/{targets.json,scripts.json,events.ndjson,log.txt,bodies/,scripts/}
 * 该脚本只读，不修改 Trae 进程；所有产物写入工作区。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const out = { host: '127.0.0.1', port: 9222, out: 'probe-output', seconds: 600, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--host') { out.host = next; i++; }
    else if (a === '--port') { out.port = Number(next); i++; }
    else if (a === '--out') { out.out = next; i++; }
    else if (a === '--seconds') { out.seconds = Number(next); i++; }
    else if (a === '--quiet') out.quiet = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const HOST = args.host;
const PORT = args.port;
const OUT = path.resolve(args.out);
const BASE = `http://${HOST}:${PORT}`;
const runUntil = Date.now() + Math.max(10, args.seconds) * 1000;

fs.rmSync(OUT, { recursive: true, force: true });
for (const d of ['', 'bodies', 'scripts']) fs.mkdirSync(path.join(OUT, d), { recursive: true });

const logStream = fs.createWriteStream(path.join(OUT, 'log.txt'), { flags: 'a' });
const eventsStream = fs.createWriteStream(path.join(OUT, 'events.ndjson'), { flags: 'a' });
let scriptSourceCount = 0;
let bodyCount = 0;
const responseUrls = new Set();

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`;
  logStream.write(line + '\n');
  if (!args.quiet) console.log(line);
}
function event(type, data) {
  try { eventsStream.write(JSON.stringify({ ts: Date.now(), type, ...data }) + '\n'); } catch { /* ignore */ }
}
function safeStringify(v, max = 4000) {
  try {
    const s = JSON.stringify(v);
    return s.length > max ? s.slice(0, max) + `…(${s.length})` : s;
  } catch { return String(v); }
}

async function fetchJson(urlPath, timeoutMs = 2500) {
  const res = await fetch(`${BASE}${urlPath}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${urlPath}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// CDP 客户端（全局 WebSocket），支持浏览器级 session 转发
// ---------------------------------------------------------------------------
class CdpClient {
  constructor(wsUrl, label) {
    this.wsUrl = wsUrl;
    this.label = label;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map(); // method -> [fn]
    this.sessions = new Map(); // sessionId -> { handlers: Map }
    this.closed = false;
  }
  async connect() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timeout: ${this.label}`)), 5000);
      try {
        this.ws = new WebSocket(this.wsUrl);
      } catch (err) { clearTimeout(timer); reject(err); return; }
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`CDP connect error: ${this.label}`)); }, { once: true });
      this.ws.addEventListener('message', (msg) => this.#onMessage(msg.data));
      this.ws.addEventListener('close', () => { this.closed = true; this.#emit('__close__', {}); });
    });
    return this;
  }
  #emit(method, params, sessionId) {
    const list = sessionId
      ? (this.sessions.get(sessionId)?.handlers.get(method) ?? [])
      : (this.handlers.get(method) ?? []);
    for (const fn of list) {
      try { fn(params); } catch (err) { log('handler-error', method, String(err)); }
    }
  }
  #onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      const params = msg.params ?? {};
      this.#emit(msg.method, params, msg.sessionId ?? null);
      // 浏览器级：把 attached 事件暴露给 root 监听者，便于登记 session
      if (msg.sessionId) this.#emit(`__session__${msg.method}`, params, msg.sessionId);
    }
  }
  send(method, params = {}, sessionId = undefined) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP not connected'));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify(payload)); } catch (err) { this.pending.delete(id); reject(err); }
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, 15000).unref?.();
    });
  }
  on(method, fn, sessionId = null) {
    const map = sessionId ? (this.sessions.get(sessionId)?.handlers) : this.handlers;
    if (!map) return;
    if (!map.has(method)) map.set(method, []);
    map.get(method).push(fn);
  }
  registerSession(sessionId) {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { handlers: new Map() });
  }
  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------------------
// 深度读取 RemoteObject
// ---------------------------------------------------------------------------
async function remoteValue(client, remote, sessionId, depth = 0, visited = new Set()) {
  if (!remote) return null;
  if (Object.hasOwn(remote, 'value')) return remote.value;
  if (remote.unserializableValue) return remote.unserializableValue;
  if (!remote.objectId || depth > 4 || visited.has(remote.objectId)) return remote.description ?? null;
  visited.add(remote.objectId);
  let props;
  try {
    props = await client.send('Runtime.getProperties', {
      objectId: remote.objectId, ownProperties: true, accessorPropertiesOnly: false, generatePreview: false
    }, sessionId);
  } catch { return remote.description ?? null; }
  const obj = {};
  let n = 0;
  for (const p of props.result ?? []) {
    if (!p.value || p.name === '__proto__') continue;
    obj[p.name] = await remoteValue(client, p.value, sessionId, depth + 1, visited);
    if (++n > 120) break;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// 采集器（每个 target 一个）
// ---------------------------------------------------------------------------
const attachedTargets = new Map(); // key -> { client, sessionId, target, breakpoints:Set, requests:Map }

function scriptMatcher(url) {
  return typeof url === 'string' && /(workbench|trae|extensionHost|main|aiserver|chat)/i.test(url) && /\.(c|m)?js(\?|#|$)/i.test(url);
}

async function setupCollector(client, sessionId, target, key) {
  const state = attachedTargets.get(key);
  const send = (method, params) => client.send(method, params, sessionId);
  const on = (method, fn) => client.on(method, fn, sessionId);

  on('Runtime.executionContextCreated', () => {});
  on('Debugger.scriptParsed', (params) => void onScriptParsed(params));
  on('Debugger.paused', (params) => void onPaused(params));
  on('Network.responseReceived', (params) => {
    const { requestId, response, type } = params;
    state.requests.set(requestId, { url: response.url, type, status: response.status, mimeType: response.mimeType });
    if (response.url) responseUrls.add(response.url);
  });
  on('Network.loadingFinished', (params) => void onLoadingFinished(params));
  on('Network.loadingFailed', ({ requestId }) => state.requests.delete(requestId));
  on('Network.webSocketFrameReceived', (params) => {
    const payload = String(params?.response?.payloadData ?? '');
    if (!payload) return;
    event('ws-frame', { targetId: target.id, url: target.url, length: payload.length, preview: payload.slice(0, 1200) });
    if (/token|usage|credit|fee|model/i.test(payload)) {
      event('ws-frame-interesting', { targetId: target.id, payload: payload.slice(0, 20000) });
    }
  });

  async function onScriptParsed({ scriptId, url, length }) {
    if (!url) return;
    event('script', { targetId: target.id, sessionId: sessionId ?? null, scriptId, url, length });
    if (!scriptMatcher(url) || state.scanned.has(scriptId)) return;
    state.scanned.add(scriptId);
    let source;
    try { source = (await send('Debugger.getScriptSource', { scriptId })).scriptSource; }
    catch (err) { log('getScriptSource failed', url, String(err)); return; }
    if (typeof source !== 'string') return;
    const occurrences = [];
    let from = 0;
    while (occurrences.length < 6) {
      const idx = source.indexOf('reportTokenUsage', from);
      if (idx < 0) break;
      from = idx + 1;
      const before = source.slice(0, idx);
      const lineNumber = (before.match(/\n/g) ?? []).length;
      const lastNl = before.lastIndexOf('\n');
      const columnNumber = idx - lastNl - 1;
      occurrences.push({ lineNumber, columnNumber, index: idx });
    }
    if (occurrences.length === 0) return;
    if (scriptSourceCount < 12) {
      const file = path.join(OUT, 'scripts', `source-${++scriptSourceCount}.js`);
      fs.writeFileSync(file, source);
      log('saved script source', url, '->', path.basename(file), `${source.length}b`, `${occurrences.length} hits`);
    }
    event('script-hit', { targetId: target.id, scriptId, url, occurrences, sourceLength: source.length });
    for (const occ of occurrences.slice(0, 5)) {
      try {
        const res = await send('Debugger.setBreakpoint', {
          location: { scriptId, lineNumber: occ.lineNumber, columnNumber: occ.columnNumber }
        });
        state.breakpoints.add(res.breakpointId);
        event('breakpoint-set', { targetId: target.id, scriptId, url, lineNumber: occ.lineNumber, columnNumber: occ.columnNumber, breakpointId: res.breakpointId });
        log('breakpoint set', url, `${occ.lineNumber + 1}:${occ.columnNumber}`);
      } catch (err) { log('setBreakpoint failed', String(err)); }
    }
  }

  async function onPaused(params) {
    const { callFrames = [], reason } = params;
    try {
      const frame = callFrames[0];
      const collected = { targetId: target.id, reason, functionName: frame?.functionName ?? null };
      if (frame) {
        collected.location = frame.location;
        collected.url = frame.url;
        const local = (frame.scopeChain ?? []).find((s) => s.type === 'local');
        if (local) collected.local = await remoteValue(client, local.object, sessionId);
        collected.this = await remoteValue(client, frame.this, sessionId);
        for (const arg of frame.args ?? []) { /* no-op */ }
      }
      event('paused', collected);
      log('paused:', collected.functionName ?? '?', collected.url ?? '', safeStringify(collected.local, 900));
    } catch (err) {
      log('paused capture error', String(err));
    } finally {
      try { await send('Debugger.resume'); } catch { /* ignore */ }
    }
  }

  async function onLoadingFinished({ requestId, encodedDataLength }) {
    const meta = state.requests.get(requestId);
    state.requests.delete(requestId);
    if (!meta || !meta.url || meta.status >= 400) return;
    const candidates = /get_session_usage|commercial|chat|llm|completion|agent/i.test(meta.url);
    if (!candidates) return;
    if (encodedDataLength > 10_000_000) return;
    let body;
    try {
      const res = await send('Network.getResponseBody', { requestId });
      body = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
    } catch (err) { log('getResponseBody failed', safeStringify(meta.url, 200), String(err)); return; }
    if (!body) return;
    const name = `body-${++bodyCount}.txt`;
    fs.writeFileSync(path.join(OUT, 'bodies', name), body.slice(0, 5_000_000));
    event('response-body', {
      targetId: target.id, url: meta.url, type: meta.type, status: meta.status, file: name, length: body.length,
      interesting: /token|credit|usage|fee/i.test(body)
    });
    if (/token|credit|usage|fee|model/i.test(body)) log('interesting body', name, meta.url, body.length);
  }

  await send('Runtime.enable');
  await send('Network.enable', { maxTotalBufferSize: 50_000_000, maxResourceBufferSize: 16_000_000 });
  try { await send('Debugger.enable', { maxScriptsCacheSize: 50_000_000 }); }
  catch (err) { log('Debugger.enable failed', target.url, String(err)); }
  log('attached target', target.type, target.id, safeStringify(target.title, 120), safeStringify(target.url, 200));
}

async function attachDirect(target) {
  const key = `direct:${target.id}`;
  if (attachedTargets.has(key)) return;
  const state = { target, scanned: new Set(), breakpoints: new Set(), requests: new Map(), client: null, sessionId: undefined };
  attachedTargets.set(key, state);
  try {
    const client = await new CdpClient(target.webSocketDebuggerUrl, target.id).connect();
    state.client = client;
    client.on('__close__', () => { attachedTargets.delete(key); log('target closed', target.id); });
    await setupCollector(client, undefined, target, key);
  } catch (err) {
    attachedTargets.delete(key);
    log('attach failed', target.id, String(err));
    event('attach-error', { targetId: target.id, message: String(err) });
  }
}

async function attachViaBrowser(browserClient, targetInfo) {
  const key = `browser:${targetInfo.targetId}`;
  if (attachedTargets.has(key)) return;
  const state = { target: { id: targetInfo.targetId, type: targetInfo.type, url: targetInfo.url, title: targetInfo.title }, scanned: new Set(), breakpoints: new Set(), requests: new Map() };
  attachedTargets.set(key, state);
  try {
    const res = await browserClient.send('Target.attachToTarget', { targetId: targetInfo.targetId, flatten: true });
    const sessionId = res.sessionId;
    browserClient.registerSession(sessionId);
    state.client = browserClient;
    state.sessionId = sessionId;
    browserClient.on('__session__Target.detachedFromTarget', () => { attachedTargets.delete(key); }, sessionId);
    await setupCollector(browserClient, sessionId, state.target, key);
  } catch (err) {
    attachedTargets.delete(key);
    log('browser attach failed', targetInfo.targetId, String(err));
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
let version = null;
let list = [];
try {
  version = await fetchJson('/json/version');
  list = await fetchJson('/json/list');
} catch (err) {
  console.error(`无法连接 CDP ${BASE}：${err.message}`);
  console.error('请确认 Trae 是以 --remote-debugging-port 启动的（argv.json 已配置后需要重启 Trae）。');
  process.exit(2);
}
fs.writeFileSync(path.join(OUT, 'targets.json'), JSON.stringify({ version, list }, null, 2));
log('CDP version:', safeStringify(version?.Browser ?? version, 300));
log('targets:', list.length, list.map((t) => `${t.type}:${t.id}:${safeStringify(t.title, 80)}`).join(' | '));
event('targets', { version, targets: list.map(({ id, type, title, url, webSocketDebuggerUrl }) => ({ id, type, title, url, hasWs: Boolean(webSocketDebuggerUrl) })) });

const allowedTypes = new Set(['page', 'webview', 'iframe', 'worker', 'service_worker', 'background_page', 'shared_worker']);
for (const t of list) {
  if (t.webSocketDebuggerUrl && allowedTypes.has(t.type)) await attachDirect(t);
}

// 浏览器级 target 发现（兜底 WebView/iframe）
let browserClient = null;
try {
  if (version?.webSocketDebuggerUrl) {
    browserClient = await new CdpClient(version.webSocketDebuggerUrl, 'browser').connect();
    browserClient.on('Target.targetCreated', () => {});
    browserClient.on('Target.targetInfoChanged', () => {});
    browserClient.on('Target.attachedToTarget', () => {});
    await browserClient.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos = [] } = await browserClient.send('Target.getTargets');
    fs.writeFileSync(path.join(OUT, 'browser-targets.json'), JSON.stringify(targetInfos, null, 2));
    log('browser targets:', targetInfos.length, targetInfos.map((t) => `${t.type}:${t.targetId}:${safeStringify(t.title, 60)}`).join(' | '));
    const listed = new Set(list.map((t) => t.id));
    for (const info of targetInfos) {
      if (!allowedTypes.has(info.type)) continue;
      if (listed.has(info.targetId)) continue;
      await attachViaBrowser(browserClient, info);
    }
  }
} catch (err) {
  log('browser-level discovery failed:', String(err));
}

// 周期刷新目标
const pollTimer = setInterval(async () => {
  try {
    const next = await fetchJson('/json/list', 1500);
    for (const t of next) {
      if (t.webSocketDebuggerUrl && allowedTypes.has(t.type) && !attachedTargets.has(`direct:${t.id}`)) {
        await attachDirect(t);
      }
    }
    fs.writeFileSync(path.join(OUT, 'targets.json'), JSON.stringify({ version, list: next }, null, 2));
  } catch (err) { log('poll error', String(err)); }
}, 5000);
pollTimer.unref?.();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
log(`probe running until ${new Date(runUntil).toISOString()} (${args.seconds}s)`);

async function shutdown(code = 0) {
  clearInterval(pollTimer);
  const summary = {
    finishedAt: new Date().toISOString(),
    targets: list.length,
    attached: attachedTargets.size,
    scriptsSaved: scriptSourceCount,
    responseBodies: bodyCount,
    uniqueResponseUrls: responseUrls.size
  };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  log('SUMMARY', safeStringify(summary));
  for (const state of attachedTargets.values()) { try { state.client?.close(); } catch { /* ignore */ } }
  try { browserClient?.close(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 200));
  logStream.end();
  eventsStream.end();
  process.exit(code);
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

while (Date.now() < runUntil) await sleep(1000);
await shutdown(0);
