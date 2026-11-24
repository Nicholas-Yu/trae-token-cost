#!/bin/bash
# 等待 Trae 带 CDP 端口重启后，自动运行 M0 探针（默认等 3 小时、跑 20 分钟）。
# 用法：bash scripts/wait-and-probe.sh [port] [waitSecs] [probeSecs]
set -u
cd "$(dirname "$0")/.."
PORT="${1:-9222}"
WAIT_SECS="${2:-10800}"
PROBE_SECS="${3:-1200}"
deadline=$(( $(date +%s) + WAIT_SECS ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if curl -s -m 2 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    echo "[wait-and-probe] $(date '+%F %T') CDP detected on ${PORT}, starting probe for ${PROBE_SECS}s"
    exec node scripts/probe-cdp.mjs --port "$PORT" --out probe-output --seconds "$PROBE_SECS"
  fi
  sleep 3
done
echo "[wait-and-probe] $(date '+%F %T') timeout: CDP port ${PORT} never appeared (Trae 未重启或未带调试端口)"
exit 1
