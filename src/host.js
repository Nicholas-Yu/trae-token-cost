'use strict';

/**
 * src/host.js
 *
 * 窗口标题解析（契约 docs/INTERFACES.md §7）。
 *
 * Trae CN / VS Code 的远程窗口标题通常形如：
 *   "my-project [SSH: gpu-host] — Trae CN"
 *   "my-project [SSH:host] - Trae CN"
 *   "my-project [远程: gpu-host] — Trae CN"
 *   "my-project [远程] gpu-host — Trae CN"
 * 本机窗口没有远程标记：
 *   "my-project — Trae CN"
 *
 * 所有函数都是纯函数，便于单测，零第三方依赖。
 */

/** 应用名后缀：标题里会带 " — Trae CN" / " - Visual Studio Code" 等。 */
const APP_NAME = '(?:Trae(?:\\s+CN)?|Visual\\s+Studio\\s+Code|VS\\s+Code)';

/** 末尾应用名前缀，要求分隔符前有空白，避免误伤 "my-project-Trae CN" 这类名字。 */
const APP_SUFFIX_RE = new RegExp(`\\s+[\\u2014\\u2013-]\\s*${APP_NAME}\\s*$`, 'i');

/** 带方括号的远程标记：[SSH: gpu-host] / [SSH:host] / [远程: gpu-host] / [Remote: x] / [SSH] / [远程] */
const BRACKET_REMOTE_RE = /\[\s*(?:SSH|远程|Remote)\s*(?:[:：]\s*([^\]\s]+))?\s*\]/i;

/** 不带方括号的远程标记："xxx — SSH: gpu-host" / "xxx 远程: gpu-host" */
const PLAIN_REMOTE_RE = /(?:^|[\s\u2014\u2013-])(?:SSH|远程|Remote)\s*[:：]\s*([^\s\u2014\u2013]+)/i;

/** 仅由应用名组成的标题，不应当作工作区名。 */
const APP_ONLY_RE = new RegExp(`^(?:${APP_NAME})$`, 'i');

/** 标题里可能出现的多余空白/分隔符。 */
const EDGE_SEP_RE = /^[\s\u2014\u2013-]+|[\s\u2014\u2013-]+$/g;
const INNER_SEP_RE = /\s+[\u2014\u2013-]\s+/;

/**
 * 去掉窗口标题末尾的应用名后缀（" — Trae CN"、" - Trae CN"、" — Visual Studio Code" 等）。
 * 反复剥离，兼容 "x — Trae CN - Visual Studio Code" 这类叠层标题。
 * @param {string} title
 * @returns {string}
 */
function sanitizeWindowTitle(title) {
  if (typeof title !== 'string' || title.length === 0) return '';
  let out = title.replace(/\s+$/, '');
  for (let i = 0; i < 5; i += 1) {
    const next = out.replace(APP_SUFFIX_RE, '');
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

/**
 * 从标题中剥离远程标记，返回 { host, rest }。
 * host 为 null 表示没有识别到远程标记（本机）。
 */
function stripRemoteMarker(title) {
  const bracket = BRACKET_REMOTE_RE.exec(title);
  if (bracket) {
    let host = (bracket[1] || '').trim();
    let rest = title.slice(0, bracket.index) + ' ' + title.slice(bracket.index + bracket[0].length);
    if (!host) {
      // "[SSH] gpu-host" / "[远程] host"：标记之后的第一个 token 是主机标签。
      const tail = title.slice(bracket.index + bracket[0].length);
      const m = /^\s*([^\s\u2014\u2013[\]]+)/.exec(tail);
      if (m) {
        host = m[1];
        rest = title.slice(0, bracket.index) + ' ' + tail.slice(m[0].length);
      }
    }
    return { host: host || null, rest };
  }

  const plain = PLAIN_REMOTE_RE.exec(title);
  if (plain) {
    const host = (plain[1] || '').trim();
    if (host) {
      // 连带去掉标记前的分隔符，避免残留 " — " 被当成工作区名。
      const start = plain.index + Math.max(0, plain[0].search(/(?:SSH|远程|Remote)/i));
      const rest = title.slice(0, start) + ' ' + title.slice(plain.index + plain[0].length);
      return { host, rest };
    }
  }
  return { host: null, rest: title };
}

/**
 * 把剥离远程标记后的剩余部分转换成工作区名。
 * @param {string} text
 * @returns {string|null}
 */
function deriveWorkspaceName(text) {
  if (typeof text !== 'string') return null;
  let out = text.trim();
  if (!out) return null;

  // 去掉首尾分隔符/空白。
  out = out.replace(EDGE_SEP_RE, '').replace(/\s+/g, ' ').trim();
  if (!out) return null;

  // "file — project — Trae CN" 这类多段标题：最后一段才是工作区名。
  if (INNER_SEP_RE.test(out)) {
    const parts = out.split(INNER_SEP_RE).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) out = parts[parts.length - 1];
  }

  out = out.replace(EDGE_SEP_RE, '').trim();
  if (!out || APP_ONLY_RE.test(out)) return null;
  return out;
}

/**
 * 解析窗口标题。
 * @param {string} windowTitle
 * @returns {{host: string|null, workspaceName: string|null}}
 */
function parseWindowTitle(windowTitle) {
  if (typeof windowTitle !== 'string' || windowTitle.trim() === '') {
    return { host: null, workspaceName: null };
  }
  const stripped = stripRemoteMarker(windowTitle);
  const host = stripped.host || null;
  const clean = sanitizeWindowTitle(stripped.rest);
  const workspaceName = deriveWorkspaceName(clean);
  return { host, workspaceName };
}

/**
 * 从窗口标题推导主机标签；识别不到远程标记时返回 '本机'。
 * @param {string} windowTitle
 * @returns {string}
 */
function deriveHostLabel(windowTitle) {
  const { host } = parseWindowTitle(windowTitle);
  return host || '本机';
}

module.exports = {
  deriveHostLabel,
  parseWindowTitle,
  sanitizeWindowTitle,
  // 内部工具也导出，便于测试/复用（不影响契约）。
  deriveWorkspaceName,
  stripRemoteMarker,
};
