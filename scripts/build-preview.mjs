#!/usr/bin/env node
/**
 * 用 mock 数据把 src/ui/dashboard.html 渲染成独立可打开的预览页（不需要 VS Code）。
 * 用法：node scripts/build-preview.mjs [--out preview/dashboard-preview.html]
 * 用途：本地快速检查仪表盘布局/样式，以及截图入文档。
 * 预览适配器模拟宿主回推：refresh 时按 range 派发对应 payload（month/all），
 * 使热力图跨范围联动（pendingDay）可在纯浏览器中验证。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out') >= 0 ? args[args.indexOf('--out') + 1] : 'preview/dashboard-preview.html';
const outPath = path.resolve(root, outArg);

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function mockData(range = 'month') {
  const now = new Date();
  const dayMs = 86400000;
  const models = [
    ['Seed-2.1-Pro', 1840000, 420000, 860000, 34.2, 0.0],
    ['DeepSeek-V4-Pro', 980000, 260000, 410000, 18.6, 0.0],
    ['GLM-5.2', 640000, 180000, 260000, 8.4, 2.1],
    ['Kimi-K2.7-Code', 320000, 90000, 120000, 6.9, 0.0],
    ['Qwen3.7-Plus', 150000, 40000, 60000, 1.8, 0.4]
  ];
  const hosts = [
    ['gpu-host', 2600000, 760000, 1280000, 48.9, 0.0],
    ['gpu-host-2', 720000, 240000, 300000, 12.4, 1.6],
    ['本机', 420000, 110000, 160000, 8.6, 0.5]
  ];
  const daysCount = range === 'all' ? 56 : 30;
  const days = [];
  const dayModels = [];
  const weights = [5, 3, 2, 1.5, 1];
  for (let i = daysCount - 1; i >= 0; i--) {
    const dayIndex = daysCount - 1 - i;
    const d = new Date(now.getTime() - i * dayMs);
    const key = dayKey(d);
    const k = 7 + ((dayIndex * 7) % 21);
    const total = k * 52000 + (i % 3) * 9000;
    days.push({
      day: key,
      calls: k,
      total_tokens: total,
      input_tokens: Math.round(total * 0.72),
      output_tokens: Math.round(total * 0.28),
      estimated_cost: Number((total * 0.000002).toFixed(6)),
      priced_calls: k,
      unpriced_calls: 0,
      cost_complete: true,
      actual_credits: k * 0.58,
      estimated_credits: k * 0.06
    });
    const dayWeights = weights.map((weight, modelIndex) => weight * (1 + ((dayIndex + modelIndex) % 4) * 0.15));
    const weightTotal = dayWeights.reduce((sumValue, weight) => sumValue + weight, 0);
    let allocatedTokens = 0;
    let allocatedCalls = 0;
    models.forEach(([model], modelIndex) => {
      const last = modelIndex === models.length - 1;
      const modelTokens = last ? total - allocatedTokens : Math.round(total * dayWeights[modelIndex] / weightTotal);
      const calls = last ? k - allocatedCalls : Math.max(1, Math.floor(k * dayWeights[modelIndex] / weightTotal));
      const input = Math.round(modelTokens * 0.72);
      const cacheRead = Math.round(input * (0.2 + modelIndex * 0.08));
      const cacheWrite = modelIndex % 3 === 0 ? Math.round(input * 0.08) : 0;
      const timedCalls = Math.max(1, calls - (dayIndex + modelIndex) % 3);
      allocatedTokens += modelTokens;
      allocatedCalls += calls;
      dayModels.push({
        day: key,
        model,
        calls,
        total_tokens: modelTokens,
        input_tokens: input,
        output_tokens: modelTokens - input,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        reasoning_tokens: Math.round((modelTokens - input) * 0.25),
        timed_calls: timedCalls,
        first_response_timed_calls: timedCalls,
        duration_ms_sum: timedCalls * (1800 + modelIndex * 450 + dayIndex * 20),
        first_response_ms_sum: timedCalls * (180 + modelIndex * 35),
        timed_output_tokens: modelTokens - input
      });
    });
  }
  // 热力图固定 56 天，含零值日与强度层次。
  const heatmap = { days: [] };
  for (let i = 55; i >= 0; i--) {
    const d = new Date(now.getTime() - i * dayMs);
    const zero = i % 9 === 0;
    const value = zero ? 0 : (55 - i + 1) * 40000 + (i % 5) * 150000;
    heatmap.days.push({ day: dayKey(d), total_tokens: value, calls: zero ? 0 : 3 + (i % 17) });
  }
  const recent = [];
  const sources = ['debugger', 'network', 'billing'];
  for (let i = 0; i < 26; i++) {
    const m = models[i % models.length][0];
    const inp = 12000 + ((i * 3457) % 40000);
    const out = 800 + ((i * 977) % 6000);
    recent.push({
      id: i + 1,
      observed_at: now.getTime() - i * 9 * 60000,
      model: m,
      input_tokens: inp,
      output_tokens: out,
      total_tokens: inp + out,
      cache_read_tokens: Math.round(inp * 0.62),
      cache_write_tokens: i % 3 === 0 ? 2400 : 0,
      reasoning_tokens: Math.round(out * 0.3),
      first_response_ms: i % 7 === 0 ? null : 160 + i * 9,
      duration_ms: i % 6 === 0 ? null : 1400 + i * 125,
      timing_source: i % 6 === 0 ? null : 'network-inferred',
      estimated_cost: 0.01 + i * 0.002,
      cost_status: 'ok',
      source: sources[i % sources.length]
    });
  }
  const sum = (xs, key) => xs.reduce((s, x) => s + (Number(x[key]) || 0), 0);
  const totalInput = sum(recent, 'input_tokens');
  const totalOutput = sum(recent, 'output_tokens');
  const totalCache = sum(recent, 'cache_read_tokens');
  const timedRecent = recent.filter((row) => Number(row.duration_ms) > 0);
  const firstTimedRecent = recent.filter((row) => Number(row.first_response_ms) > 0);
  const durationMsSum = sum(timedRecent, 'duration_ms');
  const timedOutput = sum(timedRecent, 'output_tokens');
  return {
    standalone: true,
    range,
    summary: {
      total: {
        calls: recent.length,
        total_tokens: totalInput + totalOutput,
        input_tokens: totalInput,
        output_tokens: totalOutput,
        cache_read_tokens: totalCache,
        cache_write_tokens: sum(recent, 'cache_write_tokens'),
        actual_credits: 12.64,
        estimated_credits: 2.38,
        estimated_cost: sum(recent, 'estimated_cost'),
        priced_calls: recent.length,
        unpriced_calls: 0,
        cache_hit_rate: totalInput ? Number((totalCache / totalInput).toFixed(4)) : null,
        timed_calls: timedRecent.length,
        first_response_timed_calls: firstTimedRecent.length,
        duration_ms_sum: durationMsSum,
        first_response_ms_sum: sum(firstTimedRecent, 'first_response_ms'),
        timed_output_tokens: timedOutput,
        timing_coverage: timedRecent.length / recent.length,
        avg_duration_ms: durationMsSum / timedRecent.length,
        avg_first_response_ms: sum(firstTimedRecent, 'first_response_ms') / firstTimedRecent.length,
        output_tps: timedOutput / (durationMsSum / 1000)
      },
      models: models.map(([model, total_tokens, input_tokens, cached_tokens, actual_credits, estimated_credits], idx) => ({
        model,
        calls: 7 + idx,
        total_tokens,
        input_tokens,
        output_tokens: total_tokens - input_tokens,
        cached_tokens,
        actual_credits,
        estimated_credits,
        estimated_cost: Number((total_tokens * 0.000002).toFixed(6)),
        priced_calls: 7 + idx,
        unpriced_calls: 0,
        cost_complete: true,
        price_hint: {
          input: 2 + idx,
          output: 8 + idx * 2,
          cache_read: idx === 3 ? 'unknown' : 0.2,
          cache_write: 2.5,
          effective_from: '2026-01-01',
          tiered: idx === 1,
          time_variant: idx === 2
        }
      })),
      hosts: hosts.map(([host_label, total_tokens, input_tokens, cached_tokens, actual_credits, estimated_credits]) => ({
        host_label, calls: 9, total_tokens, input_tokens,
        output_tokens: total_tokens - input_tokens, cached_tokens,
        actual_credits, estimated_credits
      })),
      days,
      dayModels,
      recent
    },
    recent,
    heatmap,
    capture: {
      connected: true,
      label: '已连接 · 2 个目标 · 3 个采集点',
      role: 'leader',
      targetCount: 2,
      collectorCount: 2,
      breakpoints: 3,
      lastCaptureAt: now.getTime() - 42000,
      argvPort: 9222,
      argvPath: '~/.trae-cn/argv.json',
      lastError: null
    },
    env: { appName: 'Trae CN', appVersion: '3.4.15', extensionVersion: '0.3.0' },
    config: {
      cdpPort: 9222, captureDebugger: true, captureNetwork: false, timingEnabled: true,
      currency: 'CNY', statusBarMetric: 'tokens', retentionDays: 180,
      defaultRange: 'month', modelPrices: {}
    },
    generatedAt: now.getTime()
  };
}

function build() {
  const template = fs.readFileSync(path.join(root, 'src/ui/dashboard.html'), 'utf8');
  const payloadMonth = mockData('month');
  const payloadAll = mockData('all');
  const safe = (p) => JSON.stringify(p).replace(/</g, '\\u003c');
  const nonce = 'preview-nonce-' + Math.random().toString(36).slice(2);
  // 预览适配器：refresh 时按 range 模拟宿主回推 update，与 STANDALONE_ADAPTER 同构。
  const adapter = `(() => {
    const payloads = { today: ${safe(payloadMonth)}, week: ${safe(payloadMonth)}, month: ${safe(payloadMonth)}, all: ${safe(payloadAll)} };
    return {
      postMessage: (m) => {
        if (m && m.type === 'refresh') {
          const payload = payloads[m.range] || payloads.month;
          window.dispatchEvent(new MessageEvent('message', { data: { type: 'update', payload } }));
        } else { console.log('[preview]', m); }
      },
      getState: () => undefined,
      setState: () => {}
    };
  })()`;
  const html = template
    // 预览时放宽 CSP：允许内联脚本/样式
    .replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, "<meta charset=\"UTF-8\" />")
    .replace(/\{\{cspSource\}\}/g, '')
    .replace(/\{\{nonce\}\}/g, nonce)
    .replace(/\{\{initialJson\}\}/g, safe(payloadMonth))
    .replace(/\{\{extensionVersion\}\}/g, '0.3.0')
    .replace(/\{\{transportAdapter\}\}/g, adapter);
  // 模板自身已用 IIFE 隔离顶层声明（防内置浏览器注入全局冲突），此处不再重复包裹。
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
  console.log(`wrote ${outPath} (${html.length} bytes)`);
}

build();
