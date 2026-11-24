'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const paths = {
  plist: path.join(root, 'scripts/launchd/local.trae-token-cost.dashboard.plist'),
  install: path.join(root, 'scripts/install-dashboard-agent.command'),
  uninstall: path.join(root, 'scripts/uninstall-dashboard-agent.command')
};

function readIfPresent(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8' });
}

test('launchd模板保留占位符，临时渲染后的XML参数和保活配置正确', (t) => {
  const template = readIfPresent(paths.plist);
  for (const placeholder of ['__NODE_PATH__', '__PROJECT_DIR__', '__HOME_DIR__']) {
    assert.ok(template.includes(placeholder), `缺少${placeholder}`);
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-agent-'));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const renderedPath = path.join(temporaryDirectory, 'dashboard.plist');
  const replacements = {
    __NODE_PATH__: '/opt/homebrew/bin/node',
    __PROJECT_DIR__: '/tmp/trae token cost',
    __HOME_DIR__: '/tmp/test home'
  };
  const rendered = template.replace(/__(?:NODE_PATH|PROJECT_DIR|HOME_DIR)__/g, (key) => replacements[key]);
  fs.writeFileSync(renderedPath, rendered);

  const lint = run('plutil', ['-lint', renderedPath]);
  assert.equal(lint.status, 0, lint.stderr);
  const converted = run('plutil', ['-convert', 'json', '-o', '-', renderedPath]);
  assert.equal(converted.status, 0, converted.stderr);
  const config = JSON.parse(converted.stdout);
  assert.equal(config.Label, 'local.trae-token-cost.dashboard');
  assert.deepEqual(config.ProgramArguments, [
    '/opt/homebrew/bin/node',
    '/tmp/trae token cost/src/standalone/cli.js',
    '--port',
    '8765',
    '--no-open',
    '--capture'
  ]);
  assert.equal(config.WorkingDirectory, '/tmp/trae token cost');
  assert.equal(config.RunAtLoad, true);
  assert.equal(config.KeepAlive, true);
  assert.equal(config.ThrottleInterval, 10);
  assert.match(config.StandardOutPath, /^\/tmp\/test home\/Library\/Logs\//);
  assert.match(config.StandardErrorPath, /^\/tmp\/test home\/Library\/Logs\//);
  assert.ok(!JSON.stringify(config).includes('__'));
});

test('安装脚本支持同标签安全升级并保护其他端口占用者', () => {
  const script = readIfPresent(paths.install);
  assert.match(script, /process\.versions\.node/);
  assert.match(script, /major > 22 \|\| \(major === 22 && minor >= 5\)/);
  assert.match(script, /capture-runtime\.js/);
  assert.match(script, /launchctl print/);
  assert.match(script, /SERVICE_LOADED/);
  assert.match(script, /\[ "\$SERVICE_LOADED" -eq 0 \] && lsof[^\n]*8765/);
  assert.match(script, /osascript/);
  assert.ok((script.match(/\bconfirm "/g) || []).length >= 2, '写盘与bootstrap必须分别确认');
  assert.match(script, /plutil[^\n]*-lint/);
  assert.match(script, /launchctl bootout/);
  assert.match(script, /launchctl bootstrap "?gui\/\$\(id -u\)"?/);
  assert.match(script, /cp[^\n]*PLIST_PATH/);
  assert.match(script, /curl[^\n]*127\.0\.0\.1:8765/);
  assert.match(script, /open "?http:\/\/127\.0\.0\.1:8765"?/);
  assert.doesNotMatch(script, /未找到用量数据库/);
  assert.ok(script.indexOf('launchctl print') < script.indexOf('mkdir -p "$LAUNCH_AGENTS_DIR"'), '服务与端口检查必须先于安装写入逻辑');
  assert.ok(script.indexOf('plutil -lint') < script.indexOf('launchctl bootout'), '自检必须先于停止旧服务');
  assert.ok(script.indexOf('launchctl bootout') < script.indexOf('\nlaunchctl bootstrap'), '升级必须先退出旧实例再启动新实例');
  assert.ok(script.lastIndexOf('curl') < script.lastIndexOf('open'), '健康检查必须先于打开浏览器');
  assert.doesNotMatch(script, /\b(?:sudo|nohup|pkill|killall)\b|^\s*kill\s/m);
});

test('卸载脚本提供停止与删除分支，保留plist时明确提示登录自启', () => {
  const script = readIfPresent(paths.uninstall);
  assert.match(script, /osascript/);
  assert.match(script, /仅停止/);
  assert.match(script, /停止并删除/);
  assert.match(script, /launchctl bootout "?gui\/\$\(id -u\)\/local\.trae-token-cost\.dashboard"?/);
  assert.match(script, /lsof[^\n]*8765/);
  assert.match(script, /"停止并删除"\)[\s\S]*?rm -f "\$PLIST_PATH"/);
  assert.match(script, /"仅停止"\)[\s\S]*?下次登录[^\n]*自动启动/);
  assert.doesNotMatch(script, /\b(?:sudo|nohup|pkill|killall)\b|^\s*kill\s/m);
});

test('安装与卸载脚本通过shell语法检查且具有可执行权限', () => {
  for (const filePath of [paths.install, paths.uninstall]) {
    const result = run('sh', ['-n', filePath]);
    assert.equal(result.status, 0, `${filePath}: ${result.stderr}`);
    assert.ok(fs.statSync(filePath).mode & 0o111, `${filePath}不可执行`);
  }
});
