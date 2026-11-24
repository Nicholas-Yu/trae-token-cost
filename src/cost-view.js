'use strict';

const { estimateUsageCost, resolveModelPrice } = require('./pricing');
const { csvEscape } = require('./data/store');

const PUBLIC_COLUMNS = [
  'observed_at',
  'model',
  'source',
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'usage_complete',
  'first_response_ms',
  'duration_ms',
  'timing_source',
  'estimated_cost',
  'cost_status',
  'price_effective_from',
  'currency'
];

/** 将数据库蛇形字段转换为定价模块使用的字段。 */
function toPricingEvent(row) {
  return {
    observedAt: row.observed_at,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    usageComplete: row.usage_complete === undefined ? undefined : Boolean(row.usage_complete)
  };
}

/** 只暴露面板和导出需要的字段，避免内部关联键离开扩展进程。 */
function toPublicUsageRecord(row, prices, currency = 'CNY') {
  const result = estimateUsageCost(toPricingEvent(row), prices);
  return {
    observed_at: row.observed_at,
    model: row.model,
    source: row.source,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    total_tokens: row.total_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cache_write_tokens: row.cache_write_tokens,
    reasoning_tokens: row.reasoning_tokens,
    usage_complete: result.status === 'incomplete' ? 0 : 1,
    first_response_ms: row.first_response_ms ?? null,
    duration_ms: row.duration_ms ?? null,
    timing_source: row.timing_source ?? null,
    estimated_cost: result.cost,
    cost_status: result.status,
    price_effective_from: result.effectiveFrom,
    currency
  };
}

function createCostAccumulator() {
  return { sum: 0, pricedCalls: 0, unpricedCalls: 0 };
}

function addCost(accumulator, record) {
  if (record.cost_status === 'ok') {
    accumulator.sum += record.estimated_cost;
    accumulator.pricedCalls += 1;
  } else {
    accumulator.unpricedCalls += 1;
  }
}

function finalizeCost(accumulator, calls) {
  const hasRecords = calls > 0 || accumulator.pricedCalls + accumulator.unpricedCalls > 0;
  return {
    estimated_cost: accumulator.pricedCalls > 0 || !hasRecords ? accumulator.sum : null,
    priced_calls: accumulator.pricedCalls,
    unpriced_calls: accumulator.unpricedCalls,
    cost_complete: accumulator.unpricedCalls === 0
  };
}

function localDay(observedAt) {
  const date = new Date(observedAt);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function timingMetrics(total) {
  const calls = Number(total.calls) || 0;
  const timedCalls = Number(total.timed_calls) || 0;
  const firstResponseCalls = Number(total.first_response_timed_calls) || 0;
  const durationSum = Number(total.duration_ms_sum) || 0;
  const firstResponseSum = Number(total.first_response_ms_sum) || 0;
  return {
    timing_coverage: calls > 0 ? timedCalls / calls : null,
    avg_duration_ms: timedCalls > 0 ? durationSum / timedCalls : null,
    avg_first_response_ms: firstResponseCalls > 0 ? firstResponseSum / firstResponseCalls : null,
    output_tps: durationSum > 0 ? (Number(total.timed_output_tokens) || 0) / (durationSum / 1000) : null
  };
}

/** 逐条计价后聚合，避免跨价格版本时直接用汇总 Token 错算费用。 */
function decorateSummaryWithCosts(summary, rows, prices, currency = 'CNY') {
  const total = createCostAccumulator();
  const models = new Map();
  const days = new Map();
  let rowCount = 0;

  for (const row of rows) {
    const record = toPublicUsageRecord(row, prices, currency);
    addCost(total, record);
    if (!models.has(record.model)) models.set(record.model, createCostAccumulator());
    addCost(models.get(record.model), record);
    const day = localDay(record.observed_at);
    if (!days.has(day)) days.set(day, createCostAccumulator());
    addCost(days.get(day), record);
    rowCount += 1;
  }

  const calls = Number(summary.total && summary.total.calls) || rowCount;
  return {
    ...summary,
    total: { ...summary.total, ...finalizeCost(total, calls), ...timingMetrics(summary.total) },
    models: (summary.models || []).map((item) => ({
      ...item,
      ...finalizeCost(models.get(item.model) || createCostAccumulator(), Number(item.calls) || 0),
      price_hint: buildPriceHint(item.model, prices)
    })),
    days: (summary.days || []).map((item) => ({
      ...item,
      ...finalizeCost(days.get(item.day) || createCostAccumulator(), Number(item.calls) || 0)
    })),
    hosts: [],
    recent: []
  };
}

/** 模型当前生效版本的基础档单价参考（阶梯/峰谷按调用计价，此处仅悬停提示）。 */
function buildPriceHint(model, prices) {
  const version = resolveModelPrice(model, prices, Date.now());
  if (!version) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const tier = Array.isArray(version.inputTiers) && version.inputTiers.length > 0 ? version.inputTiers[0] : null;
  const pick = (key) => {
    const top = num(version[key]);
    if (top !== null) return top;
    const fromTier = tier ? num(tier[key]) : null;
    if (fromTier !== null) return fromTier;
    const off = version.offPeak ? num(version.offPeak[key]) : null;
    if (off !== null) return off;
    return version.peak ? num(version.peak[key]) : null;
  };
  const cacheRead = version.cacheRead === 'unknown' ? 'unknown' : num(version.cacheRead);
  return {
    input: pick('input'),
    output: pick('output'),
    cache_read: cacheRead,
    cache_write: pick('cacheWrite'),
    effective_from: version.effectiveFrom ?? null,
    tiered: Boolean(tier),
    time_variant: Boolean(version.peak && version.offPeak)
  };
}

/** 公开记录导出为 UTF-8 BOM、CRLF 的 RFC 4180 CSV。 */
function recordsToCsv(records) {
  const lines = [PUBLIC_COLUMNS.join(',')];
  let count = 0;
  for (const record of records) {
    const output = { ...record };
    output.observed_at = Number.isFinite(output.observed_at)
      ? new Date(output.observed_at).toISOString()
      : '';
    lines.push(PUBLIC_COLUMNS.map((column) => csvEscape(output[column])).join(','));
    count += 1;
  }
  return `\uFEFF${lines.join('\r\n')}${count > 0 ? '\r\n' : ''}`;
}

function formatCost(value, currency = 'CNY') {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const amount = Number(value);
  return `${currency} ${Math.abs(amount) >= 1 ? amount.toFixed(2) : amount.toFixed(6)}`;
}

module.exports = {
  PUBLIC_COLUMNS,
  toPublicUsageRecord,
  decorateSummaryWithCosts,
  recordsToCsv,
  formatCost
};
