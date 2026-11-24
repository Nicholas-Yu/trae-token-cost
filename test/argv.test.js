'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseJsonc,
  readArgvFile,
  enableCdp,
  disableCdp,
  copyBackupPath,
} = require('../src/setup/argv');

function makeDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-argv-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  return dir;
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function listBackups(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes('.bak-'));
}

function assertNoTmpFiles(dir) {
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'));
  assert.deepStrictEqual(leftovers, [], '原子写不应残留临时文件');
}

const ORIGINAL_ARGV = `{
  // 用户自己的配置
  "locale": "zh-cn",
  "enable-crash-reporter": false, /* 块注释 */
  "telemetry": {
    "enable": true,
  },
}
`;

test('parseJsonc：容错行注释、块注释、尾逗号', () => {
  const text = `{
    // line comment
    "a": 1,
    "b": [1, 2, 3,],
    /* block
       comment */
    "c": { "d": "x", },
  }`;
  assert.deepStrictEqual(parseJsonc(text), { a: 1, b: [1, 2, 3], c: { d: 'x' } });
});

test('parseJsonc：字符串里的 // 与 /* */ 不被当作注释', () => {
  const text = `{
    "url": "https://example.com/path//segment",
    "literal": "/* not a comment */ and // no",
    "comma": "a, ] }",
    "quote": "he said \\"hi\\""
  }`;
  assert.deepStrictEqual(parseJsonc(text), {
    url: 'https://example.com/path//segment',
    literal: '/* not a comment */ and // no',
    comma: 'a, ] }',
    quote: 'he said "hi"',
  });
});

test('parseJsonc：BOM / 空文本 / 非法输入', () => {
  assert.deepStrictEqual(parseJsonc('\uFEFF{"a": 1}'), { a: 1 });
  assert.deepStrictEqual(parseJsonc(''), {});
  assert.deepStrictEqual(parseJsonc('  \n\t '), {});
  assert.throws(() => parseJsonc('{ not json'), /argv\.json 解析失败/);
  assert.throws(() => parseJsonc('[1, 2]'), /顶层必须是 JSON 对象/);
  assert.throws(() => parseJsonc(null), TypeError);
});

test('readArgvFile：不存在 / JSONC / 空文件 / 非法', (t) => {
  const dir = makeDir(t);
  const argvPath = path.join(dir, 'argv.json');

  assert.deepStrictEqual(readArgvFile(argvPath), { config: {}, existed: false });

  fs.writeFileSync(argvPath, ORIGINAL_ARGV, 'utf8');
  const read = readArgvFile(argvPath);
  assert.strictEqual(read.existed, true);
  assert.strictEqual(read.config.locale, 'zh-cn');
  assert.strictEqual(read.config['enable-crash-reporter'], false);
  assert.deepStrictEqual(read.config.telemetry, { enable: true });

  fs.writeFileSync(argvPath, '   \n', 'utf8');
  assert.deepStrictEqual(readArgvFile(argvPath), { config: {}, existed: true });

  fs.writeFileSync(argvPath, '{ invalid', 'utf8');
  assert.throws(() => readArgvFile(argvPath), /argv\.json 解析失败/);
});

test('enableCdp：文件不存在时创建（无备份），原子写、2 空格缩进、末尾换行', (t) => {
  const dir = makeDir(t);
  const argvPath = path.join(dir, 'argv.json');

  const result = enableCdp({ argvPath, port: 9222 });
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.backupPath, null);
  assert.strictEqual(result.config['remote-debugging-port'], '9222');

  assert.ok(fs.existsSync(argvPath));
  const text = readText(argvPath);
  assert.ok(text.endsWith('\n'), '末尾应有换行');
  assert.ok(text.includes('\n  "remote-debugging-port": "9222"'), '应使用 2 空格缩进且端口为字符串');
  assert.deepStrictEqual(JSON.parse(text), { 'remote-debugging-port': '9222' });
  assert.strictEqual(fs.statSync(argvPath).mode & 0o777, 0o600);
  assertNoTmpFiles(dir);
});

test('enableCdp：备份原文件（0600、内容一致），保留原键，幂等', (t) => {
  const dir = makeDir(t);
  const argvPath = path.join(dir, 'argv.json');
  fs.writeFileSync(argvPath, ORIGINAL_ARGV, 'utf8');

  const first = enableCdp({ argvPath, port: 9222 });
  assert.strictEqual(first.changed, true);
  assert.ok(first.backupPath, '应生成备份');
  assert.match(path.basename(first.backupPath), /^argv\.json\.bak-\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
  assert.strictEqual(readText(first.backupPath), ORIGINAL_ARGV, '备份必须保存写前内容');
  assert.strictEqual(fs.statSync(first.backupPath).mode & 0o777, 0o600);

  const saved = JSON.parse(readText(argvPath));
  assert.strictEqual(saved.locale, 'zh-cn');
  assert.strictEqual(saved['enable-crash-reporter'], false);
  assert.deepStrictEqual(saved.telemetry, { enable: true });
  assert.strictEqual(saved['remote-debugging-port'], '9222');
  assert.strictEqual(listBackups(dir).length, 1);

  // 幂等：重复调用不产生新备份、不重写文件。
  const textAfterFirst = readText(argvPath);
  const second = enableCdp({ argvPath, port: 9222 });
  assert.strictEqual(second.changed, false);
  assert.strictEqual(second.backupPath, null);
  assert.strictEqual(readText(argvPath), textAfterFirst);
  assert.strictEqual(listBackups(dir).length, 1);

  // 换端口：重新备份并更新。
  const third = enableCdp({ argvPath, port: 9333 });
  assert.strictEqual(third.changed, true);
  assert.ok(third.backupPath);
  assert.strictEqual(JSON.parse(readText(argvPath))['remote-debugging-port'], '9333');
  assert.strictEqual(listBackups(dir).length, 2);
  assertNoTmpFiles(dir);
});

test('disableCdp：移除端口键、保留其它键、幂等、有备份', (t) => {
  const dir = makeDir(t);
  const argvPath = path.join(dir, 'argv.json');
  fs.writeFileSync(argvPath, ORIGINAL_ARGV, 'utf8');

  enableCdp({ argvPath, port: 9222 });
  const backupsBeforeDisable = listBackups(dir).length;

  const disabled = disableCdp({ argvPath });
  assert.strictEqual(disabled.changed, true);
  assert.ok(disabled.backupPath);
  const saved = JSON.parse(readText(argvPath));
  assert.ok(!Object.prototype.hasOwnProperty.call(saved, 'remote-debugging-port'));
  assert.strictEqual(saved.locale, 'zh-cn');
  assert.deepStrictEqual(saved.telemetry, { enable: true });
  assert.strictEqual(listBackups(dir).length, backupsBeforeDisable + 1);
  assertNoTmpFiles(dir);

  // 幂等
  const again = disableCdp({ argvPath });
  assert.strictEqual(again.changed, false);
  assert.strictEqual(again.backupPath, null);
  assert.strictEqual(listBackups(dir).length, backupsBeforeDisable + 1);

  // 文件不存在：不创建、不报错
  const missingPath = path.join(dir, 'missing', 'argv.json');
  const missing = disableCdp({ argvPath: missingPath });
  assert.strictEqual(missing.changed, false);
  assert.strictEqual(missing.backupPath, null);
  assert.strictEqual(fs.existsSync(missingPath), false);
});

test('端口校验：非法端口抛错且不改文件', (t) => {
  const dir = makeDir(t);
  const argvPath = path.join(dir, 'argv.json');
  fs.writeFileSync(argvPath, '{}\n', 'utf8');

  for (const badPort of [0, -1, 65536, 1.5, 'abc', null, undefined]) {
    assert.throws(() => enableCdp({ argvPath, port: badPort }), RangeError, `port=${String(badPort)}`);
  }
  assert.strictEqual(readText(argvPath), '{}\n');
  assert.strictEqual(listBackups(dir).length, 0);
  assert.throws(() => enableCdp({ argvPath: '' , port: 9222 }), TypeError);
});

test('copyBackupPath：生成 argv.json.bak-<ISO 时间戳>，0600，不覆盖已有备份', (t) => {
  const dir = makeDir(t);
  const argvPath = path.join(dir, 'argv.json');
  fs.writeFileSync(argvPath, ORIGINAL_ARGV, 'utf8');

  const backup1 = copyBackupPath(argvPath);
  assert.match(path.basename(backup1), /^argv\.json\.bak-\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
  assert.strictEqual(readText(backup1), ORIGINAL_ARGV);
  assert.strictEqual(fs.statSync(backup1).mode & 0o777, 0o600);

  const backup2 = copyBackupPath(argvPath);
  assert.notStrictEqual(backup1, backup2, '第二次备份不应覆盖第一次');
  assert.strictEqual(readText(backup2), ORIGINAL_ARGV);
  assert.strictEqual(fs.existsSync(backup1), true);

  const backupOfBackup = copyBackupPath(backup1);
  assert.notStrictEqual(backupOfBackup, backup1);
  assert.ok(backupOfBackup.includes('-copy-'));
  assert.strictEqual(readText(backupOfBackup), ORIGINAL_ARGV);
});
