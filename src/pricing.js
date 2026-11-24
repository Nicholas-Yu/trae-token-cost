'use strict';

/**
 * 按每百万 Token 单价估算用量费用。
 * 支持生效版本、输入阶梯、峰谷时段、思考输出和显式缓存 TTL。
 */

const { normalizeModelName } = require('./capture/parser');

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

function isPrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function effectiveFromTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
}

function resolveModelPrice(model, prices, observedAt) {
  if (!prices || typeof prices !== 'object' || !Number.isFinite(observedAt)) return null;
  const observedTime = new Date(observedAt).getTime();
  if (!Number.isFinite(observedTime)) return null;

  const normalizedModel = normalizeModelName(model);
  let versions = null;
  for (const [name, value] of Object.entries(prices)) {
    if (normalizeModelName(name) === normalizedModel) {
      versions = value;
      break;
    }
  }
  if (!Array.isArray(versions)) return null;

  let selected = null;
  let selectedTime = -Infinity;
  for (const version of versions) {
    if (!version || typeof version !== 'object') continue;
    const effectiveTime = effectiveFromTimestamp(version.effectiveFrom);
    if (effectiveTime === null || effectiveTime > observedTime) continue;
    if (effectiveTime >= selectedTime) {
      selected = version;
      selectedTime = effectiveTime;
    }
  }
  return selected;
}

function parseTimeOfDay(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function resolveTimeVariant(version, observedAt) {
  if (!version.peak && !version.offPeak) return version;
  if (!version.peak || !version.offPeak) return null;
  const start = parseTimeOfDay(version.offPeakStart);
  const end = parseTimeOfDay(version.offPeakEnd);
  if (start === null || end === null || start === end) return null;
  const minutes = Math.floor((observedAt + 8 * 60 * 60 * 1000) / 60000) % 1440;
  const inOffPeak = start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
  // 时段价格覆盖当前费率，缓存等公共字段仍从模型版本继承。
  return { ...version, ...(inOffPeak ? version.offPeak : version.peak) };
}

function resolveTier(variant, inputTokens) {
  if (!Array.isArray(variant.inputTiers)) return variant;
  if (variant.inputTiers.length === 0) return null;
  let previousMax = 0;
  for (const tier of variant.inputTiers) {
    if (!tier || !Number.isInteger(tier.maxInputTokens) || tier.maxInputTokens <= previousMax) return null;
    previousMax = tier.maxInputTokens;
  }
  return variant.inputTiers.find((tier) => inputTokens <= tier.maxInputTokens) || null;
}

function resolveRate(variant, inputTokens) {
  const tier = resolveTier(variant, inputTokens);
  if (!tier) return null;
  const tiered = Array.isArray(variant.inputTiers);
  const input = tier.input;
  const output = tier.output;
  if (!isPrice(input) || !isPrice(output)) return null;

  const reasoningOutput = tier.reasoningOutput === undefined ? output : tier.reasoningOutput;
  if (!isPrice(reasoningOutput)) return null;

  const cacheRead = tier.cacheRead === undefined ? variant.cacheRead : tier.cacheRead;
  if (cacheRead !== 'unknown' && !isPrice(cacheRead)) return null;

  let cacheWrite;
  if (variant.cacheWriteByTtl !== undefined) {
    const mapping = variant.cacheWriteByTtl;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return null;
    const ttl = variant.cacheTtl || '5m';
    if (!Object.hasOwn(mapping, ttl) || !isPrice(mapping[ttl])) return null;
    cacheWrite = mapping[ttl];
  } else if (tier.cacheWrite !== undefined) {
    if (!isPrice(tier.cacheWrite)) return null;
    cacheWrite = tier.cacheWrite;
  } else if (variant.cacheWrite !== undefined) {
    if (!isPrice(variant.cacheWrite)) return null;
    cacheWrite = variant.cacheWrite;
  } else {
    // 旧平价配置仍要求显式创建价；阶梯配置默认按同档输入价。
    if (!tiered) return null;
    cacheWrite = input;
  }
  return { input, output, reasoningOutput, cacheRead, cacheWrite };
}

/**
 * 估算单条用量事件费用；推理 Token 已包含在输出中，不另行计费。
 * @returns {{cost: number|null, status: 'ok'|'missing-price'|'incomplete', effectiveFrom: string|null}}
 */
function estimateUsageCost(event, prices) {
  if (!event || typeof event !== 'object' || event.usageComplete === false) {
    return { cost: null, status: 'incomplete', effectiveFrom: null };
  }
  for (const field of TOKEN_FIELDS) {
    if (!Number.isFinite(event[field]) || event[field] < 0) {
      return { cost: null, status: 'incomplete', effectiveFrom: null };
    }
  }

  const regularInputTokens = event.inputTokens - event.cacheReadTokens - event.cacheWriteTokens;
  if (regularInputTokens < 0) {
    return { cost: null, status: 'incomplete', effectiveFrom: null };
  }

  const version = resolveModelPrice(event.model, prices, event.observedAt);
  if (!version) return { cost: null, status: 'missing-price', effectiveFrom: null };
  const variant = resolveTimeVariant(version, event.observedAt);
  if (!variant) return { cost: null, status: 'missing-price', effectiveFrom: null };
  const rate = resolveRate(variant, event.inputTokens);
  if (!rate) return { cost: null, status: 'missing-price', effectiveFrom: null };
  if (event.cacheReadTokens > 0 && rate.cacheRead === 'unknown') {
    return { cost: null, status: 'missing-price', effectiveFrom: null };
  }

  const cacheReadPrice = rate.cacheRead === 'unknown' ? 0 : rate.cacheRead;
  const outputPrice = event.reasoningTokens > 0 ? rate.reasoningOutput : rate.output;
  const cost = (
    regularInputTokens * rate.input
    + event.outputTokens * outputPrice
    + event.cacheReadTokens * cacheReadPrice
    + event.cacheWriteTokens * rate.cacheWrite
  ) / 1_000_000;
  return { cost, status: 'ok', effectiveFrom: version.effectiveFrom };
}

module.exports = {
  resolveModelPrice,
  estimateUsageCost
};
