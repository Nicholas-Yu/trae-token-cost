const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.resolve(__dirname, '../src/ui/dashboard.html'), 'utf8');

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const channels = hex.match(/[0-9a-f]{2}/gi).map((value) => parseInt(value, 16) / 255);
    const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('玻璃风格只作用于独立页面并保留浅色文字层级', () => {
  assert.match(html, /:root\[data-standalone="true"\][\s\S]*?color-scheme: light/);
  assert.match(html, /:root\[data-standalone="true"\] body/);
  assert.match(html, /:root\[data-standalone="true"\] \.card/);
  assert.match(html, /:root\[data-standalone="true"\] \.panel/);
  assert.match(html, /rgba\(255, 255, 255, 0\.\d+\)/);
  assert.doesNotMatch(html, /:root\[data-standalone="true"\][\s\S]*?color-scheme:\s*dark\s*;/);
});

test('玻璃效果包含双向模糊、实色降级和减少透明规则', () => {
  assert.match(html, /backdrop-filter: blur\(/);
  assert.match(html, /-webkit-backdrop-filter: blur\(/);
  assert.match(html, /@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/);
  assert.match(html, /@media \(prefers-reduced-transparency: reduce\)/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
});

test('背景使用加深深蓝灰并协调按钮与图表颜色', () => {
  assert.match(html, /#d8e5ef/);
  assert.match(html, /#eef3f7/);
  assert.match(html, /#2f6fe0/);
  assert.match(html, /#269b87/);
  assert.match(html, /--vscode-button-background: #2f6fe0/);
  assert.doesNotMatch(html, /#eef4fb|#f7f9fc/);
});

test('辅助文字在最深背景上保持至少 4.5 倍对比度', () => {
  assert.match(html, /--vscode-descriptionForeground: #566474/);
  assert.doesNotMatch(html, /#687586|#5c6877|#5b6775/);
  assert.ok(contrastRatio('#566474', '#d8e5ef') >= 4.5);
});

test('独立玻璃页面保持响应式和无外部资源', () => {
  assert.match(html, /@media \(max-width: 900px\)/);
  assert.match(html, /:root\[data-standalone="true"\][\s\S]*?overflow-x: hidden/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('指标说明弹窗的独立端覆盖与降级', () => {
  assert.match(html, /:root\[data-standalone="true"\] \.modal \{/);
  assert.match(html, /:root\[data-standalone="true"\] \.info-btn/);
  const supportsBlock = html.match(/@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\) \{[\s\S]*?\n    \}/);
  assert.ok(supportsBlock, '缺少 @supports 降级块');
  assert.match(supportsBlock[0], /\.modal/);
  const reducedBlock = html.match(/@media \(prefers-reduced-transparency: reduce\) \{[\s\S]*?\n    \}/);
  assert.ok(reducedBlock, '缺少减少透明降级块');
  assert.match(reducedBlock[0], /\.modal/);
});

test('热力图的独立端覆盖与降级', () => {
  assert.match(html, /:root\[data-standalone="true"\] \.heat-cell/);
  // 会话概览已移除，不应残留相关样式。
  assert.doesNotMatch(html, /\.session-card|select#sessionSort/);
  // 新增辅助文字沿用达标色，不得引入禁色。
  assert.doesNotMatch(html, /#eef4fb|#f7f9fc|#687586|#5c6877|#5b6775/);
});
