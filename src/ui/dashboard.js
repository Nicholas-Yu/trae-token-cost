'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class DashboardPanel {
  /** 单窗口内单例；重复打开则聚焦并切范围 */
  static show(extension, range = 'today') {
    if (DashboardPanel.current) {
      DashboardPanel.current.reveal(range);
      return DashboardPanel.current;
    }
    DashboardPanel.current = new DashboardPanel(extension, range);
    return DashboardPanel.current;
  }

  constructor(extension, range) {
    this.extension = extension;
    this.range = range || 'today';
    this.disposed = false;

    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
    this.panel = vscode.window.createWebviewPanel(
      'traeTokenCost.dashboard',
      'Trae Token 费用',
      column,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );

    const icon = path.join(extension.context.extensionPath || path.join(__dirname, '..', '..'), 'media', 'icon.png');
    if (fs.existsSync(icon)) this.panel.iconPath = vscode.Uri.file(icon);

    this.panel.onDidDispose(() => { this.disposed = true; DashboardPanel.current = null; }, null, extension.context.subscriptions);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, extension.context.subscriptions);
    this.panel.webview.html = this.renderHtml(this.extension.getDashboardData(this.range));
  }

  reveal(range) {
    if (this.disposed) return;
    if (range) this.range = range;
    this.panel.reveal(this.panel.viewColumn);
    this.sendUpdate();
  }

  postMessage(message) {
    if (this.disposed) return;
    this.panel.webview.postMessage(message).then(undefined, () => { /* panel gone */ });
  }

  sendUpdate() {
    if (this.disposed) return;
    try {
      this.postMessage({ type: 'update', payload: this.extension.getDashboardData(this.range) });
    } catch (err) {
      this.extension.log(`dashboard update failed: ${err && err.message}`);
    }
  }

  async onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    try {
      switch (msg.type) {
        case 'ready':
          this.sendUpdate();
          break;
        case 'refresh':
          if (typeof msg.range === 'string') this.range = msg.range;
          this.sendUpdate();
          break;
        case 'export':
          if (msg.format === 'csv' || msg.format === 'json') {
            this.extension.exportRange(msg.format, this.range);
          }
          break;
        case 'enableCapture':
          await this.extension.enableCapture();
          break;
        case 'disableCapture':
          await this.extension.disableCapture();
          break;
        case 'diagnostics':
          await this.extension.showDiagnostics();
          break;
        case 'copyLaunchCommand':
          await this.extension.copyLaunchCommand();
          break;
        case 'clearData':
          await this.extension.clearData();
          break;
        case 'openReadme':
          await this.extension.openReadme();
          break;
        default:
          break;
      }
    } catch (err) {
      this.extension.log(`dashboard message ${msg.type} failed: ${err && err.stack ? err.stack : err}`);
    }
  }

  renderHtml(payload) {
    const templatePath = path.join(__dirname, 'dashboard.html');
    let template = fs.readFileSync(templatePath, 'utf8');
    const nonce = crypto.randomBytes(16).toString('base64');
    const cspSource = this.panel.webview.cspSource;
    const safeJson = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    return template
      .replace(/\{\{cspSource\}\}/g, cspSource)
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{initialJson\}\}/g, safeJson)
      .replace(/\{\{transportAdapter\}\}/g, 'acquireVsCodeApi()')
      .replace(/\{\{extensionVersion\}\}/g, String(this.extension.context.extension?.packageJSON?.version || 'dev'));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try { this.panel.dispose(); } catch { /* ignore */ }
    DashboardPanel.current = null;
  }
}

DashboardPanel.current = null;

module.exports = { DashboardPanel };
