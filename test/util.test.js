'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pad,
  startOfToday,
  startOfWeek,
  startOfMonth,
  startOfDaysAgo,
  rangeToSinceMs,
  formatTokens,
  formatCredits,
  formatDateTime,
  parseRemoteAuthority
} = require('../src/util');

test('pad 补零', () => {
  assert.equal(pad(1), '01');
  assert.equal(pad(12), '12');
});

test('时间范围：今日、近 7 日、近 30 日均从本地零点开始', () => {
  const now = new Date(2026, 10, 9, 16, 30, 0);
  const today = startOfToday(now);
  const week = rangeToSinceMs('week', now);
  const month = rangeToSinceMs('month', now);
  assert.equal(new Date(today).getHours(), 0);
  assert.equal(new Date(today).getDate(), 9);
  assert.equal(new Date(week).getDate(), 3, '近 7 日包含今天及此前 6 天');
  assert.equal(new Date(month).getDate(), 11, '近 30 日包含今天及此前 29 天');
  assert.equal(new Date(month).getMonth(), 9);
  assert.equal(startOfDaysAgo(6, now), week);
  assert.equal(startOfDaysAgo(29, now), month);
  assert.equal(rangeToSinceMs('all', now), null);
  assert.equal(rangeToSinceMs('today', now), today);
  assert.equal(rangeToSinceMs('unknown', now), null);
});

test('formatTokens 单位', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(12345), '1.2k');
  assert.equal(formatTokens(1234567), '1.23M');
  assert.equal(formatTokens(123456789), '1.23亿');
  assert.equal(formatTokens(undefined), '0');
});

test('formatCredits 保留两位', () => {
  assert.equal(formatCredits(1.239), '1.24');
  assert.equal(formatCredits(1234), '1.23k');
  assert.equal(formatCredits(null), '0.00');
});

test('formatDateTime 输出本地时间', () => {
  const ms = new Date(2026, 10, 9, 8, 5, 4).getTime();
  assert.equal(formatDateTime(ms), '2026-11-09 08:05:04');
  assert.equal(formatDateTime(0), '—');
});

test('parseRemoteAuthority 解 hex 编码 JSON（Trae icube SSH）', () => {
  const payload = { hostname: 'gpu-host', fromConfig: true };
  const hex = Buffer.from(JSON.stringify(payload), 'utf8').toString('hex');
  assert.equal(parseRemoteAuthority(`ssh-remote+${hex}`), 'gpu-host');
  // Trae 实际使用 hex 编码 JSON 的 remoteAuthority
  const traeHex = Buffer.from(JSON.stringify({ hostname: 'gpu-host', fromConfig: true }), 'utf8').toString('hex');
  assert.equal(parseRemoteAuthority(`ssh-remote+${traeHex}`), 'gpu-host');
});

test('parseRemoteAuthority 解 base64url JSON（VS Code remote-ssh）', () => {
  const payload = { hostname: 'gpu-host', fromConfig: true };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(parseRemoteAuthority(`ssh-remote+${b64}`), 'gpu-host');
  assert.equal(parseRemoteAuthority('ssh-remote+gpu-host'), 'gpu-host');
  assert.equal(parseRemoteAuthority('ssh-remote+devbox.local'), 'devbox.local');
  assert.equal(parseRemoteAuthority('wsl+Ubuntu'), 'wsl');
  assert.equal(parseRemoteAuthority(null), null);
});

test('normalizeRange：合法透传、非法回退', () => {
  const { normalizeRange } = require('../src/util');
  assert.equal(normalizeRange('week'), 'week');
  assert.equal(normalizeRange('all'), 'all');
  assert.equal(normalizeRange('bogus'), 'today');
  assert.equal(normalizeRange(undefined), 'today');
  assert.equal(normalizeRange('bogus', 'month'), 'month');
  assert.equal(normalizeRange('bogus', 'also-bad'), 'today');
});
