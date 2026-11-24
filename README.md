# Trae Token 费用

一款用于 **TRAE CN** 的本地 Token 用量与费用统计插件。通过 CDP 读取真实输入、输出、缓存和推理 Token，不做会话分类，不保存聊天正文。

> 非官方扩展。基于 [shaoeric/trae-token-usage](https://github.com/shaoeric/trae-token-usage) 固定版本 `1720421` 二次开发，保留 MIT License。

## English Introduction

Trae Token Cost is a local token-usage and cost-tracking extension for TRAE CN. It reads real per-call tokens (input, output, cache read/write, reasoning) through a CDP breakpoint whitelist, estimates cost per call against a built-in Bailian official price snapshot, and ships a glassmorphic web dashboard with dark/light themes, an activity heatmap, model/day drill-downs, first-response and latency metrics, and a built-in metrics explainer. A launchd agent keeps capture running in the background even when workspaces are closed. All data stays in a local SQLite database — no chat content is collected, and nothing is exposed beyond localhost.

Highlights:

- **Real token capture** — input, output, cache read/write, reasoning; no chat content stored.
- **Cost estimation** — Bailian price snapshot plus custom overrides, tiered and peak/off-peak pricing.
- **Dual-channel latency** — server-side timing for Agent/SSH sessions plus local network timestamps.
- **Glassmorphic dashboard** — G1 dark / G2 light themes, 3D refraction, red heatmap, drill-downs.
- **Resident capture** — launchd auto-start, leader election and process lock.
- **Local-first privacy** — local SQLite only, localhost-bound service, CSV/JSON export.

## 你能用它做什么

- 查看今日、近 7 日、近 30 日及全部 Token 用量。
- 查看输入、输出、缓存读取、缓存写入、推理 Token 和估算费用。
- 查看每日趋势、模型分布和逐次调用明细，导出 CSV / JSON。
- 每日柱顶显示 Token 总量，按模型分色堆叠；点击日期、模型图例或柱段可下钻 Token 成分。
- 8 周活动热力图（最近 56 天，红色主调，铺满面板的方块矩阵），点击有数据的日期可联动下钻；每日图支持 Token / 成本视图切换。
- 深色 / 浅色主题切换：深色为 visionOS 空间玻璃（G1），浅色为液态玻璃（G2），带 3D 边缘折射与指针反光；选择本地持久化，未选择时跟随系统。
- 统计首响应耗时、调用耗时、有效关联覆盖率和按总耗时计算的输出 Token/s；Agent/SSH 模式自动采用 Trae 回传的逐调用服务端计时。
- 指标说明：每个 KPI / 图表标题的 ⓘ 与工具栏「指标说明」打开分组弹窗，讲清各指标的实现原理、计算公式、关键口径（含缓存命中如何识别）与数据来源；点 ⓘ 自动定位并高亮对应指标。
- 内置 Kimi、千问、DeepSeek、GLM 共 85 个百炼国内文本模型价格；GLM 缓存命中价按官方「上下文缓存」页比例计入（北京：5.3 系列 25%、5.1/5 20%）；自定义价格可覆盖内置价格。
- 使用 launchd 常驻采集和网页看板：关闭普通工作区、只保留 Agent 也能继续统计。
- TRAE 完全退出后不再产生新用量，但历史网页仍可访问。

**费用只是按价格配置计算的本地估算，不等同于服务商最终账单。**

## 一、安装前准备

需要：

1. macOS 版 TRAE CN。
2. Node.js 22.5 或更高版本，用于独立网页和常驻服务。
3. 完整分享包 `trae-token-cost-0.3.0-share.zip`。

如果只使用 IDE 面板，可以只安装 VSIX；常驻网页和后台采集需要完整分享包。未获得分享包时，可克隆本仓库后执行 `npm ci --omit=dev` 安装运行依赖，并用 `npm run package` 生成 VSIX。

## 二、接收者快速安装

### 1. 解压并安装运行依赖

在解压后的目录执行：

```bash
cd "/path/to/trae-token-cost-0.3.0"
npm ci --omit=dev
```

这一步只安装常驻服务所需的生产依赖，不需要构建插件。

### 2. 安装 IDE 插件

方式 A：在 TRAE 扩展面板选择「从 VSIX 安装…」，选择目录中的 `trae-token-cost-0.3.0.vsix`。

方式 B：执行命令：

```bash
"/Applications/Trae CN.app/Contents/Resources/app/bin/trae-cn" \
  --install-extension "$PWD/trae-token-cost-0.3.0.vsix" --force
```

安装后重新加载 TRAE 窗口。

### 3. 开启一次 CDP 采集权限

1. 在普通工作区中打开命令面板。
2. 执行 `Trae Token 费用: 开启用量采集`。
3. 插件会备份并修改 TRAE 的 `argv.json`，写入仅绑定 `127.0.0.1` 的 CDP 端口，默认 `9333`。
4. 完全退出并重新打开 TRAE。

插件不会把 CDP 端口开放到局域网或公网。以后可使用「关闭采集」还原启动参数。

### 4. 安装常驻服务（推荐）

双击：

```text
scripts/install-dashboard-agent.command
```

按两次系统确认提示完成安装。成功后访问：

[http://127.0.0.1:8765](http://127.0.0.1:8765)

常驻服务具备以下行为：

- 登录自动启动，异常退出后由 launchd 自动恢复，无需保持 Terminal。
- 同一进程同时负责采集和只读网页，不额外启动第二套服务。
- 进程锁阻止重复执行 `--capture`；异常退出留下的死锁会自动恢复。
- IDE 与后台服务共享选主，只有 leader 采集和写库，另一方自动等待或接管。
- 重复安装只升级同标签服务，不会按端口结束其他进程。

## 三、日常使用

### IDE 面板

命令面板执行 `Trae Token 费用: 打开仪表盘`，可以刷新、切换时间范围、导出数据和查看诊断。

### 独立网页

固定地址：[http://127.0.0.1:8765](http://127.0.0.1:8765)

- 「今日」从本机当天零点开始统计。
- 网页使用独立只读连接，不会修改用量或价格设置。
- 数据库默认保留 180 天，可在设置中调整。
- 导出不包含会话、窗口、主机、内部去重哈希或接口地址。

### 图表、下钻与耗时口径

- 每日柱顶数值是该日所有模型的 Token 总量，柱内颜色表示模型成分。近 30 日等较宽图表可在图表内部横向滚动，不会撑宽页面。
- 点击柱顶日期可查看当天全部模型；点击图例可查看该模型的全部日期；点击柱段可同时按日期和模型筛选。「清除筛选」恢复汇总视图。
- 下钻表使用实际上报字段：未缓存输入、缓存读取、缓存写入、输出和推理 Token。其中推理是输出的子集，不会重复累加。
- **平均首响应**：Agent/SSH 模式生成请求不经本机渲染进程，采用断点白名单读取的 Trae 回传服务端计时 `platform_first_token_timing`（该次调用的服务端首 Token 耗时，不含客户端网络与排队）；本机可见 `/completions` POST 时为网络请求发出到收到响应头的耗时。
- **平均耗时**：优先取该次调用的服务端处理耗时 `server_processing_time`（随每次 LLM 调用更新，与 Trae 自身遥测同源）；网络通道可见时为请求发出到 `loadingFinished` 的总耗时。输出 Token/s 按有效记录的输出 Token 总量除以耗时总秒数计算，不是应用层真实解码速度。
- 网络通道只有同一会话、同一轮次且目标内存在唯一候选请求时才关联耗时；候选仅限生成接口（URL 路径以 `/completions` 结尾的 POST），用量查询等辅助接口与 OPTIONS 预检不参与，0ms 无效样本丢弃。多候选、失败请求、缺少轮次标识及历史旧记录保持空值，不补造数据；覆盖率用于判断样本完整性。
- 活动热力图覆盖最近 56 个本地日历日，与当前时间范围无关；按 2 行 × 28 列方块铺满面板（上行较早、下行较近），颜色越深用量越大，零值日不可点击。点击范围外日期会自动切到「全部」并下钻该日。
- 成本视图按「逐调用计价后汇总」的日成本绘制单系列柱，不做模型堆叠（阶梯/峰谷价按调用计，聚合后计价会错）；部分调用未定价时仅计已定价合计并在提示中说明。
- 模型分布与图例悬停显示每百万 Token 基础档单价参考；阶梯/峰谷实际按调用计价，悬停值仅供参照。

### 临时查看，不安装常驻服务

双击 `start-dashboard.command`，或执行：

```bash
npm run dashboard -- --port 8765 --no-open
```

默认只启动临时只读网页，按 `Ctrl+C` 或关闭终端即停止。

其他系统或确需前台采集时，可执行一次：

```bash
npm run dashboard -- --capture --cdp-port 9333 --no-open
```

不要重复执行该命令；已有采集进程时会直接拒绝启动，避免进程冲突。

## 四、价格与费用

分享包已内置百炼国内文本模型价格，首次安装无需复制价格配置。用户自定义配置始终优先于同名内置价格。

在 TRAE 设置中搜索 `traeTokenCost`，或编辑用户 `settings.json`：

```json
{
  "traeTokenCost.currency": "CNY",
  "traeTokenCost.statusBar.metric": "both",
  "traeTokenCost.modelPrices": {
    "provider/model": [
      {
        "effectiveFrom": "2026-01-01",
        "input": 2,
        "output": 8,
        "cacheRead": 0.2,
        "cacheWrite": 2.5
      }
    ]
  }
}
```

四个价格均表示**每百万 Token 单价**。同一模型可配置多个 `effectiveFrom` 版本。

计费口径：

```text
普通输入 = 输入 - 缓存读取 - 缓存写入
费用 =（普通输入 × input + 输出 × output
     + 缓存读取 × cacheRead + 缓存写入 × cacheWrite）/ 1,000,000
```

- 输出已包含推理 Token，不重复收费。
- 支持百炼输入阶梯、峰谷价格、思考输出价和部分缓存 TTL 价格。
- 未公开缓存命中价格时，不猜价；实际命中会标记缺价。
- 未配置模型、字段不完整或 Token 口径矛盾时，不按零费用处理。

内置价格快照来源为[阿里云百炼模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)，检索日期为 2026-11-23；GLM 缓存命中比例来源为[上下文缓存](https://help.aliyun.com/zh/model-studio/context-cache)。限时优惠、免费额度和最终扣费以控制台及账单为准。

## 五、常用设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `cdpPort` | `9333` | 本机 CDP 端口，修改后需重启 TRAE |
| `captureDebugger` | `true` | 启用 Token 断点采集 |
| `captureNetwork` | `false` | IDE 网络响应正文采集；常驻服务始终关闭 |
| `timingEnabled` | `true` | 耗时统计：断点白名单读取 Trae 回传的服务端计时，本机可见生成请求时辅以网络时间戳；不读取响应正文 |
| `pollIntervalMs` | `3000` | CDP 目标轮询间隔 |
| `retentionDays` | `180` | 本地记录保留天数 |
| `statusBar.enabled` | `true` | 是否显示状态栏 |
| `statusBar.metric` | `tokens` | `tokens` / `cost` / `both` |
| `currency` | `CNY` | 费用币种，不做汇率转换 |
| `modelPrices` | 内置百炼价格 | 用户配置覆盖同名默认价格 |
| `defaultRange` | `today` | 打开仪表盘默认时间范围（today/week/month/all） |

## 六、数据与隐私

数据默认保存在：

```text
~/Library/Application Support/Trae CN/User/globalStorage/local.trae-token-cost/
```

- 只保存调用时间、模型、Token、调用耗时（服务端/网络）、完整性、内部去重哈希和采集状态。
- 耗时统计只读取 Trae 回传的服务端计时数值与网络事件时间戳，不保存 URL、请求 ID 或响应正文。
- 不保存提示词、回答正文、工具参数、鉴权信息。
- 原始窗口标题和工作区名不落盘。
- 内部哈希仅用于去重，不进入网页或导出。
- 网页只绑定 `127.0.0.1`，禁止跨域和外部资源请求。
- 常驻服务不使用 Network 响应正文通道。

## 七、停止与卸载

### 停止或删除常驻服务

双击 `scripts/uninstall-dashboard-agent.command`，可选择：

- **仅停止**：保留 plist，下次登录仍会自动启动。
- **停止并删除**：删除常驻配置，不再自动启动。

### 关闭 CDP 权限

在 IDE 命令面板执行 `Trae Token 费用: 关闭采集`，按提示还原启动参数。

### 删除插件与历史数据

在 TRAE 扩展面板卸载插件即可。历史数据库不会随扩展自动删除；如确认不再需要，可手动删除上述 `local.trae-token-cost` 数据目录。删除前建议先导出 CSV / JSON。

## 八、常见问题

### 今日没有数据

1. 确认已执行「开启用量采集」并重启过 TRAE。
2. 确认已安装并启动常驻服务。
3. 在 Agent 中重新发起一次对话，再刷新网页。
4. 检查服务与日志：

```bash
launchctl print "gui/$(id -u)/local.trae-token-cost.dashboard"
curl "http://127.0.0.1:8765/api/dashboard?range=today"
```

日志位于：

```text
~/Library/Logs/local.trae-token-cost.dashboard.stdout.log
~/Library/Logs/local.trae-token-cost.dashboard.stderr.log
```

### 提示“独立采集服务已运行”

说明已有后台采集进程，不要重复启动。进程锁会保护现有实例；异常退出留下的死锁会在下次启动时自动恢复。

### 提示“由其他窗口采集中”

这是正常的共享选主行为，表示当前只有另一个 IDE 窗口或后台服务在写库，不是重复采集。

### 端口 8765 被占用

安装器不会结束未知进程。可先确认占用者；如果只是临时查看，可换端口：

```bash
npm run dashboard -- --port 8766
```

### 某些模型显示缺价

为该模型添加 `traeTokenCost.modelPrices`。只有明确配置价格后才能估算现金费用，Token 统计本身不受影响。

## 九、开发者验证

```bash
npm ci
npm test
npm run check
npm run package
```

发布前验证覆盖：单元测试、多进程选主与去重、进程锁、SQLite 事务、桌面和移动端网页、launchd 配置及真实 Agent-only 采集（当前 248 项测试）。

风格演示：`demos/dashboard-styles/` 内含看板风格 demo（含 G1–G4 玻璃变体），双击 `demos/start-demos.command` 后访问 http://127.0.0.1:8766/dashboard-styles/ 对比预览。

## 已知限制

- 依赖 TRAE 私有 Token 事件和脚本结构，TRAE 大版本升级后可能需要重新适配。
- 生成请求由远程 `ai-agent` 执行时（如 SSH 远程窗口或 Agent 模式），本机网络看不到该请求；耗时改用断点白名单读取的 Trae 回传服务端计时（`server_processing_time` / `platform_first_token_timing`），Token 统计不受影响。服务端口径不含客户端网络往返与工具执行间隔；Trae 未回传计时的调用保持空值，不补造。
- 仅 macOS 提供 launchd 安装器；其他系统可使用前台模式。
- 自定义模型必须触发兼容的 Token 事件并返回完整 usage。
- 不做汇率、订阅套餐或最终账单换算；严格财务对账仍需与服务商控制台核对。

## 版本历史

- **0.3.0**（2026-11-23）：深色/浅色主题切换（G1 visionOS 空间玻璃 / G2 液态玻璃，3D 边缘折射 + 指针反光，持久化并跟随系统）；活动热力图改红色主调；修复 GLM 缓存命中价缺失——按官方上下文缓存页比例补全 glm-5.3 等模型 cacheRead（北京 25%/20%），快照更新至当日官方页。
- **0.2.1**（2026-11-23）：指标说明新增「统计时间与数据保留」条目（时间基准、今日/近 7 日/近 30 日滚动口径、默认保留 180 天与清理周期、导出留存建议），范围页签旁新增 ⓘ 快捷入口。
- **0.2.0**（2026-11-23）：耗时双通道——新增 debugger-inferred 服务端计时（Agent/SSH 模式主通道，逐 LLM 调用），网络通道仅认 `/completions` POST 并丢弃 0ms 无效样本；修复 TRAE 内置预览浏览器注入全局与页面脚本冲突（IIFE 隔离）；指标说明与文档同步更新。
- **0.1.0**：首版——CDP 断点/网络/账单三通道采集、SQLite 去重合并、价格版本计费、网页看板与 launchd 常驻、活动热力图与下钻、指标说明弹窗。

## License

MIT，见 [LICENSE](LICENSE)。
