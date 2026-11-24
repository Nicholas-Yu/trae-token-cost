'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { createDashboardService } = require('./service');
const { version: extensionVersion } = require('../../package.json');

const TEMPLATE_PATH = path.join(__dirname, '..', 'ui', 'dashboard.html');
const RANGES = new Set(['today', 'week', 'month', 'all']);

// 独立端只保留刷新和下载，不暴露采集启停或诊断操作。
const STANDALONE_ADAPTER = `(() => ({
  postMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'refresh') {
      const range = message.range || 'today';
      fetch('/api/dashboard?range=' + encodeURIComponent(range), { cache: 'no-store' })
        .then((response) => {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        })
        .then((payload) => window.dispatchEvent(new MessageEvent('message', {
          data: { type: 'update', payload }
        })))
        .catch((error) => console.error('刷新本地看板失败', error));
      return;
    }
    if (message.type === 'export') {
      const format = message.format === 'json' ? 'json' : 'csv';
      const range = message.range || (window.__standaloneRange || 'all');
      window.location.href = '/api/export.' + format + '?range=' + encodeURIComponent(range);
    }
  }
}))()`;

function send(res, status, body, headers = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': buffer.length,
    ...headers
  });
  res.end(buffer);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' });
}

function renderStandaloneHtml(payload) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const safeJson = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const csp = `default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'`;
  const html = fs.readFileSync(TEMPLATE_PATH, 'utf8')
    .replace(/\{\{cspSource\}\}/g, "'self'")
    .replace(/\{\{nonce\}\}/g, nonce)
    .replace(/\{\{initialJson\}\}/g, safeJson)
    .replace(/\{\{transportAdapter\}\}/g, STANDALONE_ADAPTER)
    .replace(/\{\{extensionVersion\}\}/g, extensionVersion);
  return { html, csp };
}

function requestRange(url, fallback) {
  const range = url.searchParams.get('range') || fallback;
  if (!RANGES.has(range)) {
    const error = new Error('无效的时间范围');
    error.status = 400;
    throw error;
  }
  return range;
}

function validateRequest(req) {
  if (req.method !== 'GET') {
    const error = new Error('仅支持 GET');
    error.status = 405;
    throw error;
  }
  const host = req.headers.host || '';
  let hostname = '';
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    hostname = '';
  }
  if (!['127.0.0.1', 'localhost'].includes(hostname)) {
    const error = new Error('非法 Host');
    error.status = 400;
    throw error;
  }
  if (req.headers.origin) {
    let originHost = '';
    try {
      originHost = new URL(req.headers.origin).hostname;
    } catch {
      originHost = '';
    }
    if (!['127.0.0.1', 'localhost'].includes(originHost)) {
      const error = new Error('非法 Origin');
      error.status = 400;
      throw error;
    }
  }
  if (/\.\.|%2e/i.test(req.url || '')) {
    const error = new Error('非法路径');
    error.status = 400;
    throw error;
  }
}

/** 启动独立只读服务，返回实际随机端口与统一关闭函数。 */
async function startStandaloneServer(options) {
  const service = createDashboardService(options);
  const server = http.createServer((req, res) => {
    try {
      validateRequest(req);
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/') {
        const payload = service.getDashboard(requestRange(url, service.defaultRange));
        const { html, csp } = renderStandaloneHtml(payload);
        send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp });
        return;
      }
      if (url.pathname === '/api/dashboard') {
        sendJson(res, 200, service.getDashboard(requestRange(url, service.defaultRange)));
        return;
      }
      if (url.pathname === '/api/export.csv') {
        const range = requestRange(url, 'all');
        send(res, 200, service.exportCsv(range), {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="trae-token-${range}.csv"`
        });
        return;
      }
      if (url.pathname === '/api/export.json') {
        const range = requestRange(url, 'all');
        send(res, 200, JSON.stringify(service.exportJson(range)), {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="trae-token-${range}.json"`
        });
        return;
      }
      sendJson(res, 404, { error: '资源不存在' });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 503;
      sendJson(res, status, { error: status === 503 ? '本地数据暂时不可读' : error.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port || 0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  return {
    server,
    service,
    url,
    async close() {
      if (closed) return;
      closed = true;
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      service.close();
    }
  };
}

module.exports = { startStandaloneServer, renderStandaloneHtml, STANDALONE_ADAPTER };
