'use strict';

/**
 * src/setup/argv.js
 *
 * 修改 Trae CN 的 argv.json，写入/移除 CDP 调试端口（契约 docs/INTERFACES.md §8）。
 *
 * 要点：
 * - parseJsonc 容错 //、/* *\/ 注释与尾逗号（Trae/VS Code 的 argv.json 是 JSONC）；
 * - 写前备份：<argvPath>.bak-<ISO时间戳>（权限 0600）；
 * - 原子写：同目录临时文件 + rename；
 * - 保留原键与缩进风格（2 空格 + 末尾换行）；
 * - enableCdp / disableCdp 幂等。
 *
 * 注意：本模块只操作传入的 argvPath，不直接读写 ~/.trae-cn（由扩展层拼路径）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CDP_ARGV_KEY = 'remote-debugging-port';
const BACKUP_MODE = 0o600;

/**
 * 去掉 JSONC 注释（字符串内的 // 与 /* 不处理）。
 * @param {string} text
 * @returns {string}
 */
function stripJsoncComments(text) {
  let out = '';
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const ch = text[index];
    const next = text[index + 1];

    if (inString) {
      out += ch;
      if (ch === '\\') {
        if (index + 1 < text.length) {
          out += text[index + 1];
          index += 2;
          continue;
        }
        index += 1;
        continue;
      }
      if (ch === '"') inString = false;
      index += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      index += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

/**
 * 去掉对象/数组末尾的多余逗号（字符串内不处理）。
 * @param {string} text
 * @returns {string}
 */
function stripTrailingCommas(text) {
  let out = '';
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const ch = text[index];

    if (inString) {
      out += ch;
      if (ch === '\\') {
        if (index + 1 < text.length) {
          out += text[index + 1];
          index += 2;
          continue;
        }
        index += 1;
        continue;
      }
      if (ch === '"') inString = false;
      index += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      index += 1;
      continue;
    }
    if (ch === ',') {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1;
      if (text[lookahead] === '}' || text[lookahead] === ']') {
        index += 1; // 丢弃这个尾逗号
        continue;
      }
    }
    out += ch;
    index += 1;
  }
  return out;
}

/**
 * 解析 JSONC 文本（容错注释与尾逗号），要求顶层是对象。
 * @param {string} text
 * @returns {object}
 */
function parseJsonc(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseJsonc(text): text 必须是字符串');
  }
  const withoutBom = text.replace(/^\uFEFF/, '');
  if (withoutBom.trim() === '') return {};

  const cleaned = stripTrailingCommas(stripJsoncComments(withoutBom));
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`argv.json 解析失败: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('argv.json 解析失败: 顶层必须是 JSON 对象');
  }
  return parsed;
}

/**
 * 读取 argv.json。
 * @param {string} argvPath
 * @returns {{config: object, existed: boolean}}
 */
function readArgvFile(argvPath) {
  if (typeof argvPath !== 'string' || argvPath.length === 0) {
    throw new TypeError('readArgvFile(argvPath): argvPath 必须是非空字符串');
  }
  let text;
  try {
    text = fs.readFileSync(argvPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { config: {}, existed: false };
    throw err;
  }
  if (text.trim() === '') return { config: {}, existed: true };
  return { config: parseJsonc(text), existed: true };
}

/** ISO 时间戳转成文件名安全格式（去掉 : 与 .，兼容 Windows）。 */
function timestampForFileName(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** 返回一个当前不存在的路径（同名已存在时追加 -1/-2...）。 */
function nextAvailablePath(candidate) {
  if (!fs.existsSync(candidate)) return candidate;
  let index = 1;
  while (fs.existsSync(`${candidate}-${index}`)) index += 1;
  return `${candidate}-${index}`;
}

/**
 * 备份路径辅助。名称约定：argv.json.bak-<ISO时间戳>。
 *
 * - 传入 argv.json 路径时：复制为 `<argvPath>.bak-<ISO时间戳>`，返回备份路径；
 * - 传入已存在的备份路径时：复制为带 `-1/-2...` 后缀的唯一副本，返回副本路径。
 *
 * 文件权限统一 0600；不覆盖已有备份。
 * @param {string} targetPath
 * @returns {string} 实际备份文件路径
 */
function copyBackupPath(targetPath) {
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    throw new TypeError('copyBackupPath(targetPath): targetPath 必须是非空字符串');
  }
  const isBackupPath = /\.bak-\d{4}-\d{2}-\d{2}T/.test(path.basename(targetPath));
  const candidate = isBackupPath
    ? `${targetPath}-copy-${timestampForFileName()}`
    : `${targetPath}.bak-${timestampForFileName()}`;
  const backupPath = nextAvailablePath(candidate);
  fs.mkdirSync(path.dirname(path.resolve(backupPath)), { recursive: true });
  fs.copyFileSync(targetPath, backupPath);
  fs.chmodSync(backupPath, BACKUP_MODE);
  return backupPath;
}

/**
 * 备份已存在的 argv.json；不存在返回 null。
 * @param {string} argvPath
 * @returns {string|null}
 */
function backupArgvIfExists(argvPath) {
  let stat;
  try {
    stat = fs.statSync(argvPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  if (!stat.isFile()) {
    throw new Error(`备份 argv.json 失败: ${argvPath} 不是普通文件`);
  }
  return copyBackupPath(argvPath);
}

/**
 * 原子写 argv.json（临时文件 + rename，权限 0600，2 空格缩进 + 末尾换行）。
 * @param {string} argvPath
 * @param {object} config
 */
function writeArgvFile(argvPath, config) {
  const resolved = path.resolve(argvPath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(
    dir,
    `.${path.basename(resolved)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
  );
  const text = `${JSON.stringify(config, null, 2)}\n`;
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'w', BACKUP_MODE);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, resolved);
    fs.chmodSync(resolved, BACKUP_MODE);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw new Error(`写入 argv.json 失败: ${err.message}`, { cause: err });
  }
}

function normalizePort(port) {
  const num = Number(port);
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    throw new RangeError(`port 必须是 1-65535 的整数，收到 ${String(port)}`);
  }
  return num;
}

/**
 * 写入 CDP 端口到 argv.json（`remote-debugging-port` 键），重复调用幂等。
 * @param {{argvPath: string, port: number}} options
 * @returns {{changed: boolean, backupPath: string|null, config: object}}
 */
function enableCdp(options = {}) {
  const { argvPath, port } = options;
  if (typeof argvPath !== 'string' || argvPath.length === 0) {
    throw new TypeError('enableCdp({argvPath}): argvPath 必须是非空字符串');
  }
  const cdpPort = normalizePort(port);
  const { config, existed } = readArgvFile(argvPath);
  const existingValue = config[CDP_ARGV_KEY];

  // 注意：Trae 的 argv.json 解析器只对 **字符串** 值调用 appendSwitch
  // （见 Trae main.js 的 argv 处理：`typeof value === "string"` 才生效），
  // 因此这里必须写入字符串 "9222"，写数字 9222 会被静默忽略。
  const alreadyString = typeof existingValue === 'string';
  if (Number(existingValue) === cdpPort && alreadyString) {
    return { changed: false, backupPath: null, config };
  }

  const nextConfig = { ...config, [CDP_ARGV_KEY]: String(cdpPort) };
  const backupPath = existed ? backupArgvIfExists(argvPath) : null;
  writeArgvFile(argvPath, nextConfig);
  return { changed: true, backupPath, config: nextConfig };
}

/**
 * 从 argv.json 移除 CDP 端口键，重复调用幂等。
 * @param {{argvPath: string}} options
 * @returns {{changed: boolean, backupPath: string|null, config: object}}
 */
function disableCdp(options = {}) {
  const { argvPath } = options;
  if (typeof argvPath !== 'string' || argvPath.length === 0) {
    throw new TypeError('disableCdp({argvPath}): argvPath 必须是非空字符串');
  }
  const { config, existed } = readArgvFile(argvPath);
  if (!Object.prototype.hasOwnProperty.call(config, CDP_ARGV_KEY)) {
    return { changed: false, backupPath: null, config };
  }

  const nextConfig = { ...config };
  delete nextConfig[CDP_ARGV_KEY];
  const backupPath = existed ? backupArgvIfExists(argvPath) : null;
  writeArgvFile(argvPath, nextConfig);
  return { changed: true, backupPath, config: nextConfig };
}

module.exports = {
  parseJsonc,
  readArgvFile,
  enableCdp,
  disableCdp,
  copyBackupPath,
};
