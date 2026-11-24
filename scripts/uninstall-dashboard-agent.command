#!/bin/sh
set -eu

PLIST_PATH="$HOME/Library/LaunchAgents/local.trae-token-cost.dashboard.plist"

confirm() {
  /usr/bin/osascript - "$1" <<'APPLESCRIPT'
on run argv
  display dialog (item 1 of argv) buttons {"取消", "继续"} default button "取消" cancel button "取消" with icon caution
end run
APPLESCRIPT
}

if ! CHOICE="$(/usr/bin/osascript <<'APPLESCRIPT'
display dialog "停止看板用户代理。仅停止会保留 plist，下次登录会自动启动；停止并删除会继续请求删除确认。" buttons {"取消", "仅停止", "停止并删除"} default button "仅停止" cancel button "取消" with icon caution
button returned of result
APPLESCRIPT
)"; then
  echo "已取消，未修改代理或文件。"
  exit 0
fi

case "$CHOICE" in
  "仅停止" | "停止并删除") ;;
  *)
    echo "无法识别选择，未执行任何操作。"
    exit 1
    ;;
esac

if launchctl print "gui/$(id -u)/local.trae-token-cost.dashboard" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/local.trae-token-cost.dashboard"
else
  echo "看板代理当前未加载，继续验证端口状态。"
fi

ATTEMPT=0
while lsof -nP -iTCP:8765 -sTCP:LISTEN >/dev/null 2>&1; do
  ATTEMPT=$((ATTEMPT + 1))
  if [ "$ATTEMPT" -ge 15 ]; then
    echo "端口 8765 仍在监听，未删除 plist；请检查占用进程。"
    exit 1
  fi
  sleep 1
done

echo "已验证端口 8765 关闭。"
case "$CHOICE" in
  "停止并删除")
    if ! confirm "确定删除 $PLIST_PATH 吗？若保留，下次登录会自动启动看板。" >/dev/null; then
      echo "已保留 plist：下次登录时会自动启动看板。"
      exit 0
    fi
    rm -f "$PLIST_PATH"
    echo "已停止看板代理并删除 plist。"
    ;;
  "仅停止")
    echo "已保留 plist：下次登录时会自动启动看板。"
    ;;
esac
