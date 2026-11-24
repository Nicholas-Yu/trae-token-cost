#!/usr/bin/env node
/**
 * M0 用：给 Trae CN 的 argv.json 写入 remote-debugging-port，并备份原文件。
 * 用法：node scripts/enable-cdp.mjs [--port 9222] [--data-folder .trae-cn]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const port = Number(opt('port', '9222'));
const dataFolder = opt('data-folder', '.trae-cn');
const argvPath = path.join(os.homedir(), dataFolder, 'argv.json');

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('invalid port:', port);
  process.exit(1);
}

function stripJsonc(text) {
  let out = '';
  let i = 0;
  let inString = false;
  let quote = '';
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
      if (c === quote) inString = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { inString = true; quote = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

let config = {};
let existed = false;
try {
  const raw = fs.readFileSync(argvPath, 'utf8');
  existed = true;
  config = JSON.parse(stripJsonc(raw));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('argv.json 不是对象');
} catch (err) {
  if (existed) { console.error('解析 argv.json 失败：', err.message); process.exit(1); }
  fs.mkdirSync(path.dirname(argvPath), { recursive: true });
}

const before = JSON.stringify(config);
if (config['remote-debugging-port'] === String(port)) {
  console.log(`已存在 remote-debugging-port="${port}"（字符串），无需修改：${argvPath}`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${argvPath}.bak-${stamp}`;
if (existed) {
  fs.copyFileSync(argvPath, backupPath);
  fs.chmodSync(backupPath, 0o600);
}
// Trae 的 argv.json 解析器只认字符串值（数字会被静默忽略）
config['remote-debugging-port'] = String(port);

const tmpPath = `${argvPath}.tmp-${process.pid}`;
fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(tmpPath, argvPath);

const after = JSON.stringify(config);
console.log(JSON.stringify({
  argvPath,
  existed,
  backupPath: existed ? backupPath : null,
  changed: before !== after,
  port,
  config
}, null, 2));
