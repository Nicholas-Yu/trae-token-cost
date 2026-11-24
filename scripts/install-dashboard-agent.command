#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
TEMPLATE_PATH="$PROJECT_DIR/scripts/launchd/local.trae-token-cost.dashboard.plist"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_AGENTS_DIR/local.trae-token-cost.dashboard.plist"
LAUNCHD_DOMAIN="gui/$(id -u)"
LAUNCHD_LABEL="local.trae-token-cost.dashboard"

confirm() {
  /usr/bin/osascript - "$1" <<'APPLESCRIPT'
on run argv
  display dialog (item 1 of argv) buttons {"取消", "继续"} default button "取消" cancel button "取消" with icon caution
end run
APPLESCRIPT
}

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

if [ ! -f "$TEMPLATE_PATH" ] || [ ! -f "$PROJECT_DIR/src/standalone/cli.js" ] || [ ! -f "$PROJECT_DIR/src/standalone/capture-runtime.js" ]; then
  echo "安装模板、看板或采集入口缺失，请保持仓库目录完整。"
  exit 1
fi

SERVICE_LOADED=0
if launchctl print "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" >/dev/null 2>&1; then
  SERVICE_LOADED=1
fi

# 其他进程占用端口时先退出；同标签服务则允许安全升级。
if [ "$SERVICE_LOADED" -eq 0 ] && lsof -nP -iTCP:8765 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 8765 已被其他进程占用；未修改文件，也未结束现有进程。"
  exit 1
fi

if ! confirm "即将写入或覆盖 $PLIST_PATH；已有文件会先备份。是否继续？" >/dev/null; then
  echo "已取消，未修改文件。"
  exit 0
fi

mkdir -p "$LAUNCH_AGENTS_DIR"
mkdir -p "$HOME/Library/Logs"
CANDIDATE_PATH="$(mktemp "$LAUNCH_AGENTS_DIR/.local.trae-token-cost.dashboard.XXXXXX")"
trap 'rm -f "$CANDIDATE_PATH"' 0 1 2 3 15

"$NODE_BIN" - "$TEMPLATE_PATH" "$CANDIDATE_PATH" "$NODE_BIN" "$PROJECT_DIR" "$HOME" <<'NODE'
const fs = require('node:fs');
const [templatePath, outputPath, nodePath, projectDir, homeDir] = process.argv.slice(2);
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const xmlEscape = (value) => value.replace(/[&<>"']/g, (character) => entities[character]);
let rendered = fs.readFileSync(templatePath, 'utf8');
// 路径先转义再替换，避免目录中的特殊字符破坏 XML。
for (const [placeholder, value] of Object.entries({
  __NODE_PATH__: nodePath,
  __PROJECT_DIR__: projectDir,
  __HOME_DIR__: homeDir
})) {
  rendered = rendered.replaceAll(placeholder, xmlEscape(value));
}
if (/__(?:NODE_PATH|PROJECT_DIR|HOME_DIR)__/.test(rendered)) {
  throw new Error('plist 占位符未完整渲染');
}
fs.writeFileSync(outputPath, rendered, { mode: 0o600 });
NODE

plutil -lint "$CANDIDATE_PATH"
if [ -f "$PLIST_PATH" ]; then
  BACKUP_PATH="$PLIST_PATH.bak-$(date '+%Y%m%d-%H%M%S')"
  cp -p "$PLIST_PATH" "$BACKUP_PATH"
  echo "已备份原有 plist：$BACKUP_PATH"
fi
mv "$CANDIDATE_PATH" "$PLIST_PATH"
trap - 0 1 2 3 15

if ! confirm "plist 已写入。即将执行 launchctl bootstrap 并启动看板，是否继续？" >/dev/null; then
  echo "已保留 plist 但未启动；下次登录时可能自动启动。"
  exit 0
fi

if [ "$SERVICE_LOADED" -eq 1 ]; then
  launchctl bootout "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL"
fi
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"

ATTEMPT=0
until curl -fsS --max-time 2 "http://127.0.0.1:8765/" >/dev/null 2>&1; do
  ATTEMPT=$((ATTEMPT + 1))
  if [ "$ATTEMPT" -ge 20 ]; then
    echo "看板健康检查失败，请查看 $HOME/Library/Logs 中的代理日志。"
    exit 1
  fi
  sleep 1
done

echo "看板已通过健康检查：http://127.0.0.1:8765"
open "http://127.0.0.1:8765"
