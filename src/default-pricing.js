'use strict';

const { modelPrices: bundledModelPrices } = require('../data/bailian-model-prices.json');

/** 内置官方价作为默认值，用户同名配置始终优先。 */
function mergeModelPrices(configured) {
  const custom = configured && typeof configured === 'object' && !Array.isArray(configured) ? configured : {};
  return { ...bundledModelPrices, ...custom };
}

module.exports = { mergeModelPrices };
