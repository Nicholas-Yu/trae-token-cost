#!/usr/bin/env node
/**
 * 深度探针：在真实 Trae 上定位 token 用量的实际数据通道。
 * - Network：记录所有请求 URL/方法/响应状态；对 Fetch/XHR/EventSource 尝试抓响应体
 * - Debugger：监听 ai-modules-chat/index.mjs，在 reportTokenUsage 上设断点并 dump 参数
 * 产物：deep-probe/
 */
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.argv[2] ? Number(process.argv[2]) : 9222;
const OUT = path.resolve(process.argv[3] || 'deep-probe');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'bodies'), { recursive: true });
const log = (line) => fs.appendFileSync(path.join(OUT, 'log.txt'), `[${new Date().toISOString()}] ${line}\n`);
const events = fs.createWriteStream(path.join(OUT, 'events.ndjson'), { flags: 'a' });
const ev = (type, data) => events.write(JSON.stringify({ ts: Date.now(), type, ...data }) + '\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
log(`targets: ${list.map((t) => t.type + ':' + (t.title || '').slice(0, 25)).join(' | ')}`);

const clients = new Map();
let bodyCount = 0;

class Client {
  constructor(t) {
    this.target = t;
    this.ws = new WebSocket(t.webSocketDebuggerUrl);
    this.id = 0;
    this.pending = new Map();
    this.requests = new Map();
    this.scanned = new Set();
    this.breakpoints = 0;
    this.scriptsMatched = 0;
  }
  async open() {
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('connect timeout')), 5000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
      this.ws.addEventListener('error', () => rej(new Error('connect error')), { once: true });
      this.ws.addEventListener('message', (m) => this.onMessage(m.data));
    });
  }
  onMessage(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); return;
    }
    if (msg.method) this.onEvent(msg.method, msg.params || {});
  }
  send(method, params = {}, timeoutMs = 12000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, timeoutMs);
    });
  }
  async onEvent(method, params) {
    try {
      if (method === 'Debugger.scriptParsed') return this.onScript(params);
      if (method === 'Debugger.paused') return this.onPaused(params);
      if (method === 'Network.requestWillBeSent') {
        const url = params.request && params.request.url || '';
        if (url.includes('get_session_usage') || /chat|llm|agent|usage|completion/i.test(url)) {
          log(`REQ ${params.request.method} ${url}`);
          ev('request', { target: this.target.type, url, method: params.request.method, postData: params.request.postData || null, type: params.type });
        }
        return;
      }
      if (method === 'Network.responseReceived') {
        this.requests.set(params.requestId, { url: params.response.url, status: params.response.status, type: params.type });
        return;
      }
      if (method === 'Network.loadingFinished') return this.onFinished(params);
      if (method === 'Network.loadingFailed') { this.requests.delete(params.requestId); return; }
    } catch (err) { log(`event error ${method}: ${err.message}`); }
  }
  async onScript(params) {
    const url = params.url || '';
    if (!url.includes('ai-modules-chat')) return;
    this.scriptsMatched++;
    if (this.scanned.has(params.scriptId)) return;
    this.scanned.add(params.scriptId);
    if (!url.endsWith('index.mjs')) { ev('script-skip', { url }); return; }
    log(`chat bundle found: ${url} (scriptId=${params.scriptId})`);
    ev('script', { url, scriptId: params.scriptId });
    let source;
    try { source = (await this.send('Debugger.getScriptSource', { scriptId: params.scriptId }, 20000)).scriptSource; }
    catch (err) { log(`getScriptSource failed: ${err.message}`); return; }
    log(`source length ${source.length}`);
    let from = 0, count = 0;
    while (count < 5) {
      const idx = source.indexOf('reportTokenUsage', from);
      if (idx < 0) break;
      from = idx + 1;
      const before = source.slice(0, idx);
      const line = (before.match(/\n/g) || []).length;
      const col = idx - before.lastIndexOf('\n') - 1;
      try {
        const r = await this.send('Debugger.setBreakpoint', { location: { scriptId: params.scriptId, lineNumber: line, columnNumber: col } });
        this.breakpoints++;
        log(`breakpoint set ${line}:${col} -> ${r.breakpointId}`);
        ev('breakpoint', { url, line, col, id: r.breakpointId });
      } catch (err) { log(`setBreakpoint failed ${line}:${col}: ${err.message}`); }
      count++;
    }
    ev('breakpoints-total', { count: this.breakpoints });
  }
  async onPaused(params) {
    const frame = params.callFrames && params.callFrames[0];
    log(`PAUSED reason=${params.reason} fn=${frame && frame.functionName} url=${(frame && frame.url || '').slice(-60)}`);
    try {
      const data = { reason: params.reason, fn: frame && frame.functionName, url: frame && frame.url, local: null, args: null };
      const localScope = frame && (frame.scopeChain || []).find((s) => s.type === 'local');
      if (localScope) data.local = await this.readObject(localScope.object, 0, new Set());
      if (frame && frame.arguments) {
        data.args = [];
        for (const arg of frame.arguments) data.args.push(arg.objectId ? await this.readObject(arg, 0, new Set()) : (arg.value ?? null));
      }
      ev('paused', data);
      fs.writeFileSync(path.join(OUT, `paused-${Date.now()}.json`), JSON.stringify(data, null, 2));
    } finally {
      this.send('Debugger.resume').catch(() => {});
    }
  }
  async readObject(remote, depth, seen) {
    if (!remote) return null;
    if (Object.prototype.hasOwnProperty.call(remote, 'value')) return remote.value;
    if (remote.unserializableValue) return remote.unserializableValue;
    if (!remote.objectId || depth > 4 || seen.has(remote.objectId)) return remote.description ?? null;
    seen.add(remote.objectId);
    let props;
    try { props = await this.send('Runtime.getProperties', { objectId: remote.objectId, ownProperties: true }); } catch { return remote.description ?? null; }
    const obj = {};
    let n = 0;
    for (const p of props.result || []) {
      if (p.name === '__proto__' || p.enumerable === false) continue;
      if (!p.value) continue;
      if (p.value.type === 'object' && p.value.objectId) {
        if (p.value.className === 'Array') { obj[p.name] = p.value.description || '[Array]'; continue; }
        obj[p.name] = await this.readObject(p.value, depth + 1, seen);
      } else if (p.value.type !== 'function' && p.value.type !== 'symbol') obj[p.name] = p.value.value;
      if (++n > 120) break;
    }
    return obj;
  }
  async onFinished(params) {
    const meta = this.requests.get(params.requestId);
    this.requests.delete(params.requestId);
    if (!meta || !meta.url || meta.status >= 400) return;
    if (!/get_session_usage|chat|llm|agent|usage|completion/i.test(meta.url)) return;
    try {
      const r = await this.send('Network.getResponseBody', { requestId: params.requestId }, 8000);
      let body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
      if (!body) return;
      const file = path.join(OUT, 'bodies', `body-${++bodyCount}.txt`);
      fs.writeFileSync(file, body.slice(0, 5_000_000));
      const interesting = /token|usage|credit|fee/i.test(body);
      log(`BODY ${meta.url} len=${body.length} interesting=${interesting} -> ${path.basename(file)}`);
      ev('body', { url: meta.url, type: meta.type, status: meta.status, file: path.basename(file), length: body.length, interesting });
    } catch (err) { log(`getResponseBody failed ${meta.url}: ${err.message}`); }
  }
}

async function attachAll() {
  const next = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  for (const t of next) {
    if (!t.webSocketDebuggerUrl) continue;
    if (!['page', 'iframe', 'webview', 'worker', 'service_worker'].includes(t.type)) continue;
    if (clients.has(t.id)) continue;
    if (t.type === 'worker' || t.type === 'service_worker') continue;
    const c = new Client(t);
    try {
      await c.open();
      clients.set(t.id, c);
      log(`attached ${t.type} ${(t.title || '').slice(0, 40)}`);
      await c.send('Runtime.enable');
      await c.send('Network.enable', { maxTotalBufferSize: 50_000_000, maxResourceBufferSize: 16_000_000 });
      await c.send('Debugger.enable', { maxScriptsCacheSize: 50_000_000 });
    } catch (err) {
      log(`attach failed ${t.id}: ${err.message}`);
      try { c.ws.close(); } catch {}
    }
  }
}

await attachAll();
const poll = setInterval(() => attachAll().catch((e) => log('poll error ' + e.message)), 4000);
process.on('SIGINT', () => { clearInterval(poll); process.exit(0); });
log('deep probe running (send a chat message in Trae now)');
for (let i = 0; i < 300; i++) {
  await sleep(1000);
  if (i % 30 === 0) log(`alive ${i}s, clients=${clients.size}`);
  if (i === 299) break;
}
clearInterval(poll);
process.exit(0);
