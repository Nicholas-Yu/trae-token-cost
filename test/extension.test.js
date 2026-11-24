'use strict';

/**
 * 集成测试：用 vscode stub 在纯 Node 下跑通扩展主流程
 * （激活 → leader 选举 → 采集事件入库 → 状态栏 → 仪表盘 Webview 渲染）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installVscodeStub } = require('./harness/vscode-stub');

function makeFakeAppRoot(projectRoot) {
  const appRoot = path.join(projectRoot, 'test/.tmp-app');
  fs.mkdirSync(appRoot, { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'product.json'), JSON.stringify({
    dataFolderName: '.trae-cn-test',
    appVersion: '3.4.15',
    nameShort: 'Trae CN'
  }));
  return appRoot;
}

async function waitFor(fn, timeoutMs = 3000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

test('扩展主流程：激活/采集/合并/状态栏/仪表盘', async (t) => {
  const projectRoot = path.resolve(__dirname, '..');
  const appRoot = makeFakeAppRoot(projectRoot);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-ext-test-'));
  const homeDir = path.join(workDir, 'home');
  fs.mkdirSync(homeDir, { recursive: true });

  // 重定向 os.homedir（argv 路径会落在临时 home 下）
  const realHomedir = os.homedir;
  os.homedir = () => homeDir;

  const stub = installVscodeStub({
    appRoot,
    workspaceName: 'demo-workspace',
    remoteName: 'ssh-remote',
    remoteAuthority: 'ssh-remote+gpu-host',
    workspaceFolders: [{ uri: { fsPath: '/home/remote/demo', scheme: 'vscode-remote', toString: () => 'vscode-remote://ssh-remote+gpu-host/home/remote/demo' } }],
    config: {
      'traeTokenCost.cdpPort': 59998,
      'traeTokenCost.statusBar.enabled': true,
      'traeTokenCost.statusBar.metric': 'both',
      'traeTokenCost.currency': 'CNY',
      'traeTokenCost.modelPrices': {
        'Seed-2.1-Pro': [
          { effectiveFrom: '2026-01-01', input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 }
        ]
      }
    },
    saveDialogResult: { fsPath: path.join(workDir, 'export.out') }
  });

  // 让扩展的 argv 检测指向临时 home（settings 里没配置 argv 路径，直接构造）
  fs.mkdirSync(path.join(homeDir, '.trae-cn-test'), { recursive: true });

  const context = {
    subscriptions: [],
    extensionPath: projectRoot,
    extensionUri: { fsPath: projectRoot },
    extension: { packageJSON: { version: '0.1.0-test' } },
    globalStorageUri: { fsPath: path.join(workDir, 'globalStorage') },
    globalState: {
      store: {},
      get(key) { return this.store[key]; },
      update(key, value) { this.store[key] = value; return Promise.resolve(); }
    }
  };

  const extensionModule = require('../src/extension');
  const ext = new extensionModule.TraeTokenExtension(context);
  t.after(() => {
    try { ext.dispose(); } catch { /* ignore */ }
    try { stub.uninstall(); } catch { /* ignore */ }
    os.homedir = realHomedir;
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(appRoot, { recursive: true, force: true });
  });

  await ext.start();

  // 单实例时应当选为 leader
  assert.equal(ext.election.role, 'leader');
  assert.equal(ext.store !== null, true);
  assert.ok(ext.config().modelPrices['kimi-k3.1-pro'], '首次安装应带内置百炼价格');
  assert.ok(ext.config().modelPrices['Seed-2.1-Pro'], '用户自定义模型价格应保留');

  // 两条同轮事件（debugger + 带实际积分的 billing）应合并成一条
  const now = Date.now();
  ext.handleUsage({
    inputTokens: 1000,
    outputTokens: 200,
    totalTokens: 1200,
    cacheReadTokens: 600,
    cacheWriteTokens: 100,
    reasoningTokens: 50,
    usageComplete: true,
    model: 'Seed-2.1-Pro',
    credits: null,
    source: 'debugger',
    observedAt: now,
    sessionId: 'session-1',
    messageId: 'message-1',
    targetTitle: 'demo-workspace [SSH: gpu-host] — Trae CN',
    targetId: 'target-1'
  });
  ext.handleUsage({
    inputTokens: 1000,
    outputTokens: 200,
    totalTokens: 1200,
    cacheReadTokens: 600,
    cacheWriteTokens: 100,
    reasoningTokens: 50,
    usageComplete: true,
    model: 'Seed-2.1-Pro',
    credits: 0.42,
    creditKind: 'actual',
    source: 'billing',
    observedAt: now + 1500,
    sessionId: 'session-1',
    messageId: 'message-1',
    targetTitle: 'demo-workspace [SSH: gpu-host] — Trae CN',
    targetId: 'target-1'
  });

  const summary = ext.store.summary({});
  assert.equal(summary.total.calls, 1, '同轮事件应合并为一条');
  assert.equal(summary.total.total_tokens, 1200);
  assert.equal(summary.total.actual_credits, 0.42);
  assert.equal(summary.total.reasoning_tokens, 50);

  // 状态栏同时展示 Token 与现金费用，不展示主机分类。
  assert.equal(ext.statusBar.visible, true);
  assert.doesNotMatch(ext.statusBar.text, /gpu-host/);
  assert.match(ext.statusBar.text, /1200 tok/);
  assert.match(ext.statusBar.text, /CNY 0\.00257/);
  const tooltip = ext.statusBar.tooltip && ext.statusBar.tooltip.value;
  assert.ok(typeof tooltip === 'string' && tooltip.includes('Trae Token 费用'), '状态栏 tooltip 应包含标题');

  // 仪表盘数据包含费用，但不向 Webview 暴露内部关联键或窗口信息。
  const data = ext.getDashboardData('today');
  assert.equal(data.summary.total.calls, 1);
  assert.ok(Math.abs(data.summary.total.estimated_cost - 0.00257) < 1e-12);
  assert.equal(data.summary.total.priced_calls, 1);
  assert.equal(data.summary.total.unpriced_calls, 0);
  assert.deepEqual(data.summary.hosts, []);
  assert.equal(data.capture.role, 'leader');
  assert.equal(data.recent.length, 1);
  assert.equal(data.recent[0].estimated_cost, 0.00257);
  assert.equal(data.recent[0].cost_status, 'ok');
  assert.equal(data.recent[0].reasoning_tokens, 50);
  for (const key of ['session_key', 'message_key', 'turn_key', 'billing_key', 'host_label', 'workspace_name', 'window_title', 'endpoint']) {
    assert.equal(Object.hasOwn(data.recent[0], key), false, `Webview 不应收到 ${key}`);
  }
  assert.equal(data.context, undefined);

  // 洞察增强：heatmap 固定 56 天、config 带默认范围。
  assert.equal(data.heatmap.days.length, 56);
  assert.equal(data.config.defaultRange, 'today');

  // JSON 与 CSV 导出均只包含公开字段和现金费用。
  await ext.exportRange('json', 'all');
  const exportedJson = JSON.parse(Buffer.from(stub.state.lastWrite.content).toString('utf8'));
  assert.equal(exportedJson.records[0].estimated_cost, 0.00257);
  assert.equal(Object.hasOwn(exportedJson.records[0], 'session_key'), false);
  assert.equal(Object.hasOwn(exportedJson.summary, 'hosts') && exportedJson.summary.hosts.length, 0);
  await ext.exportRange('csv', 'all');
  const exportedCsv = Buffer.from(stub.state.lastWrite.content).toString('utf8');
  assert.match(exportedCsv, /estimated_cost/);
  assert.doesNotMatch(exportedCsv, /session-1|gpu-host|demo-workspace/);

  // 仪表盘 Webview 能渲染（占位符替换、无 {{ }} 残留）
  const { DashboardPanel } = require('../src/ui/dashboard');
  const panel = DashboardPanel.show(ext, 'today');
  assert.ok(panel && panel.panel.webview.html.length > 1000);
  assert.equal(/\{\{[a-zA-Z]+\}\}/.test(panel.panel.webview.html), false, '模板占位符应全部替换');
  assert.match(panel.panel.webview.html, /Trae Token 费用/);
  assert.match(panel.panel.webview.html, /kpiCost/);
  assert.match(panel.panel.webview.html, /btnJson/);
  assert.match(panel.panel.webview.html, /const vscode = acquireVsCodeApi\(\);/);
  assert.doesNotMatch(panel.panel.webview.html, /主机 \/ 窗口分布|积分（实际/);
  const inlineScript = panel.panel.webview.html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(inlineScript, '应存在内联仪表盘脚本');
  assert.doesNotThrow(() => new Function(inlineScript[1]), '仪表盘脚本应通过语法检查');
  assert.match(panel.panel.webview.html, /reportTokenUsage|CDP|采集/, '仪表盘应包含采集相关说明');

  // Webview → 扩展消息：refresh 会触发 update
  panel.panel._sendToExtension({ type: 'refresh', range: 'all' });
  await new Promise((r) => setTimeout(r, 100));
  const update = panel.panel.postedMessages.find((m) => m && m.type === 'update');
  assert.ok(update, 'refresh 后应回发 update');
  assert.equal(update.payload.range, 'all');

  // 配置变更不应抛错（onConfigChanged 必须存在），且应刷新已打开的仪表盘。
  ext.openDashboard('today');
  const updatesBefore = panel.panel.postedMessages.filter((m) => m && m.type === 'update').length;
  assert.doesNotThrow(() => stub.fireConfigChange('traeTokenCost'), '配置变更不应抛 TypeError');
  await new Promise((r) => setTimeout(r, 100));
  const updatesAfter = panel.panel.postedMessages.filter((m) => m && m.type === 'update').length;
  assert.ok(updatesAfter > updatesBefore, '配置变更应刷新已打开的仪表盘');

  // 命令注册齐全
  for (const id of ['traeTokenCost.openDashboard', 'traeTokenCost.enableCapture', 'traeTokenCost.exportCsv', 'traeTokenCost.showDiagnostics']) {
    assert.ok(stub.state.registeredCommands.has(id), `缺少命令 ${id}`);
  }

  // 关闭后再次打开不崩溃
  panel.dispose();
  const panel2 = DashboardPanel.show(ext, 'today');
  assert.ok(panel2.panel.webview.html.length > 1000);
  panel2.dispose();
});
