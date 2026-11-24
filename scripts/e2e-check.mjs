#!/usr/bin/env node
/**
 * E2E 自检：确认 Trae CDP、扩展安装、扩展运行状态与本地数据。
 * 用法：node scripts/e2e-check.mjs [--port 9333] [--json]
 * 只读，不修改 Trae。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const { readArgvFile } = createRequire(import.meta.url)('../src/setup/argv.js');
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = portArg >= 0 && args[portArg + 1] ? Number(args[portArg + 1]) : 9333;
const asJson = args.includes('--json');

const dataFolder = '.trae-cn';
const home = os.homedir();
const userData = path.join(home, 'Library', 'Application Support', 'Trae CN');
const argvPath = path.join(home, dataFolder, 'argv.json');
const extensionsJson = path.join(home, dataFolder, 'extensions', 'extensions.json');
const globalStorage = path.join(userData, 'User', 'globalStorage', 'local.trae-token-cost');

const report = { checks: [], ok: true };
function check(name, pass, detail) {
  report.checks.push({ name, pass: Boolean(pass), detail });
  if (!pass) report.ok = false;
}
async function fetchJson(url, timeoutMs = 2500) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// 1. argv.json 调试端口
let argvPort = null;
let argvOk = false;
try {
  const result = readArgvFile(argvPath);
  argvPort = result.config['remote-debugging-port'] || null;
  argvOk = result.existed;
  if (!argvOk) check('argv.json 可读', false, `${argvPath}: 文件不存在`);
} catch (err) {
  check('argv.json 可读', false, `${argvPath}: ${err.message}`);
}
if (argvOk) check(`argv.json 调试端口 = ${argvPort || '未配置'}`, Number(argvPort) === Number(PORT), argvPath);

// 2. CDP 可连接
let version = null;
let targets = [];
try {
  version = await fetchJson(`http://127.0.0.1:${PORT}/json/version`);
  targets = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
  check('CDP 可连接', true, `${version.Browser || 'Electron'} · ${targets.length} 个 target`);
} catch (err) {
  check('CDP 可连接', false, `127.0.0.1:${PORT} 连接失败：${err.message}（Trae 可能未带调试端口重启）`);
}
if (targets.length) {
  const pages = targets.map((t) => `${t.type}:${(t.title || '').slice(0, 40)}`);
  report.targets = pages;
}

// 3. 扩展已安装
let installed = null;
try {
  const list = JSON.parse(fs.readFileSync(extensionsJson, 'utf8'));
  installed = list.find((e) => (e.identifier && e.identifier.id) === 'local.trae-token-cost');
  check('扩展已安装', Boolean(installed), installed ? `v${installed.version}` : 'extensions.json 中未找到 local.trae-token-cost');
} catch (err) {
  check('扩展已安装', false, `${extensionsJson}: ${err.message}`);
}

// 4. 扩展运行状态（shared/status.json，由 leader 窗口写）
let status = null;
const statusPath = path.join(globalStorage, 'shared', 'status.json');
try {
  status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  const ageSec = Math.round((Date.now() - Number(status.heartbeatAt || 0)) / 1000);
  check('扩展已运行（leader 心跳）', ageSec < 30, `role=${status.role} pid=${status.pid} 心跳 ${ageSec}s 前`);
  check('CDP 采集已连接', Boolean(status.cdpConnected), `targets=${status.targetCount} collectors=${status.collectorCount} breakpoints=${status.breakpointCount}`);
  report.status = status;
} catch (err) {
  check('扩展已运行（leader 心跳）', false, `${statusPath}: ${err.message}（扩展可能未激活或未加载）`);
}

// 5. 本地数据库与记录
const dbPath = path.join(globalStorage, 'usage.db');
try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const total = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(total_tokens),0) t FROM calls').get();
  const recent = db.prepare('SELECT observed_at, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, usage_complete, source FROM calls ORDER BY id DESC LIMIT 5').all();
  check('本地数据库有记录', total.c > 0, `${total.c} 条 / ${total.t} tokens`);
  report.recent = recent;
  db.close();
} catch (err) {
  check('本地数据库有记录', false, `${dbPath}: ${err.message}`);
}

// 6. 扩展日志尾部
const logPath = path.join(globalStorage, 'logs', 'extension.log');
try {
  const tail = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).slice(-15);
  report.logTail = tail;
} catch (err) {
  report.logTail = [`读取日志失败：${err.message}`];
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('=== Trae Token 费用 E2E 自检 ===');
  for (const c of report.checks) console.log(`${c.pass ? '✅' : '❌'} ${c.name}${c.detail ? `（${c.detail}）` : ''}`);
  if (report.targets) console.log('\nCDP targets:\n  ' + report.targets.join('\n  '));
  if (report.recent && report.recent.length) {
    console.log('\n最近记录:');
    for (const r of report.recent) {
      console.log(`  ${new Date(r.observed_at).toLocaleString()} ${r.model} in=${r.input_tokens} out=${r.output_tokens} cache=${r.cache_read_tokens}/${r.cache_write_tokens} reasoning=${r.reasoning_tokens ?? '—'} complete=${r.usage_complete} src=${r.source}`);
    }
  }
  if (report.logTail) console.log('\n扩展日志尾部:\n  ' + report.logTail.join('\n  '));
  console.log(`\n结果：${report.ok ? 'PASS' : 'FAIL'}`);
}
process.exit(report.ok ? 0 : 1);
