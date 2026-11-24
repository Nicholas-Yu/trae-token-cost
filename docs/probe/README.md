# M0 数据采集探针（CDP）

Trae 的 AI 对话运行在本机渲染进程 / WebView 里。本项目的用量数据来源需要先在本机 Trae 上实测确认，探针就是这一步的取证工具。Trae 大版本升级后，如果采集失效，按本文重新跑一遍即可定位新的采集点。

## 1. 打开本机 CDP（一次性）

Trae（Electron）只能在启动时打开调试端口。项目脚本会备份并修改 `~/.trae-cn/argv.json`：

```bash
node scripts/enable-cdp.mjs --port 9222
# 输出会包含 backupPath（argv.json.bak-<时间戳>），回滚：node scripts/disable-cdp.mjs
```

然后**完全退出 Trae CN 再重新打开**（正常双击即可，参数会自动带上）。

验证端口：

```bash
curl -s http://127.0.0.1:9222/json/version
curl -s http://127.0.0.1:9222/json/list | head
```

## 2. 跑探针并操作 Trae

```bash
# 前台/后台均可；探针默认收集 600 秒
node scripts/probe-cdp.mjs --port 9222 --out probe-output --seconds 600
```

探针运行时，在 Trae 里：

1. 打开 AI 对话面板，正常发一条消息（例如「回复 OK」），等回答完成；
2. 最好再发一条会调用工具/读写文件的 Agent 消息；
3. 切换一下窗口（本机 / SSH 远程窗口各一次），观察 target 列表。

## 3. 产物（`probe-output/`）

| 文件 | 内容 |
| --- | --- |
| `targets.json` | `/json/version` + `/json/list` 原始结果（窗口/WebView 目标） |
| `browser-targets.json` | 浏览器级 `Target.getTargets` 结果（兜底 WebView/iframe） |
| `scripts/source-*.js` | 命中 `reportTokenUsage` 的聊天脚本文本（离线分析用） |
| `scripts.json`（events 内） | scriptParsed / script-hit / breakpoint-set |
| `events.ndjson` | paused（断点局部作用域）、response-body、ws-frame-interesting 等结构化事件 |
| `bodies/body-*.txt` | 网络响应体原文（`get_session_usage`、LLM/chat 响应） |
| `log.txt` / `summary.json` | 运行日志与汇总 |

## 4. 判读

- 有 `script-hit` + `breakpoint-set` + `paused`，且 `paused.local` 或 `paused.this` 里有 token 字段 → 断点通道可用（主通道）。
- 有 `response-body` 命中 `get_session_usage` 且含 `credits_float` → 实际积分可用。
- 若两者都没有：检查 `targets.json` 是否是 Trae 窗口（title 含工作区名）；再试浏览器级 target；仍不行则记录 Trae 版本，考虑 DOM 抓取/宿主机 hook 方案。

## 5. 关闭调试端口

```bash
node scripts/disable-cdp.mjs
```

**安全提示**：9222 只绑定 `127.0.0.1`，但本机任意进程都能连上（CDP 固有性质）。不要将端口转发到局域网/公网；不用时关闭调试端口。
