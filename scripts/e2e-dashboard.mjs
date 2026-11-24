import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const userDir = path.join(os.homedir(), 'Library', 'Application Support', 'Trae CN', 'User');
const dbPath = process.env.TRAE_TOKEN_COST_DB || path.join(userDir, 'globalStorage', 'local.trae-token-cost', 'usage.db');
const settingsPath = process.env.TRAE_TOKEN_COST_SETTINGS || path.join(userDir, 'settings.json');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function waitForUrl(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`启动看板超时：${output}`)), 15000);
    const inspect = (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/?/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[0].replace(/\/$/, ''));
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        reject(new Error(`看板进程提前退出（${code}）：${output}`));
      }
    });
  });
}

const before = {
  db: sha256(dbPath),
  settings: fs.existsSync(settingsPath) ? sha256(settingsPath) : null
};
const child = spawn(process.execPath, ['src/standalone/cli.js', '--no-open'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe']
});

try {
  const baseUrl = await waitForUrl(child);
  const response = await fetch(`${baseUrl}/api/dashboard?range=all`);
  if (!response.ok) throw new Error(`API 返回 HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.standalone !== true) throw new Error('API 未处于独立只读模式');
  if (/session_key|message_key|turn_key|billing_key|window_title|workspace_name/.test(JSON.stringify(payload))) {
    throw new Error('API 包含内部关联键或窗口信息');
  }
  const csv = await fetch(`${baseUrl}/api/export.csv?range=all`);
  if (!csv.ok) throw new Error(`CSV 导出返回 HTTP ${csv.status}`);
  console.log(`看板地址：${baseUrl}`);
  console.log(`调用记录：${payload.summary?.total?.calls ?? 0}；总 Token：${payload.summary?.total?.total_tokens ?? 0}`);
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

const after = {
  db: sha256(dbPath),
  settings: fs.existsSync(settingsPath) ? sha256(settingsPath) : null
};
if (before.db !== after.db || before.settings !== after.settings) {
  throw new Error('数据库或设置文件在只读服务运行期间发生变化');
}
console.log('PASS：独立服务可访问，API 无内部标识，数据库与设置文件哈希未变化。');
