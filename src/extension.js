'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { UsageStore } = require('./data/store');
const { LeaderElection } = require('./data/leader');
const { TraeCollector } = require('./capture/collector');
const { deriveHostLabel } = require('./host');
const {
  toPublicUsageRecord,
  decorateSummaryWithCosts,
  recordsToCsv,
  formatCost
} = require('./cost-view');
const { enableCdp, disableCdp, readArgvFile } = require('./setup/argv');
const relaunch = require('./setup/relaunch');
const { DashboardPanel } = require('./ui/dashboard');
const { mergeModelPrices } = require('./default-pricing');

const {
  pad,
  startOfToday,
  startOfWeek,
  startOfMonth,
  startOfDaysAgo,
  rangeToSinceMs,
  normalizeRange,
  formatTokens,
  formatDateTime,
  parseRemoteAuthority,
  RANGE_ITEMS
} = require('./util');

const OUTPUT_NAME = 'Trae Token 费用';

function readProductInfo(appRoot) {
  try {
    const raw = fs.readFileSync(path.join(appRoot, 'product.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

class TraeTokenExtension {
  constructor(context) {
    this.context = context;
    this.disposed = false;
    this.output = vscode.window.createOutputChannel(OUTPUT_NAME);
    this.globalDir = context.globalStorageUri.fsPath;
    this.sharedDir = path.join(this.globalDir, 'shared');
    this.logDir = path.join(this.globalDir, 'logs');
    this.dbPath = path.join(this.globalDir, 'usage.db');
    this.logPath = path.join(this.logDir, 'extension.log');
    this.store = null;
    this.election = null;
    this.collector = null;
    this.collectorStatus = null;
    this.statusBar = null;
    this.dashboard = null;
    this.refreshTimer = null;
    this.pruneTimer = null;
    this.lastUsageAt = 0;
    this.argvCache = null;
    this.argvCacheAt = 0;
    this.firstRunPrompted = false;
    this.lastLogMessage = null;
    this.lastLogAt = 0;
  }

  // ---------------------------------------------------------------- lifecycle
  async start() {
    fs.mkdirSync(this.globalDir, { recursive: true });
    fs.mkdirSync(this.sharedDir, { recursive: true });
    fs.mkdirSync(this.logDir, { recursive: true });
    this.log(`activate: globalDir=${this.globalDir}`);
    this.log(`vscode=${vscode.version} appRoot=${vscode.env.appRoot} appName=${vscode.env.appName} remoteName=${vscode.env.remoteName || 'none'}`);

    this.store = new UsageStore(this.dbPath);
    this.election = new LeaderElection({ dir: this.sharedDir, logger: (m) => this.log(m) });
    this.election.on('role', (role) => this.onRole(role));
    this.election.on('status', () => this.refreshStatusBar());
    this.election.on('error', (err) => this.log(`election error: ${err && err.message}`));
    await this.election.start();

    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.statusBar.command = 'traeTokenCost.openDashboard';
    this.statusBar.name = OUTPUT_NAME;
    this.statusBar.show();
    this.context.subscriptions.push(this.statusBar, this.output);

    this.registerCommands();
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('traeTokenCost')) this.onConfigChanged();
      })
    );

    this.refreshTimer = setInterval(() => this.refreshStatusBar(), 3000);
    this.pruneTimer = setInterval(() => {
      if (this.election.role === 'leader') this.prune();
    }, 6 * 60 * 60 * 1000);

    this.onRole(this.election.role);
    this.refreshStatusBar();
    this.maybeFirstRunPrompt();
    this.log('activated');
  }

  maybeFirstRunPrompt() {
    try {
      if (this.context.globalState.get('traeTokenCost.firstRunShown')) return;
      const argv = this.getArgvState(true);
      const cdpUp = Boolean(this.collectorStatus && this.collectorStatus.connected);
      if (argv.configured || cdpUp) {
        return;
      }
      this.context.globalState.update('traeTokenCost.firstRunShown', true);
      vscode.window.showInformationMessage(
        'Trae Token 费用：第一次使用需要开启一次采集（会备份并修改 Trae 启动参数，重启后生效）。',
        '开启采集', '稍后手动重启'
      ).then((action) => {
        if (action === '开启采集') this.enableCapture({ restart: false });
      });
    } catch (err) {
      this.log(`first run prompt failed: ${err && err.message}`);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.refreshTimer);
    clearInterval(this.pruneTimer);
    try { this.collector?.stop(); } catch { /* ignore */ }
    try { this.dashboard?.dispose(); } catch { /* ignore */ }
    try { this.election?.stop(); } catch { /* ignore */ }
    try { this.store?.close(); } catch { /* ignore */ }
    try { this.output.dispose(); } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- config/env
  config() {
    const c = vscode.workspace.getConfiguration('traeTokenCost');
    return {
      cdpPort: c.get('cdpPort', 9333),
      captureDebugger: c.get('captureDebugger', true),
      captureNetwork: c.get('captureNetwork', false),
      timingEnabled: c.get('timingEnabled', true),
      pollIntervalMs: c.get('pollIntervalMs', 3000),
      statusBarEnabled: c.get('statusBar.enabled', true),
      statusBarMetric: c.get('statusBar.metric', 'tokens'),
      retentionDays: c.get('retentionDays', 180),
      currency: c.get('currency', 'CNY'),
      modelPrices: mergeModelPrices(c.get('modelPrices', {})),
      defaultRange: normalizeRange(c.get('defaultRange', 'today'))
    };
  }

  onConfigChanged() {
    // 设置变更只刷新展示层；cdpPort 等采集参数仍需重启 Trae 生效（既有语义）。
    this.refreshStatusBar();
    this.dashboard?.sendUpdate();
  }

  resolveEnv() {
    const appRoot = vscode.env.appRoot || '';
    const product = readProductInfo(appRoot);
    const dataFolder = product.dataFolderName || '.trae-cn';
    const bundlePath = appRoot.replace(/\/Contents\/Resources\/app$/, '');
    return {
      appRoot,
      product,
      dataFolder,
      bundlePath,
      argvPath: path.join(os.homedir(), dataFolder, 'argv.json'),
      appVersion: product.appVersion || vscode.version,
      appName: vscode.env.appName || product.nameShort || 'Trae'
    };
  }

  currentContext() {
    const remoteAuthority = vscode.env.remoteAuthority || null;
    const remoteName = vscode.env.remoteName || null;
    const remoteHost = parseRemoteAuthority(remoteAuthority);
    const folder = (vscode.workspace.workspaceFolders || [])[0];
    const rawName = vscode.workspace.name || (folder ? path.basename(folder.uri.fsPath) : '') || '';
    // Trae 远程窗口标题会带 "[SSH: gpu-host]" 后缀，展示时去掉
    const workspaceName = String(rawName).replace(/\s*\[[^\]]*\]\s*$/, '').trim();
    const hostLabel = remoteName ? (remoteHost || remoteName) : '本机';
    return { remoteName, remoteAuthority, remoteHost, workspaceName, hostLabel };
  }

  // ---------------------------------------------------------------- role
  onRole(role) {
    this.log(`role: ${role}`);
    if (role === 'leader') {
      this.startCollector();
      this.prune();
      try {
        const backfilled = this.store.backfillModels();
        if (backfilled > 0) this.log(`backfillModels: ${backfilled} 条历史记录按会话补全模型名`);
      } catch (err) {
        this.log(`backfillModels error: ${err && err.message}`);
      }
    } else {
      this.stopCollector();
    }
    this.refreshStatusBar();
    this.dashboard?.sendUpdate();
  }

  startCollector() {
    this.stopCollector();
    const cfg = this.config();
    this.collector = new TraeCollector({
      host: '127.0.0.1',
      port: cfg.cdpPort,
      debuggerEnabled: cfg.captureDebugger,
      networkEnabled: cfg.captureNetwork,
      timingEnabled: cfg.timingEnabled,
      pollIntervalMs: cfg.pollIntervalMs,
      logger: (level, message) => this.log(`[collector:${level}] ${message}`)
    });
    this.collector.on('usage', (event) => this.handleUsage(event));
    this.collector.on('status', (status) => {
      this.collectorStatus = status;
      this.election.updateStatus({
        cdpConnected: Boolean(status.connected),
        targetCount: status.targetCount || 0,
        collectorCount: status.collectorCount || 0,
        breakpointCount: status.breakpointCount || 0,
        lastCaptureAt: this.lastUsageAt || status.lastCaptureAt || null,
        lastError: status.lastError || null,
        appVersion: this.resolveEnv().appVersion,
        platform: process.platform
      });
      this.refreshStatusBar();
    });
    this.collector.on('diagnostic', (evt) => {
      if (evt && evt.type === 'breakpoint') this.log(`[collector] breakpoint @ ${evt.url}:${(evt.lineNumber || 0) + 1}`);
      else if (evt && evt.type !== 'handler-error' && evt.error) this.log(`[collector] ${evt.type}: ${evt.error}`);
    });
    this.collector.start();
    this.log(`collector started on 127.0.0.1:${cfg.cdpPort}`);
  }

  stopCollector() {
    try { this.collector?.stop(); } catch (err) { this.log(`collector stop error: ${err && err.message}`); }
    this.collector = null;
    this.collectorStatus = null;
  }

  // ---------------------------------------------------------------- capture
  handleUsage(raw) {
    if (!raw || this.disposed) return;
    if (!(raw.inputTokens > 0 || raw.outputTokens > 0 || raw.totalTokens > 0)) return;
    const observedAt = Number(raw.observedAt) || Date.now();
    const hostLabel = deriveHostLabel(raw.targetTitle || '');
    try {
      this.store.record({ ...raw, observedAt }, { hostLabel });
      this.lastUsageAt = Date.now();
      this.election.updateStatus({ lastCaptureAt: this.lastUsageAt });
      this.refreshStatusBar();
      this.dashboard?.sendUpdate();
      this.log(`usage: model=${raw.model} in=${raw.inputTokens} out=${raw.outputTokens} cache=${raw.cacheReadTokens || 0} complete=${raw.usageComplete !== false} src=${raw.source}`);
    } catch (err) {
      this.log(`store.record error: ${err && err.stack ? err.stack : err}`);
    }
  }

  prune() {
    try {
      const removed = this.store.prune({ retentionDays: this.config().retentionDays });
      if (removed > 0) this.log(`prune: removed ${removed} records`);
    } catch (err) { this.log(`prune error: ${err && err.message}`); }
  }

  // ---------------------------------------------------------------- argv state
  getArgvState(force = false) {
    if (!force && this.argvCache && Date.now() - this.argvCacheAt < 5000) return this.argvCache;
    const env = this.resolveEnv();
    let config = null;
    let existed = false;
    let error = null;
    try {
      const res = readArgvFile(env.argvPath);
      config = res.config;
      existed = res.existed;
    } catch (err) { error = err && err.message; }
    const port = config && Number(config['remote-debugging-port']) || null;
    this.argvCache = { argvPath: env.argvPath, existed, port, configured: Boolean(port), error };
    this.argvCacheAt = Date.now();
    return this.argvCache;
  }

  /** 汇总原始 Token，并逐条按请求时间匹配价格。 */
  getSummary(sinceMs = null) {
    const cfg = this.config();
    const summary = this.store.summary({ sinceMs });
    return decorateSummaryWithCosts(summary, this.store.iterate({ sinceMs }), cfg.modelPrices, cfg.currency);
  }

  /** 生成不含内部关联键的公开记录，供面板和安全导出使用。 */
  *publicRecords(sinceMs = null) {
    const cfg = this.config();
    for (const row of this.store.iterate({ sinceMs })) {
      yield toPublicUsageRecord(row, cfg.modelPrices, cfg.currency);
    }
  }

  // ---------------------------------------------------------------- status bar
  refreshStatusBar() {
    if (!this.statusBar || this.disposed) return;
    const cfg = this.config();
    if (!cfg.statusBarEnabled) { this.statusBar.hide(); return; }
    this.statusBar.show();
    let summary = { total: {} };
    try { summary = this.getSummary(startOfToday()); } catch { /* ignore */ }
    const t = summary.total || {};
    const costText = formatCost(t.estimated_cost, cfg.currency) + (t.unpriced_calls > 0 ? '（部分）' : '');
    const metric = cfg.statusBarMetric;
    let metricText;
    if (metric === 'cost') metricText = costText;
    else if (metric === 'both') metricText = `${formatTokens(t.total_tokens)} tok · ${costText}`;
    else metricText = `${formatTokens(t.total_tokens)} tok`;

    const capture = this.captureState();
    const icon = capture.connected ? '$(pulse)' : '$(debug-disconnect)';
    this.statusBar.text = `${icon} ${metricText}`;
    this.statusBar.color = undefined;
    this.statusBar.backgroundColor = undefined;

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.appendMarkdown(`**Trae Token 费用 · 今日**\n\n`);
    md.appendMarkdown(`- 轮次：${Number(t.calls) || 0}\n`);
    md.appendMarkdown(`- Token：输入 ${formatTokens(t.input_tokens)} / 输出 ${formatTokens(t.output_tokens)} / 合计 **${formatTokens(t.total_tokens)}**\n`);
    md.appendMarkdown(`- 缓存命中：${formatTokens(t.cache_read_tokens)}${t.cache_hit_rate ? `（${(t.cache_hit_rate * 100).toFixed(1)}%）` : ''}\n`);
    md.appendMarkdown(`- 估算费用：${costText}\n`);
    if (t.unpriced_calls > 0) md.appendMarkdown(`- 未定价/不完整：${t.unpriced_calls} 次调用\n`);
    md.appendMarkdown(`- 采集：${capture.label}\n`);
    md.appendMarkdown(`\n[打开仪表盘](command:traeTokenCost.openDashboard)`);
    this.statusBar.tooltip = md;
  }

  captureState() {
    const argv = this.getArgvState();
    const status = this.collectorStatus || this.election?.getStatus() || null;
    const role = this.election?.role;
    if (role !== 'leader') {
      const leaderStatus = status || {};
      const connected = Boolean(leaderStatus.cdpConnected);
      return {
        connected,
        label: connected ? '由其他窗口采集中' : '未连接（其他窗口未启用）',
        role,
        targetCount: leaderStatus.targetCount || 0,
        breakpoints: leaderStatus.breakpointCount || 0,
        lastCaptureAt: leaderStatus.lastCaptureAt || this.lastUsageAt || null,
        lastError: leaderStatus.lastError || null,
        argvConfigured: argv.configured,
        argvPort: argv.port,
        argvPath: argv.argvPath,
        error: leaderStatus.lastError || null
      };
    }
    if (!this.collector) {
      return { connected: false, label: '采集器未启动', role, argvConfigured: argv.configured, argvPort: argv.port, argvPath: argv.argvPath };
    }
    const s = this.collectorStatus || {};
    let label;
    if (!s.connected) label = argv.configured ? '未连接（调试端口未生效，可能需要重启 Trae）' : '未启用采集（需要写入调试端口并重启）';
    else if ((s.breakpointCount || 0) > 0) label = `已连接 · ${s.collectorCount || 0} 个目标 · ${s.breakpointCount} 个采集点`;
    else label = '已连接 · 正在定位采集点（打开一次 AI 对话即可）';
    return {
      connected: Boolean(s.connected),
      label,
      role,
      targetCount: s.targetCount || 0,
      collectorCount: s.collectorCount || 0,
      breakpoints: s.breakpointCount || 0,
      lastCaptureAt: s.lastCaptureAt || this.lastUsageAt || null,
      lastError: s.lastError || null,
      argvConfigured: argv.configured,
      argvPort: argv.port,
      argvPath: argv.argvPath
    };
  }

  // ---------------------------------------------------------------- data for UI
  getDashboardData(range = 'today') {
    const sinceMs = rangeToSinceMs(range);
    const cfg = this.config();
    let summary;
    try { summary = this.getSummary(sinceMs); } catch (err) { summary = { total: {}, models: [], hosts: [], days: [], recent: [] }; }
    let heatmap = { days: [] };
    try { heatmap = this.store.activityDays({ sinceMs: startOfDaysAgo(55) }); } catch { /* ignore */ }
    let recent = [];
    try {
      recent = this.store.recent({ limit: 200, sinceMs })
        .map((row) => toPublicUsageRecord(row, cfg.modelPrices, cfg.currency));
    } catch { /* ignore */ }
    const capture = this.captureState();
    const env = this.resolveEnv();
    return {
      range,
      summary: { ...summary, recent },
      recent,
      heatmap,
      capture,
      env: { appName: env.appName, appVersion: env.appVersion, extensionVersion: this.context.extension?.packageJSON?.version || 'dev' },
      config: cfg,
      generatedAt: Date.now()
    };
  }

  // ---------------------------------------------------------------- commands
  registerCommands() {
    const cmds = [
      ['traeTokenCost.openDashboard', (arg) => this.openDashboard(typeof arg === 'string' ? arg : undefined)],
      ['traeTokenCost.enableCapture', () => this.enableCapture()],
      ['traeTokenCost.configureOnly', () => this.enableCapture({ restart: false })],
      ['traeTokenCost.disableCapture', () => this.disableCapture()],
      ['traeTokenCost.copyLaunchCommand', () => this.copyLaunchCommand()],
      ['traeTokenCost.refresh', () => { this.refreshStatusBar(); this.dashboard?.sendUpdate(); }],
      ['traeTokenCost.exportCsv', () => this.exportData('csv')],
      ['traeTokenCost.exportJson', () => this.exportData('json')],
      ['traeTokenCost.showDiagnostics', () => this.showDiagnostics()],
      ['traeTokenCost.showLog', () => this.output.show(true)],
      ['traeTokenCost.clearData', () => this.clearData()],
      ['traeTokenCost.openReadme', () => this.openReadme()]
    ];
    for (const [id, handler] of cmds) {
      this.context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    }
  }

  openDashboard(range) {
    const DashboardPanel = require('./ui/dashboard').DashboardPanel;
    const effective = normalizeRange(range, this.config().defaultRange);
    this.dashboard = DashboardPanel.show(this, effective);
  }

  async enableCapture({ restart = true } = {}) {
    const cfg = this.config();
    const env = this.resolveEnv();
    const port = Number(cfg.cdpPort) || 9333;
    let argv;
    try { argv = readArgvFile(env.argvPath); } catch (err) { argv = { config: {}, existed: false }; }
    const currentPort = Number(argv.config && argv.config['remote-debugging-port']) || null;
    if (currentPort === port) {
      const action = await vscode.window.showInformationMessage(
        `Trae 启动参数已包含调试端口 ${port}。如果扩展状态仍显示未连接，请重启 Trae 使端口生效。`,
        '现在重启', '稍后手动重启'
      );
      if (action === '现在重启') await this.restartTrae(env, port);
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `将修改 Trae 启动参数（${env.argvPath}，会先备份原文件）并写入本机调试端口 ${port}。\n\n` +
      '这会让 Trae 以可被本机进程调试的方式启动；端口只绑定 127.0.0.1。重启 Trae 会中断正在运行的 AI 任务与终端。',
      { modal: true }, '修改并重启', '仅修改配置'
    );
    if (!confirm) return;
    let res;
    try {
      res = enableCdp({ argvPath: env.argvPath, port });
    } catch (err) {
      vscode.window.showErrorMessage(`写入启动参数失败：${err && err.message}`);
      return;
    }
    this.argvCache = null;
    this.log(`enableCdp: changed=${res.changed} backup=${res.backupPath || 'none'} port=${port}`);
    if (confirm === '仅修改配置' || restart === false) {
      vscode.window.showInformationMessage(`已写入启动参数（备份：${res.backupPath ? path.basename(res.backupPath) : '无'}）。完全退出并重新打开 Trae 后开始采集。`);
      return;
    }
    const action = await vscode.window.showInformationMessage(
      `已写入启动参数（备份：${res.backupPath ? path.basename(res.backupPath) : '无'}）。现在重启 Trae 后开始采集。`,
      '现在重启', '稍后手动重启'
    );
    if (action === '现在重启') await this.restartTrae(env, port);
  }

  async disableCapture() {
    const env = this.resolveEnv();
    const confirm = await vscode.window.showWarningMessage(
      `将删除 Trae 启动参数中的调试端口并还原启动配置（${env.argvPath}）。需要重启 Trae 生效。`,
      { modal: true }, '关闭并保留备份', '取消'
    );
    if (confirm !== '关闭并保留备份') return;
    try {
      const res = disableCdp({ argvPath: env.argvPath });
      this.argvCache = null;
      vscode.window.showInformationMessage(`已还原启动参数${res.changed ? '' : '（原本就没有调试端口）'}。重启 Trae 后采集停止。`);
    } catch (err) {
      vscode.window.showErrorMessage(`还原启动参数失败：${err && err.message}`);
    }
  }

  async restartTrae(env, port) {
    try {
      const workspaceArg = relaunch.buildWorkspaceArg({
        remoteAuthority: vscode.env.remoteAuthority || null,
        workspaceFile: vscode.workspace.workspaceFile ? vscode.workspace.workspaceFile.toString() : null,
        workspaceFolders: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.toString())
      });
      const restoreWindows = vscode.workspace.getConfiguration('window').get('restoreWindows') || 'all';
      const spec = relaunch.buildRelaunchSpec({
        platform: process.platform,
        appBundlePath: env.bundlePath,
        port,
        workspaceArg,
        restoreWindows
      });
      const guard = relaunch.createGuardScript({
        platform: process.platform,
        spec,
        logPath: path.join(this.sharedDir, 'relaunch.log'),
        tmpDir: os.tmpdir()
      });
      relaunch.launchDetached({ command: guard.command, args: guard.args });
      this.log(`relaunch guard started: ${guard.scriptPath}`);
      setTimeout(() => { vscode.commands.executeCommand('workbench.action.quit').then(undefined, () => {}); }, 1200);
    } catch (err) {
      this.log(`relaunch failed: ${err && err.stack ? err.stack : err}`);
      vscode.window.showErrorMessage(
        `自动重启失败：${err && err.message}。请手动：完全退出 Trae 后重新打开（启动参数已写好）。`,
        '复制启动命令'
      ).then((a) => { if (a === '复制启动命令') this.copyLaunchCommand(); });
    }
  }

  launchSpec() {
    const env = this.resolveEnv();
    const port = Number(this.config().cdpPort) || 9333;
    const workspaceArg = relaunch.buildWorkspaceArg({
      remoteAuthority: vscode.env.remoteAuthority || null,
      workspaceFile: vscode.workspace.workspaceFile ? vscode.workspace.workspaceFile.toString() : null,
      workspaceFolders: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.toString())
    });
    return relaunch.buildRelaunchSpec({
      platform: process.platform,
      appBundlePath: env.bundlePath,
      port,
      workspaceArg,
      restoreWindows: vscode.workspace.getConfiguration('window').get('restoreWindows') || 'all'
    });
  }

  async copyLaunchCommand() {
    const spec = this.launchSpec();
    const text = relaunch.copyLaunchCommand(spec);
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(`已复制启动命令（完全退出 Trae 后在终端执行）：\n${text}`, '知道了');
  }

  async exportData(format) {
    const pick = await vscode.window.showQuickPick(
      RANGE_ITEMS.map((r) => ({ label: r.label, description: `导出${r.label}数据`, value: r.value })),
      { placeHolder: '选择导出范围' }
    );
    if (!pick) return;
    await this.exportRange(format, pick.value);
  }

  async exportRange(format, range) {
    let content;
    let ext;
    try {
      const sinceMs = rangeToSinceMs(range);
      const records = Array.from(this.publicRecords(sinceMs));
      if (format === 'csv') {
        content = recordsToCsv(records);
        ext = 'csv';
      } else {
        content = JSON.stringify({
          exportedAt: new Date().toISOString(),
          range,
          currency: this.config().currency,
          records,
          summary: this.getSummary(sinceMs)
        }, null, 2);
        ext = 'json';
      }
    } catch (err) {
      vscode.window.showErrorMessage(`导出失败：${err && err.message}`);
      return;
    }
    const stamp = `${new Date().getFullYear()}${pad(new Date().getMonth() + 1)}${pad(new Date().getDate())}`;
    const target = await vscode.window.showSaveDialog({
      title: '保存 Trae Token 费用',
      defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads', `trae-token-cost-${range}-${stamp}.${ext}`)),
      filters: format === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] }
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
    vscode.window.showInformationMessage(`已导出：${target.fsPath}`, '打开所在文件夹').then((a) => {
      if (a === '打开所在文件夹') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.dirname(target.fsPath)));
    });
  }

  async showDiagnostics() {
    const env = this.resolveEnv();
    const argv = this.getArgvState(true);
    const cfg = this.config();
    let cdp = '未检测';
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.cdpPort}/json/version`, { signal: AbortSignal.timeout(1500) });
      cdp = res.ok ? `可连接（HTTP ${res.status}）` : `HTTP ${res.status}`;
    } catch (err) { cdp = `不可连接：${err && err.message}`; }
    let counts = '';
    try {
      const summary = this.getSummary(startOfToday());
      counts = `今日轮次=${summary.total.calls} tokens=${summary.total.total_tokens} estimated_cost=${summary.total.estimated_cost} unpriced_calls=${summary.total.unpriced_calls}`;
    } catch (err) { counts = `数据库错误：${err && err.message}`; }
    const status = this.captureState();
    const lines = [
      `时间：${formatDateTime(Date.now())}`,
      `Trae 扩展宿主：Node ${process.versions.node} / Electron ${process.versions.electron || 'n/a'} / ${process.platform} ${process.arch}`,
      `Trae：${env.appName} ${env.appVersion}（appRoot=${env.appRoot}）`,
      `扩展版本：${this.context.extension?.packageJSON?.version || 'dev'}`,
      `远程：${vscode.env.remoteName || '本机'}${vscode.env.remoteAuthority ? `（${vscode.env.remoteAuthority}）` : ''}`,
      `argv：${argv.argvPath}`,
      `argv 调试端口：${argv.port || '未配置'}（配置值 ${cfg.cdpPort}）${argv.error ? ` 错误：${argv.error}` : ''}`,
      `CDP ${cfg.cdpPort}：${cdp}`,
      `角色：${this.election?.role}；leader 状态：${JSON.stringify(this.election?.getStatus() || null)}`,
      `采集状态：${status.label}`,
      `采集器：${JSON.stringify(this.collectorStatus || null)}`,
      `数据目录：${this.globalDir}`,
      `数据库：${this.dbPath}`,
      `数据：${counts}`,
      `最近采集：${formatDateTime(status.lastCaptureAt)}`,
      `最后错误：${status.lastError || '无'}`
    ];
    this.output.show(true);
    this.output.appendLine('');
    this.output.appendLine('===== 诊断信息 =====');
    for (const line of lines) this.output.appendLine(line);
    const text = lines.join('\n');
    vscode.window.showInformationMessage('诊断信息已输出到 “Trae Token 费用” 输出面板。', '复制').then((a) => {
      if (a === '复制') vscode.env.clipboard.writeText(text);
    });
  }

  async clearData() {
    const confirm = await vscode.window.showWarningMessage('将清空本地所有 Trae Token 费用记录（不可恢复）。', { modal: true }, '清空', '取消');
    if (confirm !== '清空') return;
    try {
      this.store.clear();
      this.lastUsageAt = 0;
      this.refreshStatusBar();
      this.dashboard?.sendUpdate();
      vscode.window.showInformationMessage('本地用量数据已清空。');
    } catch (err) {
      vscode.window.showErrorMessage(`清空失败：${err && err.message}`);
    }
  }

  async openReadme() {
    const readme = path.join(this.context.extensionPath || path.join(__dirname, '..'), 'README.md');
    try {
      await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(readme));
    } catch {
      try { await vscode.window.showTextDocument(vscode.Uri.file(readme)); } catch (err) {
        vscode.window.showWarningMessage(`无法打开说明文档：${err && err.message}`);
      }
    }
  }

  // ---------------------------------------------------------------- logging
  log(message) {
    const line = `[${formatDateTime(Date.now())}] ${message}`;
    try { this.output.appendLine(line); } catch { /* ignore */ }
    // 节流：相同消息 30s 内只写一次，避免采集器未连接时刷屏/撑大日志
    const now = Date.now();
    if (this.lastLogMessage === message && now - (this.lastLogAt || 0) < 30000) return;
    this.lastLogMessage = message;
    this.lastLogAt = now;
    try {
      if (fs.existsSync(this.logPath) && fs.statSync(this.logPath).size > 2 * 1024 * 1024) fs.renameSync(this.logPath, `${this.logPath}.old`);
      fs.appendFileSync(this.logPath, line + '\n');
    } catch { /* ignore */ }
  }
}

let extensionInstance = null;

async function activate(context) {
  extensionInstance = new TraeTokenExtension(context);
  context.subscriptions.push({ dispose: () => extensionInstance?.dispose() });
  try {
    await extensionInstance.start();
  } catch (err) {
    extensionInstance.log(`activate failed: ${err && err.stack ? err.stack : err}`);
    vscode.window.showErrorMessage(`Trae Token 费用启动失败：${err && err.message}（可运行“显示诊断信息”）`);
  }
  return extensionInstance;
}

function deactivate() {
  try { extensionInstance?.dispose(); } catch { /* ignore */ }
  extensionInstance = null;
}

module.exports = {
  activate,
  deactivate,
  TraeTokenExtension,
  // 供测试使用
  _internal: { parseRemoteAuthority, rangeToSinceMs, startOfToday, startOfWeek, startOfMonth, formatTokens }
};
