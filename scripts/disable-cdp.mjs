#!/usr/bin/env node
/**
 * 关闭 Trae CDP 调端口：从 argv.json 移除 remote-debugging-port（先备份）。
 * 用法：node scripts/disable-cdp.mjs [--data-folder .trae-cn]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const i = args.indexOf('--data-folder');
const dataFolder = i >= 0 && args[i + 1] ? args[i + 1] : '.trae-cn';
const argvPath = path.join(os.homedir(), dataFolder, 'argv.json');

let config;
try { config = JSON.parse(fs.readFileSync(argvPath, 'utf8')); } catch (err) {
  console.error(`无法读取 ${argvPath}: ${err.message}`);
  process.exit(1);
}
if (!Object.prototype.hasOwnProperty.call(config, 'remote-debugging-port')) {
  console.log(`argv.json 中没有 remote-debugging-port，无需处理：${argvPath}`);
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${argvPath}.bak-${stamp}`;
fs.copyFileSync(argvPath, backupPath);
fs.chmodSync(backupPath, 0o600);
delete config['remote-debugging-port'];
const tmpPath = `${argvPath}.tmp-${process.pid}`;
fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(tmpPath, argvPath);
console.log(JSON.stringify({ argvPath, backupPath, removed: true, config }, null, 2));
