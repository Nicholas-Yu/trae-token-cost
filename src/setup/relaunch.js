'use strict';

/**
 * src/setup/relaunch.js
 *
 * 重启/带 CDP 端口启动 Trae CN 的纯函数与守护脚本生成（契约 docs/INTERFACES.md §9）。
 *
 * - buildWorkspaceArg：把 remoteAuthority / workspaceFile / workspaceFolders 换算成
 *   `--file-uri` / `--folder-uri` 需要的 URI（支持传入 URI 字符串或 vscode.Uri 风格对象）；
 * - buildRelaunchSpec：darwin/win32/linux 的启动命令（纯函数，可单测）；
 * - createGuardScript：生成“等 Trae 退出后再重开”的守护脚本（macOS/Linux 用 sh，Windows 用 PowerShell）；
 * - launchDetached：detached + unref 启动；
 * - copyLaunchCommand：生成可复制的启动命令。
 *
 * 注意：模块本身不会启动 Trae（launchDetached 只在扩展命令里被调用；测试不实际执行）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const SUPPORTED_PLATFORMS = ['darwin', 'win32', 'linux'];
const CDP_ARG_PREFIX = '--remote-debugging-port=';

/** 判断字符串是否已是 URI（scheme://...）。 */
function isUriLike(value) {
  return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

/**
 * 归一化 remoteAuthority：允许传 'ssh-remote+gpu-host' 或 'vscode-remote://ssh-remote+gpu-host'。
 * @param {string|null|undefined} remoteAuthority
 * @returns {string|null}
 */
function normalizeAuthority(remoteAuthority) {
  if (typeof remoteAuthority !== 'string') return null;
  let authority = remoteAuthority.trim();
  if (!authority) return null;
  authority = authority.replace(/^vscode-remote:\/\//i, '').replace(/\/+$/, '');
  return authority || null;
}

/** 文件系统路径 → 远程 path（POSIX；Windows 盘符转换为 /c:/... 形式）。 */
function toRemotePath(filePath) {
  let posix = String(filePath).replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(posix)) posix = `/${posix}`;
  else if (!posix.startsWith('/')) posix = `/${posix}`;
  return posix;
}

/** 对远程 path 做最小转义（保留分隔符与盘符冒号）。 */
function encodeRemotePath(posixPath) {
  return posixPath
    .split('/')
    .map((segment) => (segment === '' ? '' : encodeURIComponent(segment).replace(/%3A/gi, ':')))
    .join('/');
}

/**
 * 把 workspaceFile / workspaceFolders 里的值（URI 字符串、普通路径或 vscode.Uri 风格对象）转成字符串。
 * @param {*} value
 * @returns {string|null}
 */
function pathValueOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'object') {
    if (typeof value.uri === 'string') return value.uri.length > 0 ? value.uri : null;
    if (value.uri && typeof value.uri === 'object') {
      if (typeof value.uri.toString === 'function' && value.uri.toString !== Object.prototype.toString) {
        try {
          const str = value.uri.toString();
          if (typeof str === 'string' && str.length > 0) return str;
        } catch { /* ignore */ }
      }
      if (typeof value.uri.fsPath === 'string' && value.uri.fsPath.length > 0) return value.uri.fsPath;
      if (typeof value.uri.path === 'string' && value.uri.path.length > 0) return value.uri.path;
    }
    if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
      try {
        const str = value.toString();
        if (typeof str === 'string' && str.length > 0) return str;
      } catch { /* ignore */ }
    }
    if (typeof value.fsPath === 'string' && value.fsPath.length > 0) return value.fsPath;
    if (typeof value.path === 'string' && value.path.length > 0) return value.path;
  }
  return null;
}

/**
 * 生成 --file-uri / --folder-uri 的值。
 * @param {string} value 普通路径或 URI 字符串
 * @param {string|null} remote 归一化后的 remoteAuthority
 * @returns {string}
 */
function buildTargetUri(value, remote) {
  if (isUriLike(value)) {
    if (!remote) return value;
    let url;
    try {
      url = new URL(value);
    } catch {
      return value;
    }
    if (url.protocol === 'vscode-remote:') {
      // 已经是 remote URI：authority 不一致时替换，保持一致时原样返回（避免 URL 归一化改变编码）。
      if (url.host === remote) return value;
      return `vscode-remote://${remote}${url.pathname}${url.search}${url.hash}`;
    }
    if (url.protocol === 'file:') {
      let decodedPath = url.pathname;
      try {
        decodedPath = decodeURIComponent(url.pathname);
      } catch { /* 保留原 pathname */ }
      return `vscode-remote://${remote}${encodeRemotePath(toRemotePath(decodedPath))}${url.search}${url.hash}`;
    }
    return value;
  }
  if (remote) {
    return `vscode-remote://${remote}${encodeRemotePath(toRemotePath(value))}`;
  }
  return pathToFileURL(path.resolve(value)).href;
}

/**
 * 计算重新启动时要带的 workspace 参数。
 * @param {{remoteAuthority?: string|null, workspaceFile?: *, workspaceFolders?: *[]}} options
 * @returns {{kind: 'file-uri'|'folder-uri'|null, value: string|null}}
 */
function buildWorkspaceArg(options = {}) {
  const {
    remoteAuthority = null,
    workspaceFile = null,
    workspaceFolders = [],
  } = options || {};

  const remote = normalizeAuthority(remoteAuthority);
  const fileValue = pathValueOf(workspaceFile);
  if (fileValue) {
    return { kind: 'file-uri', value: buildTargetUri(fileValue, remote) };
  }

  const folders = Array.isArray(workspaceFolders)
    ? workspaceFolders
    : (workspaceFolders ? [workspaceFolders] : []);
  for (const folder of folders) {
    const folderValue = pathValueOf(folder);
    if (folderValue) {
      return { kind: 'folder-uri', value: buildTargetUri(folderValue, remote) };
    }
  }

  return { kind: null, value: null };
}

function normalizePort(port) {
  const num = Number(port);
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    throw new RangeError(`port 必须是 1-65535 的整数，收到 ${String(port)}`);
  }
  return num;
}

/**
 * 构造带 CDP 端口的启动命令（纯函数）。
 *
 * restoreWindows 语义（契约 §9）：
 * - 'all'（默认）：不传 workspace 参数，依赖 Trae 会话恢复，避免双开窗口；
 * - 'none' / 'empty'：存在 workspaceArg 时透传 --file-uri / --folder-uri。
 *
 * @param {{platform: string, appBundlePath: string, port: number, workspaceArg?: object|null, restoreWindows?: string}} options
 * @returns {{command: string, args: string[]}}
 */
function buildRelaunchSpec(options = {}) {
  const {
    platform,
    appBundlePath,
    port,
    workspaceArg = null,
    restoreWindows = 'all',
  } = options || {};

  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    throw new Error(`buildRelaunchSpec: 不支持的平台 ${String(platform)}（支持 ${SUPPORTED_PLATFORMS.join('/')}）`);
  }
  if (typeof appBundlePath !== 'string' || appBundlePath.length === 0) {
    throw new TypeError('buildRelaunchSpec: appBundlePath 必须是非空字符串');
  }
  const cdpPort = normalizePort(port);

  const workspaceFlags = [];
  const hasWorkspace = Boolean(workspaceArg && workspaceArg.kind && workspaceArg.value);
  // 契约 §9：'all'（默认）不传 workspace，依赖会话恢复避免双开；
  // 只有显式要求 'none'/'empty'（不恢复窗口）时才透传 workspace 参数。
  const passWorkspace = hasWorkspace && (restoreWindows === 'none' || restoreWindows === 'empty');
  if (passWorkspace) {
    workspaceFlags.push(`--${workspaceArg.kind}`, String(workspaceArg.value));
  }

  const debugFlag = `${CDP_ARG_PREFIX}${cdpPort}`;

  if (platform === 'darwin') {
    // open -n "<bundle>" --args --remote-debugging-port=<port> [...workspace]
    return { command: 'open', args: ['-n', appBundlePath, '--args', debugFlag, ...workspaceFlags] };
  }
  // Windows / Linux：直接启动可执行文件（尽力而为）。
  return { command: appBundlePath, args: [debugFlag, ...workspaceFlags] };
}

/** POSIX shell 单引号转义。 */
function shQuote(value) {
  const str = String(value);
  if (str !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(str)) return str;
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/** PowerShell 单引号转义。 */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** 从 spec 的 args 中找出 .app 路径（仅 darwin 守护脚本用）。 */
function extractDarwinBundle(spec) {
  const args = Array.isArray(spec.args) ? spec.args.map(String) : [];
  const found = args.find((arg) => /\.app\/?$/i.test(arg));
  if (found) return found.replace(/\/+$/, '');
  if (typeof spec.command === 'string' && /\.app\/?$/i.test(spec.command)) {
    return spec.command.replace(/\/+$/, '');
  }
  throw new Error('createGuardScript: 无法从 spec 推断 .app 路径（darwin 的 spec.args 中应包含 "/Applications/Trae CN.app"）');
}

/** 从 spec 中提取 CDP 端口（仅用于脚本注释/校验）。 */
function extractPort(spec) {
  const args = Array.isArray(spec.args) ? spec.args.map(String) : [];
  for (let i = 0; i < args.length; i += 1) {
    const match = new RegExp(`^${CDP_ARG_PREFIX}(\\d+)$`).exec(args[i]);
    if (match) return Number(match[1]);
    if (args[i] === '--remote-debugging-port' && i + 1 < args.length && /^\d+$/.test(args[i + 1])) {
      return Number(args[i + 1]);
    }
  }
  throw new Error('createGuardScript: spec 中缺少 --remote-debugging-port=<port> 参数');
}

/** 守护脚本里给“进程是否还在运行”的 pgrep 模式做 ERE 转义。 */
function escapePregPattern(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function newScriptPath(tmpDir, extension) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(tmpDir, `trae-cn-relaunch-${stamp}-${crypto.randomBytes(3).toString('hex')}${extension}`);
}

function writeScript(scriptPath, content) {
  fs.writeFileSync(scriptPath, content, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(scriptPath, 0o600);
}

/**
 * 生成“等待 Trae 退出后用 CDP 端口重开”的守护脚本。
 *
 * macOS 脚本流程（契约 §9）：等待 `pgrep -f "<bundle>/Contents/MacOS/Electron"` 无结果 →
 * sleep 1 → `open -n "<bundle>" --args --remote-debugging-port=<port> [workspace]`。
 *
 * @param {{platform: string, spec: {command: string, args: string[]}, logPath?: string|null, tmpDir: string}} options
 * @returns {{scriptPath: string, command: string, args: string[]}}
 */
function createGuardScript(options = {}) {
  const { platform, spec, logPath = null, tmpDir } = options || {};

  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    throw new Error(`createGuardScript: 不支持的平台 ${String(platform)}`);
  }
  if (!spec || typeof spec !== 'object' || typeof spec.command !== 'string' || !Array.isArray(spec.args)) {
    throw new TypeError('createGuardScript: spec 必须是 { command, args }');
  }
  if (typeof tmpDir !== 'string' || tmpDir.length === 0) {
    throw new TypeError('createGuardScript: tmpDir 必须是非空字符串');
  }

  fs.mkdirSync(tmpDir, { recursive: true });
  const logValue = typeof logPath === 'string' && logPath.length > 0 ? logPath : null;
  const port = extractPort(spec);

  if (platform === 'darwin' || platform === 'linux') {
    const bundle = platform === 'darwin' ? extractDarwinBundle(spec) : spec.command;
    const executablePath = platform === 'darwin'
      ? path.join(bundle, 'Contents', 'MacOS', 'Electron')
      : bundle;
    const pattern = escapePregPattern(executablePath);
    const launchLine = [spec.command, ...spec.args.map(String)].map(shQuote).join(' ');

    const lines = [
      '#!/bin/sh',
      '# 由 trae-token-usage 扩展生成：等待 Trae 完全退出后，以 CDP 调试端口重新启动。',
      `# 目标端口: ${port}`,
      'set -u',
    ];
    if (logValue) lines.push(`LOG=${shQuote(logValue)}`);
    if (logValue) lines.push('exec >>"$LOG" 2>&1');
    lines.push(
      `PATTERN=${shQuote(pattern)}`,
      'printf \'%s waiting for Trae to exit...\\n\' "$(date \'+%Y-%m-%dT%H:%M:%S%z\')"',
      'while pgrep -f "$PATTERN" >/dev/null 2>&1; do',
      '  sleep 1',
      'done',
      'sleep 1',
      'printf \'%s relaunching Trae with CDP port\\n\' "$(date \'+%Y-%m-%dT%H:%M:%S%z\')"',
      `exec ${launchLine}`,
      '',
    );

    const scriptPath = newScriptPath(tmpDir, '.sh');
    writeScript(scriptPath, lines.join('\n'));
    return { scriptPath, command: '/bin/sh', args: [scriptPath] };
  }

  // win32：PowerShell 尽力而为脚本。
  const exePath = spec.command;
  const procName = path.win32.basename(exePath).replace(/\.exe$/i, '');
  const launchArgs = spec.args.map(String);
  const lines = [
    '# 由 trae-token-usage 扩展生成：等待 Trae 完全退出后，以 CDP 调试端口重新启动。',
    `# 目标端口: ${port}`,
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$exe = ${psQuote(exePath)}`,
    `$procName = ${psQuote(procName)}`,
    `$launchArgs = @(${launchArgs.map(psQuote).join(', ')})`,
  ];
  if (logValue) lines.push(`Start-Transcript -Path ${psQuote(logValue)} -Append | Out-Null`);
  lines.push(
    'while (Get-Process -Name $procName -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 1 }',
    'Start-Sleep -Seconds 1',
    'Start-Process -FilePath $exe -ArgumentList $launchArgs',
    '',
  );

  const scriptPath = newScriptPath(tmpDir, '.ps1');
  writeScript(scriptPath, lines.join('\n'));
  return {
    scriptPath,
    command: 'powershell.exe',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
  };
}

/**
 * detached + unref 启动进程（不阻塞扩展宿主）。
 * @param {{command: string, args?: string[]}} spec
 */
function launchDetached(spec = {}) {
  const { command, args = [] } = spec || {};
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError('launchDetached: command 必须是非空字符串');
  }
  const argList = Array.isArray(args) ? args.map(String) : [];
  const child = spawn(command, argList, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  // 后台进程启动失败不应该让扩展宿主崩溃。
  child.on('error', () => {});
  if (typeof child.unref === 'function') child.unref();
}

/** 复制命令用的参数转义：Windows 路径用双引号，其它用 POSIX 单引号。 */
function quoteForShell(value) {
  const str = String(value);
  if (/[\s"]/.test(str)) {
    return `"${str.replace(/"/g, '\\"')}"`;
  }
  return str;
}

/**
 * 生成用户可直接粘贴/复制的启动命令。
 * @param {{command: string, args?: string[]}} spec
 * @returns {string}
 */
function copyLaunchCommand(spec = {}) {
  const { command, args = [] } = spec || {};
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError('copyLaunchCommand: command 必须是非空字符串');
  }
  const argList = Array.isArray(args) ? args.map(String) : [];
  const isWindows = /^[A-Za-z]:[\\/]/.test(command) || /\.exe$/i.test(command);
  if (isWindows) {
    return [command, ...argList].map(quoteForShell).join(' ');
  }
  return [command, ...argList].map(shQuote).join(' ');
}

module.exports = {
  buildWorkspaceArg,
  buildRelaunchSpec,
  createGuardScript,
  launchDetached,
  copyLaunchCommand,
};
