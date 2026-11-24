#!/usr/bin/env node
/**
 * 数据维护：历史 unknown 模型回填、跨形状重复行清理、清空。
 * 用法：
 *   node scripts/maintenance.mjs --backfill
 *   node scripts/maintenance.mjs --dedupe-cross-shape
 *   node scripts/maintenance.mjs --clear
 *   node scripts/maintenance.mjs --report
 * 默认操作本机 Trae CN 扩展的实际数据库；--db 可指定路径。
 */
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const args = process.argv.slice(2);
const dbArg = args.indexOf('--db') >= 0 ? args[args.indexOf('--db') + 1] : null;
const DB = dbArg || path.join(os.homedir(), 'Library/Application Support/Trae CN/User/globalStorage/local.trae-token-usage/usage.db');
const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout=5000');
db.exec('PRAGMA journal_mode=WAL');

function report() {
  const total = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(total_tokens),0) t FROM calls').get();
  const models = db.prepare('SELECT model, COUNT(*) c, SUM(total_tokens) t FROM calls GROUP BY model ORDER BY t DESC').all();
  console.log(`records=${total.c} tokens=${total.t}`);
  for (const m of models) console.log(`  model=${m.model} calls=${m.c} tokens=${m.t}`);
}

function backfill() {
  const sql = `
    UPDATE calls SET model = (
      SELECT c2.model FROM calls c2
      WHERE c2.session_key = calls.session_key
        AND c2.model IS NOT NULL AND c2.model NOT IN ('', 'unknown')
      ORDER BY c2.id DESC LIMIT 1
    )
    WHERE (model = 'unknown' OR model = '' OR model IS NULL)
      AND session_key IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM calls c2
        WHERE c2.session_key = calls.session_key
          AND c2.model IS NOT NULL AND c2.model NOT IN ('', 'unknown')
      )`;
  const r = db.prepare(sql).run();
  console.log(`backfillModels: ${Number(r.changes) || 0} rows updated`);
}

function dedupeCrossShape() {
  // 同会话、同 token 三件套、15s 内，保留有模型名的一行
  const sql = `
    DELETE FROM calls AS a
    WHERE a.model IN ('unknown', '')
      AND EXISTS (
        SELECT 1 FROM calls b
        WHERE b.session_key = a.session_key
          AND b.input_tokens = a.input_tokens
          AND b.output_tokens = a.output_tokens
          AND b.total_tokens = a.total_tokens
          AND b.model IS NOT NULL AND b.model NOT IN ('', 'unknown')
          AND ABS(b.observed_at - a.observed_at) <= 15000
      )`;
  const r = db.prepare(sql).run();
  console.log(`dedupeCrossShape: ${Number(r.changes) || 0} duplicate rows removed`);
}

function clear() {
  const r = db.prepare('DELETE FROM calls').run();
  db.exec('DELETE FROM meta');
  console.log(`clear: ${Number(r.changes) || 0} rows deleted`);
}

console.log('db=', DB);
report();
if (args.includes('--backfill')) { backfill(); report(); }
if (args.includes('--dedupe-cross-shape')) { dedupeCrossShape(); report(); }
if (args.includes('--clear')) { clear(); report(); }
db.close();
