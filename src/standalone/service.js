'use strict';

const { UsageStore } = require('../data/store');
const { loadPriceConfig } = require('./config');
const { rangeToSinceMs, startOfDaysAgo } = require('../util');
const {
  toPublicUsageRecord,
  decorateSummaryWithCosts,
  recordsToCsv
} = require('../cost-view');
const { version: extensionVersion } = require('../../package.json');

const RANGES = new Set(['today', 'week', 'month', 'all']);

function assertRange(range) {
  if (!RANGES.has(range)) throw new Error(`无效的时间范围：${range}`);
}

/** 将独立进程中的只读查询组装为与 IDE 相同的数据结构。 */
function createDashboardService({ dbPath, settingsPath }) {
  let store;
  try {
    store = new UsageStore(dbPath, { readOnly: true });
  } catch (error) {
    throw new Error(`无法打开本地用量数据库：${dbPath}（${error.message}）`, { cause: error });
  }
  const { modelPrices, currency, defaultRange, warnings } = loadPriceConfig(settingsPath);

  function summarize(range) {
    assertRange(range);
    const sinceMs = rangeToSinceMs(range);
    return decorateSummaryWithCosts(store.summary({ sinceMs }), store.iterate({ sinceMs }), modelPrices, currency);
  }

  function publicRecords(range) {
    assertRange(range);
    const sinceMs = rangeToSinceMs(range);
    return Array.from(store.iterate({ sinceMs }), (row) => toPublicUsageRecord(row, modelPrices, currency));
  }

  return {
    defaultRange,
    getDashboard(range = defaultRange) {
      assertRange(range);
      const sinceMs = rangeToSinceMs(range);
      const summary = summarize(range);
      let heatmap = { days: [] };
      try { heatmap = store.activityDays({ sinceMs: startOfDaysAgo(55) }); } catch { /* ignore */ }
      const recent = store.recent({ limit: 200, sinceMs })
        .map((row) => toPublicUsageRecord(row, modelPrices, currency));
      return {
        range,
        summary: { ...summary, recent },
        recent,
        heatmap,
        capture: { connected: true, label: '本地只读 · 历史数据' },
        env: { appName: 'TRAE 本地数据', appVersion: '', extensionVersion },
        config: { currency, modelPrices, defaultRange },
        warnings: [...warnings],
        standalone: true,
        generatedAt: Date.now()
      };
    },

    exportCsv(range = 'all') {
      return recordsToCsv(publicRecords(range));
    },

    exportJson(range = 'all') {
      return {
        exportedAt: new Date().toISOString(),
        range,
        currency,
        records: publicRecords(range),
        summary: summarize(range)
      };
    },

    close() {
      store.close();
    }
  };
}

module.exports = { createDashboardService };
