const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('共享模板通过占位符注入传输适配器', () => {
  const html = fs.readFileSync(path.join(root, 'src/ui/dashboard.html'), 'utf8');
  assert.match(html, /const vscode = \{\{transportAdapter\}\};/);
  assert.match(html, /d\.standalone/);
  assert.match(html, /format: 'csv', range: state\.range/);
  assert.match(html, /format: 'json', range: state\.range/);
});

test('内联脚本包裹 IIFE，不与内置浏览器注入的全局声明冲突', () => {
  const html = fs.readFileSync(path.join(root, 'src/ui/dashboard.html'), 'utf8');
  const match = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(match, '应存在内联仪表盘脚本');
  const body = match[1].trim();
  // TRAE 内置预览浏览器会注入全局词法声明（如 const vscode），顶层再声明同名会 SyntaxError。
  assert.match(body, /^\(\(\) => \{/, '脚本应包裹在 IIFE 内，隔离所有顶层声明');
  assert.match(body, /\}\)\(\);$/, 'IIFE 应立即执行');
  const injected = body
    .replace(/\{\{transportAdapter\}\}/g, '{ postMessage() {} }')
    .replace(/\{\{initialJson\}\}/g, '{}');
  assert.doesNotThrow(
    () => new Function('const vscode = {};\n' + injected),
    '与注入的全局 vscode 声明共存时不应语法冲突'
  );
});

test('指标说明包含统计时间与数据保留条目，范围页签有 ⓘ 入口', () => {
  const html = fs.readFileSync(path.join(root, 'src/ui/dashboard.html'), 'utf8');
  assert.match(html, /id: 'time_range'/, 'METRICS 应包含统计时间条目');
  assert.match(html, /数据保留|保留 180|retentionDays/, '应说明数据保留期');
  assert.match(html, /滚动/, '应说明近 7 日\/近 30 日为滚动范围');
  assert.match(html, /data-metric="time_range"/, '范围页签旁应有 ⓘ 入口');
});

test('深浅主题切换：G1 深色 / G2 浅色、持久化与红色热力图', () => {
  const html = fs.readFileSync(path.join(root, 'src/ui/dashboard.html'), 'utf8');
  assert.match(html, /id="btnTheme"/, '工具栏应有主题切换按钮');
  assert.match(html, /:root\[data-tc-theme="dark"\]/, '应有 G1 深色主题块');
  assert.match(html, /:root\[data-tc-theme="light"\]/, '应有 G2 浅色主题块');
  assert.match(html, /dataset\.tcTheme/, '主题属性应使用专用名避开宿主覆盖');
  assert.match(html, /traeTokenCost\.theme/, '主题选择应持久化');
  assert.match(html, /prefers-color-scheme: dark/, '未手动选择时应跟随系统');
  // 热力图红色主调（深浅两套），不再用蓝色 accent
  assert.match(html, /--heat:/, '应定义热力图专用色');
  assert.match(html, /color-mix\(in srgb, var\(--heat\)/, '热力图应使用红色主调变量');
  // 3D 玻璃：边缘折射光环 + 指针反光 + 透视倾斜（减少动态时禁用）
  assert.match(html, /conic-gradient\(from 210deg/, '应有边缘折射光环');
  assert.match(html, /--gx/, '应有指针跟随反光');
  assert.match(html, /perspective\(900px\) rotateX/, '应有 3D 透视倾斜');
});

test('共享模板包含模型堆叠、数值标签、耗时与 Token 下钻', () => {
  const html = fs.readFileSync(path.join(root, 'src/ui/dashboard.html'), 'utf8');
  for (const id of ['kpiFirstResponse', 'kpiDuration', 'modelLegend', 'drilldown', 'drilldownTitle', 'clearDrilldown']) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少 ${id}`);
  }
  assert.match(html, /dayModels/);
  assert.match(html, /class=\\?"segment/);
  assert.match(html, /total-label/);
  assert.match(html, /未缓存输入/);
  assert.match(html, /缓存读取/);
  assert.match(html, /缓存写入/);
  assert.match(html, /首响应/);
  assert.match(html, /总耗时/);
  assert.match(html, /timing_coverage/);
  assert.match(html, /output_tps/);
  assert.match(html, /function modelColor/);
  assert.match(html, /function renderDrilldown/);
  assert.doesNotMatch(html, /labelEvery/, '每个有数据的日期都应显示柱顶数值');
  assert.match(html, /\.chart \{[^}]*overflow-x:\s*auto/, '长周期应在图表内部横向滚动');
  assert.match(
    html,
    /:root\[data-standalone="true"\] \.chart \.segment \{[^}]*border-radius:\s*0;[^}]*padding:\s*0;[^}]*transform:\s*none;/,
    '独立页按钮样式不得把堆叠柱段变成胶囊'
  );
});

test('共享模板包含热力图、成本切换与下钻缓存命中率', () => {
  const html = fs.readFileSync(path.join(root, 'src/ui/dashboard.html'), 'utf8');
  for (const id of ['heatmap', 'btnChartMode']) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少 ${id}`);
  }
  assert.match(html, /缓存命中率/);
  assert.match(html, /pendingDay/);
  assert.match(html, /function renderHeatmap/);
  assert.match(html, /price_hint/);
  // 会话概览已移除，不应残留相关 id / 渲染函数。
  assert.doesNotMatch(html, /id="sessionCards"|id="sessionSort"|id="sessionTrend"|function renderSessions/);
});

test('共享模板包含指标说明弹窗与 ⓘ 入口', () => {
  const html = fs.readFileSync(path.join(root, 'src/ui/dashboard.html'), 'utf8');
  for (const id of ['btnMetrics', 'metricsOverlay', 'metricsNav', 'metricsContent', 'metricsClose']) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少 ${id}`);
  }
  assert.match(html, /data-metric=/);
  assert.match(html, /const METRICS =/);
  assert.match(html, /function openMetrics/);
  assert.match(html, /function closeMetrics/);
  // 关键口径：缓存命中如何识别必须写明上报字段别名。
  assert.match(html, /cache_read_input_tokens/);
  assert.match(html, /命中/);
  assert.match(html, /Escape/);
});

test('独立看板提供启动命令并排除出 VSIX', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.dashboard, 'node src/standalone/cli.js');
  const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  assert.match(ignore, /^src\/standalone\/\*\*$/m);
  assert.match(ignore, /^start-dashboard\.command$/m);
  assert.match(ignore, /^scripts\/e2e-dashboard\.mjs$/m);
});

test('双击脚本前台启动并保留 CLI 文档', () => {
  const launcher = path.join(root, 'start-dashboard.command');
  assert.equal(fs.existsSync(launcher), true);
  const script = fs.readFileSync(launcher, 'utf8');
  assert.match(script, /exec /);
  assert.doesNotMatch(script, /nohup/);
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /npm run dashboard/);
  assert.match(readme, /start-dashboard\.command/);
});
