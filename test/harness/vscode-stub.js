'use strict';

/**
 * 极简 VS Code API stub，仅覆盖扩展用到的 API，用于在纯 Node 下做集成测试。
 * 用法：在 require 扩展前调用 installVscodeStub({...})。
 */

const path = require('node:path');

function createDisposable(fn) {
  return { dispose: typeof fn === 'function' ? fn : () => {} };
}

function createMarkdownString(value, supportThemeIcons) {
  return {
    value: value || '',
    isTrusted: false,
    supportThemeIcons: Boolean(supportThemeIcons),
    appendMarkdown(text) { this.value += text; return this; },
    appendText(text) { this.value += text; return this; },
    toString() { return this.value; }
  };
}

function installVscodeStub(options = {}) {
  const state = {
    commands: new Map(),
    outputLines: [],
    statusBars: [],
    panels: [],
    messages: [],
    quickPickResult: options.quickPickResult ?? null,
    saveDialogResult: options.saveDialogResult ?? null,
    clipboard: '',
    config: options.config || {},
    workspaceFolders: options.workspaceFolders || [],
    workspaceName: options.workspaceName || 'test-workspace',
    remoteName: options.remoteName ?? null,
    remoteAuthority: options.remoteAuthority ?? null,
    appRoot: options.appRoot || '/tmp/fake-trae-app',
    appName: options.appName || 'Trae CN',
    registeredCommands: new Map()
  };

  const emitterList = [];
  const windowApi = {
    activeTextEditor: undefined,
    createOutputChannel(name) {
      return {
        name,
        appendLine(line) { state.outputLines.push(line); },
        append(line) { state.outputLines.push(line); },
        show() {},
        dispose() {}
      };
    },
    createStatusBarItem(alignment, priority) {
      const item = {
        alignment,
        priority,
        text: '',
        tooltip: undefined,
        command: undefined,
        name: '',
        color: undefined,
        backgroundColor: undefined,
        visible: false,
        show() { this.visible = true; },
        hide() { this.visible = false; },
        dispose() {}
      };
      state.statusBars.push(item);
      return item;
    },
    createWebviewPanel(viewType, title, column, opts) {
      const messageHandlers = [];
      const disposeHandlers = [];
      const webview = {
        cspSource: 'vscode-resource:',
        html: '',
        onDidReceiveMessage(handler) {
          messageHandlers.push(handler);
          return createDisposable();
        },
        postMessage: async (msg) => { panel.postedMessages.push(msg); return true; },
        asWebviewUri: (uri) => uri
      };
      const panel = {
        viewType,
        title,
        viewColumn: column,
        options: opts,
        webview,
        postedMessages: [],
        revealed: 0,
        disposed: false,
        iconPath: undefined,
        onDidDispose(handler) { disposeHandlers.push(handler); return createDisposable(); },
        reveal() { this.revealed += 1; },
        dispose() {
          this.disposed = true;
          for (const fn of disposeHandlers) fn();
        },
        _sendToExtension(msg) {
          for (const fn of messageHandlers) fn(msg);
        }
      };
      state.panels.push(panel);
      return panel;
    },
    showInformationMessage(message, ...args) {
      state.messages.push({ type: 'info', message, args });
      const buttons = args.filter((a) => typeof a === 'string');
      return Promise.resolve(options.messageAction ? options.messageAction(message, buttons) : undefined);
    },
    showWarningMessage(message, ...args) {
      state.messages.push({ type: 'warning', message, args });
      const buttons = args.filter((a) => typeof a === 'string');
      return Promise.resolve(options.warningAction ? options.warningAction(message, buttons) : undefined);
    },
    showErrorMessage(message, ...args) {
      state.messages.push({ type: 'error', message, args });
      return Promise.resolve(undefined);
    },
    showQuickPick(items, opts) {
      return Promise.resolve(options.quickPickResult ?? null);
    },
    showSaveDialog(opts) {
      return Promise.resolve(options.saveDialogResult ?? null);
    },
    async showTextDocument() { return { document: {} }; }
  };

  const workspaceApi = {
    name: state.workspaceName,
    workspaceFolders: state.workspaceFolders,
    workspaceFile: options.workspaceFile ?? undefined,
    getConfiguration(section) {
      return {
        get(key, def) {
          const full = section ? `${section}.${key}` : key;
          if (Object.prototype.hasOwnProperty.call(state.config, full)) return state.config[full];
          if (Object.prototype.hasOwnProperty.call(state.config, key)) return state.config[key];
          return def;
        },
        update() { return Promise.resolve(); }
      };
    },
    onDidChangeConfiguration(handler) {
      emitterList.push(handler);
      return createDisposable();
    },
    fs: {
      async writeFile(uri, content) { state.lastWrite = { uri, content }; }
    }
  };

  const env = {
    appRoot: state.appRoot,
    appName: state.appName,
    remoteName: state.remoteName,
    remoteAuthority: state.remoteAuthority,
    clipboard: {
      async writeText(t) { state.clipboard = t; },
      async readText() { return state.clipboard; }
    },
    openExternal: async () => true,
    language: 'zh-cn'
  };

  const vscode = {
    version: '1.107.1',
    window: windowApi,
    workspace: workspaceApi,
    env,
    commands: {
      registerCommand(id, handler) {
        state.registeredCommands.set(id, handler);
        return createDisposable();
      },
      async executeCommand(id, ...args) {
        const fn = state.registeredCommands.get(id);
        if (fn) return fn(...args);
        return undefined;
      },
      getCommands: async () => [...state.registeredCommands.keys()]
    },
    Uri: {
      file(p) { return { fsPath: p, scheme: 'file', path: p, toString: () => 'file://' + p }; },
      parse(s) { return { scheme: 'file', path: s, fsPath: s, toString: () => s }; },
      joinPath(base, ...parts) {
        const p = path.join(base.fsPath || base.path || String(base), ...parts);
        return vscode.Uri.file(p);
      }
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { One: 1, Two: 2, Beside: -2 },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
    MarkdownString: createMarkdownString,
    Disposable: { from: () => createDisposable() },
    EventEmitter: class EventEmitter {
      constructor() { this.listeners = new Map(); }
      get event() { return (fn) => { const arr = this.listeners.get('x') || []; arr.push(fn); this.listeners.set('x', arr); return createDisposable(); }; }
      fire(value) { for (const fn of this.listeners.get('x') || []) fn(value); }
      dispose() {}
    }
  };

  // 注入 vscode 模块解析（供扩展 require('vscode')）
  const Module = require('node:module');
  const originalLoad = Module._load;
  const already = Module._load.__traeStub;
  if (!already) {
    Module._load = function loadPatched(request, parent, isMain) {
      if (request === 'vscode') return vscode;
      return originalLoad.apply(this, arguments);
    };
    Module._load.__traeStub = true;
  }
  return {
    vscode,
    state,
    // 模拟 VS Code 配置变更事件，供 onDidChangeConfiguration 链路测试。
    fireConfigChange(section = 'traeTokenCost') {
      const event = { affectsConfiguration: (s) => s === section || section.startsWith(`${s}.`) };
      for (const handler of [...emitterList]) handler(event);
    },
    uninstall() { Module._load = originalLoad; }
  };
}

module.exports = { installVscodeStub, createMarkdownString };
