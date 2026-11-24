'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  deriveHostLabel,
  parseWindowTitle,
  sanitizeWindowTitle,
} = require('../src/host');

test('sanitizeWindowTitle: 去掉 Trae CN / VS Code 后缀', () => {
  assert.strictEqual(sanitizeWindowTitle('my-project — Trae CN'), 'my-project');
  assert.strictEqual(sanitizeWindowTitle('my-project - Trae CN'), 'my-project');
  assert.strictEqual(sanitizeWindowTitle('my-project — Visual Studio Code'), 'my-project');
  assert.strictEqual(sanitizeWindowTitle('my-project - Visual Studio Code'), 'my-project');
  assert.strictEqual(sanitizeWindowTitle('my-project - VS Code'), 'my-project');
  assert.strictEqual(sanitizeWindowTitle('my-project — Trae'), 'my-project');
  assert.strictEqual(sanitizeWindowTitle('  my-project — Trae CN  '), 'my-project');
});

test('sanitizeWindowTitle: 非标题内容（错误输入）返回空字符串', () => {
  assert.strictEqual(sanitizeWindowTitle(null), '');
  assert.strictEqual(sanitizeWindowTitle(undefined), '');
  assert.strictEqual(sanitizeWindowTitle(''), '');
  assert.strictEqual(sanitizeWindowTitle('   '), '');
});

test('sanitizeWindowTitle: 不误伤含连字符的工作区名', () => {
  assert.strictEqual(sanitizeWindowTitle('my-project — Trae CN'), 'my-project');
  assert.strictEqual(sanitizeWindowTitle('my-project-Trae CN'), 'my-project-Trae CN');
  assert.strictEqual(sanitizeWindowTitle('trae-token-usage - Trae CN'), 'trae-token-usage');
});

test('deriveHostLabel: 识别 [SSH: gpu-host] / [SSH:host] / [远程: gpu-host] / [远程] host', () => {
  assert.strictEqual(deriveHostLabel('my-project [SSH: gpu-host] — Trae CN'), 'gpu-host');
  assert.strictEqual(deriveHostLabel('my-project [SSH:my-server] - Trae CN'), 'my-server');
  assert.strictEqual(deriveHostLabel('my-project [远程: gpu-host] — Trae CN'), 'gpu-host');
  assert.strictEqual(deriveHostLabel('my-project [远程] gpu-host — Trae CN'), 'gpu-host');
  assert.strictEqual(deriveHostLabel('my-project [Remote: 10.0.0.2] — Trae CN'), '10.0.0.2');
  assert.strictEqual(deriveHostLabel('my-project — SSH: gpu-host'), 'gpu-host');
});

test('deriveHostLabel: 本机窗口（含无法识别）返回 本机', () => {
  assert.strictEqual(deriveHostLabel('my-project — Trae CN'), '本机');
  assert.strictEqual(deriveHostLabel('my-project - Visual Studio Code'), '本机');
  assert.strictEqual(deriveHostLabel(''), '本机');
  assert.strictEqual(deriveHostLabel(null), '本机');
  assert.strictEqual(deriveHostLabel('Trae CN'), '本机');
  assert.strictEqual(deriveHostLabel('my-project [SSH]'), '本机');
});

test('parseWindowTitle: 远程窗口同时解析 host 与 workspaceName', () => {
  assert.deepStrictEqual(parseWindowTitle('my-project [SSH: gpu-host] — Trae CN'), {
    host: 'gpu-host',
    workspaceName: 'my-project',
  });
  assert.deepStrictEqual(parseWindowTitle('my-project [SSH:host] - Trae CN'), {
    host: 'host',
    workspaceName: 'my-project',
  });
  assert.deepStrictEqual(parseWindowTitle('my-project [远程] gpu-host — Trae CN'), {
    host: 'gpu-host',
    workspaceName: 'my-project',
  });
  assert.deepStrictEqual(parseWindowTitle('my-project — SSH: gpu-host'), {
    host: 'gpu-host',
    workspaceName: 'my-project',
  });
});

test('parseWindowTitle: 本机窗口 host 为 null', () => {
  assert.deepStrictEqual(parseWindowTitle('my-project — Trae CN'), {
    host: null,
    workspaceName: 'my-project',
  });
  assert.deepStrictEqual(parseWindowTitle('my-project - Visual Studio Code'), {
    host: null,
    workspaceName: 'my-project',
  });
  assert.deepStrictEqual(parseWindowTitle(''), { host: null, workspaceName: null });
  assert.deepStrictEqual(parseWindowTitle(null), { host: null, workspaceName: null });
});

test('parseWindowTitle: 文件 + 工作区多段标题取最后一段', () => {
  assert.deepStrictEqual(parseWindowTitle('index.js — my-project — Trae CN'), {
    host: null,
    workspaceName: 'my-project',
  });
  assert.deepStrictEqual(parseWindowTitle('index.js — my-project [SSH: gpu-host] — Trae CN'), {
    host: 'gpu-host',
    workspaceName: 'my-project',
  });
});

test('parseWindowTitle: 只有应用名时 workspaceName 为 null', () => {
  assert.deepStrictEqual(parseWindowTitle('Trae CN'), { host: null, workspaceName: null });
  assert.deepStrictEqual(parseWindowTitle('Trae CN [SSH: gpu-host]'), {
    host: 'gpu-host',
    workspaceName: null,
  });
});
