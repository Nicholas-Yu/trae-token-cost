#!/bin/sh
set -eu

ROOT="$(cd -- "$(dirname -- "$0")" && pwd)"

if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x /opt/homebrew/bin/node ]; then
  NODE_BIN="/opt/homebrew/bin/node"
elif [ -x /usr/local/bin/node ]; then
  NODE_BIN="/usr/local/bin/node"
else
  echo "未找到 Node.js，请先安装 Node.js 22.5 或更高版本。"
  exit 1
fi

if ! "$NODE_BIN" -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1)"; then
  echo "本地网页看板需要 Node.js 22.5 或更高版本。"
  exit 1
fi

# 前台运行：关闭终端或按 Ctrl+C 即停止只读服务。
exec "$NODE_BIN" "$ROOT/src/standalone/cli.js" "$@"
