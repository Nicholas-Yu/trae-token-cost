'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  buildWorkspaceArg,
  buildRelaunchSpec,
  createGuardScript,
  launchDetached,
  copyLaunchCommand,
} = require('../src/setup/relaunch');

const MAC_BUNDLE = '/Applications/Trae CN.app';

function makeDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-relaunch-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  return dir;
}

function macSpec(overrides = {}) {
  return buildRelaunchSpec({
    platform: 'darwin',
    appBundlePath: MAC_BUNDLE,
    port: 9222,
    ...overrides,
  });
}

test('buildWorkspaceArg：URI 字符串透传（本机）', () => {
  assert.deepStrictEqual(
    buildWorkspaceArg({ workspaceFile: 'file:///Users/me/proj/ws.code-workspace' }),
    { kind: 'file-uri', value: 'file:///Users/me/proj/ws.code-workspace' },
  );
  assert.deepStrictEqual(
    buildWorkspaceArg({ workspaceFolders: ['file:///Users/me/proj'] }),
    { kind: 'folder-uri', value: 'file:///Users/me/proj' },
  );
  assert.deepStrictEqual(
    buildWorkspaceArg({ workspaceFile: 'vscode-remote://ssh-remote+gpu-host/home/user/proj.code-workspace' }),
    { kind: 'file-uri', value: 'vscode-remote://ssh-remote+gpu-host/home/user/proj.code-workspace' },
  );
});

test('buildWorkspaceArg：普通路径转 file URI', () => {
  const folder = path.resolve('/Users/me/my project');
  assert.deepStrictEqual(
    buildWorkspaceArg({ workspaceFolders: [folder] }),
    { kind: 'folder-uri', value: pathToFileURL(folder).href },
  );
  assert.ok(buildWorkspaceArg({ workspaceFolders: [folder] }).value.includes('my%20project'));
});

test('buildWorkspaceArg：remoteAuthority 拼 vscode-remote://', () => {
  assert.deepStrictEqual(
    buildWorkspaceArg({
      remoteAuthority: 'ssh-remote+gpu-host',
      workspaceFile: 'file:///home/user/proj/ws.code-workspace',
    }),
    { kind: 'file-uri', value: 'vscode-remote://ssh-remote+gpu-host/home/user/proj/ws.code-workspace' },
  );
  assert.deepStrictEqual(
    buildWorkspaceArg({ remoteAuthority: 'ssh-remote+gpu-host', workspaceFolders: ['/home/user/proj'] }),
    { kind: 'folder-uri', value: 'vscode-remote://ssh-remote+gpu-host/home/user/proj' },
  );
  // remoteAuthority 已带 vscode-remote:// 前缀时也能容错
  assert.deepStrictEqual(
    buildWorkspaceArg({
      remoteAuthority: 'vscode-remote://ssh-remote+gpu-host/',
      workspaceFolders: ['/home/user/proj'],
    }),
    { kind: 'folder-uri', value: 'vscode-remote://ssh-remote+gpu-host/home/user/proj' },
  );
  // 已是同 authority 的 remote URI：原样透传
  assert.deepStrictEqual(
    buildWorkspaceArg({
      remoteAuthority: 'ssh-remote+gpu-host',
      workspaceFile: 'vscode-remote://ssh-remote+gpu-host/home/user/proj.code-workspace',
    }),
    { kind: 'file-uri', value: 'vscode-remote://ssh-remote+gpu-host/home/user/proj.code-workspace' },
  );
  // 不同 authority：替换
  assert.deepStrictEqual(
    buildWorkspaceArg({
      remoteAuthority: 'ssh-remote+gpu-host-b',
      workspaceFile: 'vscode-remote://ssh-remote+gpu-host/home/user/proj.code-workspace',
    }),
    { kind: 'file-uri', value: 'vscode-remote://ssh-remote+gpu-host-b/home/user/proj.code-workspace' },
  );
  // 已编码的 path 不重复编码
  assert.deepStrictEqual(
    buildWorkspaceArg({
      remoteAuthority: 'ssh-remote+gpu-host',
      workspaceFile: 'file:///home/user/my%20proj/ws.code-workspace',
    }),
    { kind: 'file-uri', value: 'vscode-remote://ssh-remote+gpu-host/home/user/my%20proj/ws.code-workspace' },
  );
});

test('buildWorkspaceArg：无 workspace / vscode.Uri 风格对象', () => {
  assert.deepStrictEqual(buildWorkspaceArg({}), { kind: null, value: null });
  assert.deepStrictEqual(
    buildWorkspaceArg({ remoteAuthority: 'ssh-remote+gpu-host', workspaceFolders: [] }),
    { kind: null, value: null },
  );
  assert.deepStrictEqual(
    buildWorkspaceArg({ workspaceFile: { toString: () => 'file:///tmp/x.code-workspace' } }),
    { kind: 'file-uri', value: 'file:///tmp/x.code-workspace' },
  );
  assert.deepStrictEqual(
    buildWorkspaceArg({ workspaceFolders: [{ uri: { fsPath: '/tmp/proj' } }] }),
    { kind: 'folder-uri', value: pathToFileURL('/tmp/proj').href },
  );
});

test('buildRelaunchSpec：darwin 纯函数，restoreWindows=all 不传 workspace', () => {
  const workspaceArg = { kind: 'file-uri', value: 'file:///tmp/x.code-workspace' };
  const spec = macSpec({ workspaceArg, restoreWindows: 'all' });
  assert.strictEqual(spec.command, 'open');
  assert.deepStrictEqual(spec.args, ['-n', MAC_BUNDLE, '--args', '--remote-debugging-port=9222']);
  assert.ok(!spec.args.includes('--file-uri'));
});

test('buildRelaunchSpec：restoreWindows=empty/none 且存在 workspaceArg 时才透传', () => {
  const workspaceArg = { kind: 'file-uri', value: 'file:///tmp/x.code-workspace' };
  const emptySpec = macSpec({ workspaceArg, restoreWindows: 'empty' });
  assert.deepStrictEqual(emptySpec.args, [
    '-n', MAC_BUNDLE, '--args', '--remote-debugging-port=9222', '--file-uri', 'file:///tmp/x.code-workspace',
  ]);

  const folderArg = { kind: 'folder-uri', value: 'file:///tmp/proj' };
  const noneSpec = macSpec({ workspaceArg: folderArg, restoreWindows: 'none' });
  assert.deepStrictEqual(noneSpec.args.slice(-2), ['--folder-uri', 'file:///tmp/proj']);

  // 没有 workspaceArg 时不传
  const noWorkspace = macSpec({ workspaceArg: null, restoreWindows: 'empty' });
  assert.deepStrictEqual(noWorkspace.args, ['-n', MAC_BUNDLE, '--args', '--remote-debugging-port=9222']);

  // 'preserve' 也按契约不传 workspace 参数
  const preserveSpec = macSpec({ workspaceArg, restoreWindows: 'preserve' });
  assert.deepStrictEqual(preserveSpec.args, ['-n', MAC_BUNDLE, '--args', '--remote-debugging-port=9222']);
});

test('buildRelaunchSpec：win32 / linux / 参数校验', () => {
  const win = buildRelaunchSpec({
    platform: 'win32',
    appBundlePath: 'C:\\Program Files\\Trae CN\\Trae CN.exe',
    port: 9333,
  });
  assert.strictEqual(win.command, 'C:\\Program Files\\Trae CN\\Trae CN.exe');
  assert.deepStrictEqual(win.args, ['--remote-debugging-port=9333']);

  const linux = buildRelaunchSpec({ platform: 'linux', appBundlePath: '/opt/trae-cn/trae', port: 9222 });
  assert.strictEqual(linux.command, '/opt/trae-cn/trae');
  assert.deepStrictEqual(linux.args, ['--remote-debugging-port=9222']);

  assert.throws(() => buildRelaunchSpec({ platform: 'aix', appBundlePath: '/x', port: 9222 }), /不支持的平台/);
  assert.throws(() => buildRelaunchSpec({ platform: 'darwin', appBundlePath: '', port: 9222 }), TypeError);
  assert.throws(() => buildRelaunchSpec({ platform: 'darwin', appBundlePath: MAC_BUNDLE, port: 0 }), RangeError);
});

test('createGuardScript：darwin 生成等待退出后 open -n 的脚本（0600）', (t) => {
  const dir = makeDir(t);
  const workspaceArg = { kind: 'folder-uri', value: 'file:///tmp/proj' };
  const spec = macSpec({ workspaceArg, restoreWindows: 'empty' });

  const guard = createGuardScript({ platform: 'darwin', spec, tmpDir: dir });
  assert.ok(fs.existsSync(guard.scriptPath));
  assert.strictEqual(fs.statSync(guard.scriptPath).mode & 0o777, 0o600);
  assert.strictEqual(guard.command, '/bin/sh');
  assert.deepStrictEqual(guard.args, [guard.scriptPath]);

  const content = fs.readFileSync(guard.scriptPath, 'utf8');
  assert.ok(content.startsWith('#!/bin/sh\n'));
  assert.ok(content.includes("PATTERN='/Applications/Trae CN\\.app/Contents/MacOS/Electron'"), content);
  assert.ok(content.includes('while pgrep -f "$PATTERN" >/dev/null 2>&1; do'));
  assert.ok(content.includes('sleep 1'));
  assert.ok(
    content.includes("exec open -n '/Applications/Trae CN.app' --args --remote-debugging-port=9222 --folder-uri file:///tmp/proj"),
    content,
  );
  // 无 logPath 时不应出现日志重定向
  assert.ok(!content.includes('exec >>'));
});

test('createGuardScript：darwin 带 logPath 时追加日志重定向', (t) => {
  const dir = makeDir(t);
  const spec = macSpec();
  const logPath = path.join(dir, 'guard log.txt');

  const guard = createGuardScript({ platform: 'darwin', spec, logPath, tmpDir: dir });
  const content = fs.readFileSync(guard.scriptPath, 'utf8');
  assert.ok(content.includes(`LOG='${logPath}'`), content);
  assert.ok(content.includes('exec >>"$LOG" 2>&1'));
});

test('createGuardScript：linux 生成 POSIX 脚本', (t) => {
  const dir = makeDir(t);
  const spec = { command: '/opt/trae-cn/trae', args: ['--remote-debugging-port=9222'] };
  const guard = createGuardScript({ platform: 'linux', spec, tmpDir: dir });

  assert.strictEqual(guard.command, '/bin/sh');
  assert.strictEqual(fs.statSync(guard.scriptPath).mode & 0o777, 0o600);
  const content = fs.readFileSync(guard.scriptPath, 'utf8');
  assert.ok(content.includes('PATTERN=/opt/trae-cn/trae'), content);
  assert.ok(content.includes('exec /opt/trae-cn/trae --remote-debugging-port=9222'), content);
});

test('createGuardScript：win32 生成 PowerShell 脚本', (t) => {
  const dir = makeDir(t);
  const exe = 'C:\\Program Files\\Trae CN\\Trae CN.exe';
  const spec = buildRelaunchSpec({ platform: 'win32', appBundlePath: exe, port: 9222 });
  const logPath = path.join(dir, 'guard.log');

  const guard = createGuardScript({ platform: 'win32', spec, logPath, tmpDir: dir });
  assert.ok(guard.scriptPath.endsWith('.ps1'));
  assert.strictEqual(guard.command, 'powershell.exe');
  assert.deepStrictEqual(guard.args.slice(0, 3), ['-NoProfile', '-ExecutionPolicy', 'Bypass']);
  assert.strictEqual(guard.args[guard.args.length - 1], guard.scriptPath);
  assert.strictEqual(fs.statSync(guard.scriptPath).mode & 0o777, 0o600);

  const content = fs.readFileSync(guard.scriptPath, 'utf8');
  assert.ok(content.includes('Start-Process -FilePath $exe -ArgumentList $launchArgs'));
  assert.ok(content.includes("'--remote-debugging-port=9222'"));
  assert.ok(content.includes('Start-Transcript'));
  assert.ok(content.includes("'Trae CN'"), content);
});

test('createGuardScript：非法参数抛错', (t) => {
  const dir = makeDir(t);
  assert.throws(() => createGuardScript({ platform: 'darwin', spec: null, tmpDir: dir }), TypeError);
  assert.throws(() => createGuardScript({ platform: 'darwin', spec: macSpec(), tmpDir: '' }), TypeError);
  assert.throws(() => createGuardScript({ platform: 'aix', spec: macSpec(), tmpDir: dir }), /不支持的平台/);
  // spec 里没有 CDP 参数
  assert.throws(
    () => createGuardScript({ platform: 'darwin', spec: { command: 'open', args: ['-n', MAC_BUNDLE] }, tmpDir: dir }),
    /--remote-debugging-port/,
  );
});

test('copyLaunchCommand：可复制命令', () => {
  const darwinCommand = copyLaunchCommand(macSpec());
  assert.strictEqual(darwinCommand, "open -n '/Applications/Trae CN.app' --args --remote-debugging-port=9222");
  assert.ok(darwinCommand.includes("'/Applications/Trae CN.app'"));

  const winCommand = copyLaunchCommand(
    buildRelaunchSpec({ platform: 'win32', appBundlePath: 'C:\\Program Files\\Trae CN\\Trae CN.exe', port: 9222 }),
  );
  assert.ok(winCommand.startsWith('"C:\\Program Files\\Trae CN\\Trae CN.exe"'), winCommand);
  assert.ok(winCommand.includes('--remote-debugging-port=9222'));

  const linuxCommand = copyLaunchCommand(
    buildRelaunchSpec({ platform: 'linux', appBundlePath: '/opt/trae-cn/trae', port: 9222 }),
  );
  assert.strictEqual(linuxCommand, '/opt/trae-cn/trae --remote-debugging-port=9222');
});

test('launchDetached：不阻塞、不抛错（仅启动本进程 node 做冒烟）', () => {
  assert.doesNotThrow(() => {
    launchDetached({ command: process.execPath, args: ['-e', 'process.exit(0)'] });
  });
  assert.throws(() => launchDetached({ command: '' }), TypeError);
});
