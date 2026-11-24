const test = require('node:test');
const assert = require('node:assert/strict');
const { startStandaloneServer } = require('../src/standalone/server');
const { makeUsageFixture } = require('./harness/standalone');
const http = require('node:http');

function rawStatus(appUrl, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port: Number(new URL(appUrl).port),
      path: requestPath,
      headers
    }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
  });
}

async function start(t) {
  const fixture = makeUsageFixture(t);
  const app = await startStandaloneServer({ ...fixture, port: 0 });
  t.after(async () => app.close());
  return app;
}

test('HTTP 页面与 API 使用独立适配器、CSP 和 no-store', async (t) => {
  const app = await start(t);
  assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const response = await fetch(app.url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const html = await response.text();
  assert.doesNotMatch(html, /acquireVsCodeApi/);
  assert.doesNotMatch(html, /\{\{[a-zA-Z]+\}\}/);
  assert.match(html, /connect-src 'self'/);
  assert.match(html, /standalone":true/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);

  const api = await fetch(`${app.url}/api/dashboard?range=all`);
  const data = await api.json();
  assert.equal(data.summary.total.calls, 1);
  assert.equal(data.recent[0].estimated_cost, 0.00257);
});

test('HTTP 方法、范围、Host、Origin 和路径校验', async (t) => {
  const app = await start(t);
  const post = await fetch(`${app.url}/api/dashboard`, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal((await fetch(`${app.url}/missing`)).status, 404);
  assert.equal((await fetch(`${app.url}/api/dashboard?range=bad`)).status, 400);
  assert.equal(await rawStatus(app.url, '/%2e%2e/secret'), 400);
  assert.equal(await rawStatus(app.url, '/', { host: 'evil.example' }), 400);
  assert.equal(await rawStatus(app.url, '/', { origin: 'https://evil.example' }), 400);
});

test('CSV 和 JSON 下载保持公开字段', async (t) => {
  const app = await start(t);
  const csv = await fetch(`${app.url}/api/export.csv?range=all`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.doesNotMatch(await csv.text(), /private-session|private-host/);
  const json = await fetch(`${app.url}/api/export.json?range=all`);
  assert.equal(json.status, 200);
  assert.match(json.headers.get('content-disposition'), /attachment/);
  const payload = await json.json();
  assert.equal(payload.records[0].estimated_cost, 0.00257);
});

test('close 释放端口与数据库连接', async (t) => {
  const app = await start(t);
  await app.close();
  await assert.rejects(fetch(`${app.url}/api/dashboard`), /fetch failed/);
});

test('默认范围跟随 settings，非法 range 仍 400', async (t) => {
  const fixture = makeUsageFixture(t);
  const fs = require('node:fs');
  const path = require('node:path');
  const settingsPath = path.join(fixture.dir, 'insights.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ 'traeTokenCost.defaultRange': 'week' }));
  const app = await startStandaloneServer({ ...fixture, settingsPath, port: 0 });
  t.after(async () => app.close());
  const home = await fetch(app.url);
  assert.match(await home.text(), /"range":"week"/);
  const api = await fetch(`${app.url}/api/dashboard`);
  assert.equal((await api.json()).range, 'week');
  assert.equal((await fetch(`${app.url}/api/dashboard?range=bad`)).status, 400);
});

test('缺库启动失败且不打开监听端口', async (t) => {
  const fixture = makeUsageFixture(t);
  await assert.rejects(startStandaloneServer({ dbPath: `${fixture.dir}/missing.db`, settingsPath: fixture.settingsPath, port: 0 }), /数据库/);
});
