'use strict';

/** 纯函数工具：时间范围、格式化、远程 authority 解析。可被 node --test 直接测试。 */

function pad(n) { return String(n).padStart(2, '0'); }

function startOfToday(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function startOfWeek(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekday = (d.getDay() + 6) % 7; // 周一 = 0
  d.setDate(d.getDate() - weekday);
  return d.getTime();
}

function startOfMonth(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

/** 返回包含今天在内的滚动日期范围起点，使用本地日历避免跨 DST 时偏移。 */
function startOfDaysAgo(daysAgo, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

function rangeToSinceMs(range, now = new Date()) {
  switch (range) {
    case 'today': return startOfToday(now);
    case 'week': return startOfDaysAgo(6, now);
    case 'month': return startOfDaysAgo(29, now);
    default: return null;
  }
}

function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}k`;
  return String(Math.round(v));
}

function formatCredits(n) {
  const v = Number(n) || 0;
  if (v >= 1000) return `${(v / 1000).toFixed(2)}k`;
  return v.toFixed(2);
}

function formatDateTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 解码 remoteAuthority 里携带的远程信息。Trae 的 icube SSH remote 使用
 * **hex 编码的 JSON**（如 7b22686f73744e616d65223a...），VS Code 原生 remote-ssh
 * 使用 base64url JSON，也可能直接是主机名。逐个尝试，失败返回 null。
 */
function decodeAuthorityBody(body) {
  if (!body) return null;
  const tryParseJson = (text) => {
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  // 1) hex 编码 JSON（Trae icube）
  if (/^[0-9a-fA-F]+$/.test(body) && body.length % 2 === 0) {
    const decoded = tryParseJson(Buffer.from(body, 'hex').toString('utf8'));
    if (decoded) return decoded;
  }
  // 2) base64url / base64 JSON（VS Code remote-ssh）
  try {
    const b64 = body.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = tryParseJson(Buffer.from(b64, 'base64').toString('utf8'));
    if (decoded) return decoded;
  } catch { /* ignore */ }
  // 3) percent-encoded JSON
  try {
    const decoded = tryParseJson(decodeURIComponent(body));
    if (decoded) return decoded;
  } catch { /* ignore */ }
  return null;
}

/**
 * 从 ssh-remote+<hex/base64 JSON>、ssh-remote+host、wsl+... 解析远程主机名。
 */
function parseRemoteAuthority(authority) {
  if (!authority) return null;
  const raw = String(authority);
  const plus = raw.indexOf('+');
  const kind = plus >= 0 ? raw.slice(0, plus) : raw;
  const body = plus >= 0 ? raw.slice(plus + 1) : '';
  if (kind !== 'ssh-remote') return kind || raw;
  const decoded = decodeAuthorityBody(body);
  if (decoded) {
    return decoded.hostname || decoded.host || decoded.hostName || decoded.name || body || 'ssh';
  }
  return body || 'ssh';
}

const RANGE_ITEMS = [
  { label: '今日', value: 'today' },
  { label: '近 7 日', value: 'week' },
  { label: '近 30 日', value: 'month' },
  { label: '全部', value: 'all' }
];

/** 校验时间范围枚举，非法值回退（供 IDE 与独立端共用，避免重复实现）。 */
function normalizeRange(value, fallback = 'today') {
  const valid = (v) => RANGE_ITEMS.some((item) => item.value === v);
  if (valid(value)) return value;
  return valid(fallback) ? fallback : 'today';
}

module.exports = {
  pad,
  startOfToday,
  startOfWeek,
  startOfMonth,
  startOfDaysAgo,
  rangeToSinceMs,
  formatTokens,
  formatCredits,
  formatDateTime,
  parseRemoteAuthority,
  RANGE_ITEMS,
  normalizeRange
};
