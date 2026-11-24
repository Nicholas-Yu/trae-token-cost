#!/usr/bin/env node
/**
 * v2 探针：Trae 3.4.x 的 ai-chat v2 管线用 StreamEvents.fireTokenUsageReceived(payload)
 * 派发 token 用量（SSH 远程窗口同样经过本地渲染进程）。此脚本在多个候选函数上打断点并 dump 参数。
 */
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.argv[2] || 9222);
const OUT = path.resolve(process.argv[3] || 'probe-v2');
const SECONDS = Number(process.argv[4] || 240);
const MARKERS = ['fireTokenUsageReceived', 'onTokenUsageReceived', 'handleTokenUsage', 'reportTokenUsage'];
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'paused'), { recursive: true });
const log = (l) => { const line = `[${new Date().toISOString()}] ${l}\n`; fs.appendFileSync(path.join(OUT, 'log.txt'), line); console.log(line.trim()); };

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) { log('no page target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); let pausedCount = 0; let bpCount = 0;
const send = (method, params = {}, timeoutMs = 15000) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('timeout ' + method)); } }, timeoutMs); });
const readObj = async (remote, depth, seen) => {
  if (!remote) return null;
  if (Object.prototype.hasOwnProperty.call(remote, 'value')) return remote.value;
  if (remote.unserializableValue) return remote.unserializableValue;
  if (!remote.objectId || depth > 4 || seen.has(remote.objectId)) return remote.description ?? null;
  seen.add(remote.objectId);
  let props; try { props = await send('Runtime.getProperties', { objectId: remote.objectId, ownProperties: true }); } catch { return remote.description ?? null; }
  const obj = {}; let n = 0;
  for (const p of props.result || []) {
    if (p.name === '__proto__' || p.enumerable === false || !p.value) continue;
    if (p.value.type === 'object' && p.value.objectId) {
      if (p.value.className === 'Array') { obj[p.name] = (p.value.description || '').slice(0, 200); continue; }
      obj[p.name] = await readObj(p.value, depth + 1, seen);
    } else if (p.value.type !== 'function' && p.value.type !== 'symbol') obj[p.name] = p.value.value;
    if (++n > 120) break;
  }
  return obj;
};
ws.addEventListener('message', async (ev) => {
  let msg; try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); return; }
  if (msg.method === 'Debugger.scriptParsed') {
    const url = msg.params.url || '';
    if (!url.includes('ai-modules-chat/dist/index.mjs')) return;
    log(`chat bundle scriptId=${msg.params.scriptId}`);
    try {
      const { scriptSource } = await send('Debugger.getScriptSource', { scriptId: msg.params.scriptId }, 25000);
      log(`source length ${scriptSource.length}`);
      for (const marker of MARKERS) {
        let from = 0, hits = 0;
        while (hits < 4) {
          const idx = scriptSource.indexOf(marker, from);
          if (idx < 0) break;
          from = idx + 1;
          const before = scriptSource.slice(0, idx);
          const line = (before.match(/\n/g) || []).length;
          const col = idx - before.lastIndexOf('\n') - 1;
          try { await send('Debugger.setBreakpoint', { location: { scriptId: msg.params.scriptId, lineNumber: line, columnNumber: col } }); bpCount++; hits++; log(`bp ${marker} @ ${line + 1}:${col}`); }
          catch (e) { log(`bp fail ${marker} @ ${line + 1}:${col}: ${e.message}`); }
        }
      }
    } catch (e) { log('source fetch error: ' + e.message); }
    return;
  }
  if (msg.method === 'Debugger.paused') {
    pausedCount++;
    const frame = msg.params.callFrames && msg.params.callFrames[0];
    log(`PAUSED #${pausedCount} fn=${frame && frame.functionName} url=${(frame && frame.url || '').slice(-50)}`);
    const data = { reason: msg.params.reason, fn: frame && frame.functionName, local: null, args: null };
    try {
      const local = frame && (frame.scopeChain || []).find((s) => s.type === 'local');
      if (local) data.local = await readObj(local.object, 0, new Set());
      if (frame && frame.arguments) { data.args = []; for (const a of frame.arguments) data.args.push(a.objectId ? await readObj(a, 0, new Set()) : (a.value ?? null)); }
      fs.writeFileSync(path.join(OUT, 'paused', `paused-${Date.now()}-${pausedCount}.json`), JSON.stringify(data, null, 2));
    } finally { send('Debugger.resume').catch(() => {}); }
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable').catch(() => {});
await send('Network.enable').catch(() => {});
await send('Debugger.enable', { maxScriptsCacheSize: 50_000_000 }).catch(() => {});
log(`probe-v2 running ${SECONDS}s; breakpoints=${bpCount}`);
setInterval(() => log(`alive breakpoints=${bpCount} paused=${pausedCount}`), 30000);
setTimeout(() => { log(`DONE breakpoints=${bpCount} paused=${pausedCount}`); process.exit(0); }, SECONDS * 1000);
