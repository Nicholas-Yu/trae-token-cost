#!/bin/bash
# 用户重启 Trae 后自动做 E2E 自检：先记录初始状态，等扩展采到第一条记录后再记录最终状态。
# 产物：probe-output/e2e-initial.json / e2e-final.json / e2e-watch.log
set -u
cd "$(dirname "$0")/.."
PORT="${1:-9222}"
WAIT_SECS="${2:-10800}"
RECORD_TIMEOUT="${3:-2400}"
LOG=probe-output/e2e-watch.log
mkdir -p probe-output
deadline=$(( $(date +%s) + WAIT_SECS ))
echo "[watch-e2e] $(date '+%F %T') 等待 CDP ${PORT}（最多 ${WAIT_SECS}s）" >>"$LOG"
while [ "$(date +%s)" -lt "$deadline" ]; do
  if curl -s -m 2 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    echo "[watch-e2e] $(date '+%F %T') CDP 已就绪，等扩展加载 …" >>"$LOG"
    sleep 25
    node scripts/e2e-check.mjs --port "$PORT" --json >probe-output/e2e-initial.json 2>probe-output/e2e-initial.err || true
    echo "[watch-e2e] $(date '+%F %T') 初始自检已保存 e2e-initial.json" >>"$LOG"
    DB="$HOME/Library/Application Support/Trae CN/User/globalStorage/local.trae-token-usage/usage.db"
    t0=$(date +%s)
    while [ $(( $(date +%s) - t0 )) -lt "$RECORD_TIMEOUT" ]; do
      if [ -f "$DB" ]; then
        n=$(node -e 'try{const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare("select count(*) c from calls").get().c)}catch(e){console.log(0)}' "$DB" 2>/dev/null)
        if [ -n "${n:-}" ] && [ "$n" != "0" ]; then
          echo "[watch-e2e] $(date '+%F %T') 已采集到 ${n} 条记录，生成最终自检" >>"$LOG"
          sleep 5
          node scripts/e2e-check.mjs --port "$PORT" --json >probe-output/e2e-final.json 2>probe-output/e2e-final.err || true
          node scripts/e2e-check.mjs --port "$PORT" >>"$LOG" 2>&1 || true
          echo "[watch-e2e] $(date '+%F %T') DONE" >>"$LOG"
          exit 0
        fi
      fi
      sleep 10
    done
    echo "[watch-e2e] $(date '+%F %T') 超时：${RECORD_TIMEOUT}s 内没有采集到记录" >>"$LOG"
    exit 2
  fi
  sleep 3
done
echo "[watch-e2e] $(date '+%F %T') 超时：一直未检测到 CDP ${PORT}" >>"$LOG"
exit 1
