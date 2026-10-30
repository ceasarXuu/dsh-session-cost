# dsh-session-cost（会话 API 消费）

在 **DSH 输入框下方的官方用量行里插入当前会话的 API 消费金额**，并让 **智能体团队（Agent Teams）**
面板显示每个成员的累计消费；同时保持官方 token 数与缓存命中逐字不变：

```
⟳ 3 轮 237 步 · 205 tok/s    🗄 122K tok · ¥0.003 · 缓存命中 98%    ◔ 47%
                             ↑ 官方用量胶囊，中间插入了 API 金额
```

![输入框用量行示意](docs/preview.png)

点击胶囊打开的明细弹窗保留官方原有的 token 行，并新增 **消费金额**、**价格表**（价目快照 / 最新生效
修订）和 **价目自动检查**（最近一次官方页面检查）。检查失败时金额后会出现 `!`，并弹出可关闭的全局提示。

### 智能体团队面板

开启实验性 Agent Teams bundle（`@deepseek-ai/dsh-experimental-agent-team-profile`）后，本插件会在
官方团队面板上就地补两处读数（不替换面板本身）：

- 成员卡片右侧：该成员 Session 自身产生的累计 API 消费；
- “成员 N”标题行右侧：全部成员（含 Lead）的消费合计。

每个团队成员（包括 Lead）都是独立的持久化 Session，各有自己的 `sessionCost` 投影，因此 Lead 与每个
子 agent 的金额互不重叠。通过 **fork** 创建的成员会继承 Lead 已完成的历史副本；它的卡片只显示该成员
自己产生的消费，合计中排除继承前缀，悬停时说明被排除的历史金额，避免把 Lead 早先的花费重复计入。
面板里没有打开的成员 Session 不会有实时投影帧；插件会在面板打开时以及面板保持打开期间每 15 秒请求
Session 服务刷新全部成员的投影。某成员尚无读数或币种不一致时不计入合计，合计前显示 `≈`；悬停读数
可看到精确金额与价目检查提示。该集成针对 0.2.1-rc.5 的实验性面板；没有该面板的 DSH 构建上装饰逻辑
不会生效。

> 这是第三方插件，不是 DeepSeek / DeepSeek Harness 官方组件。金额是「官方计费 token × 官方公开价格」
> 的**成本估算**，是实际账单的下限，不是官方账单。

## 安装

要求 **DSH 0.2.1-rc.2 及以上（低于 0.3.0）** 且使用 Web/Desktop 界面，Node ≥ 22。已在 DSH 0.2.1-rc.5
实际运行验证（含实验性 Agent Teams profile 的完整面板实测）；对公开的 0.2.1-rc.2 只做了 API 面静态
核对（投影 wire 视图、slot 阴影、locale 注册、会话列表投影）。

- **Plugin Manager**：Plugins → Add → 输入 `@ceasarxuu/dsh-session-cost`，安装并保持启用。
- **CLI**：`dsh plugin --profile <profile> add @ceasarxuu/dsh-session-cost`

安装后立即生效：替换输入框的官方 `usage` 胶囊，并在首次加载时执行第一次价目检查。停用 bundle 后
官方胶囊原样恢复。

## 显示内容

| 段 | 来源 |
|---|---|
| `<n> tok` | 官方 `tokenUsage` 会话投影（原样） |
| `¥0.003` / `$0.16` | 本插件：同一批计费 token 桶 × 官方价目，逐条请求计价 |
| `缓存命中 98%` | 官方缓存命中规则（原样，含“不把部分命中四舍五入成 100%”逻辑） |
| 团队卡片 `¥0.18` | 本插件：该成员 Session 自身产生的 `sessionCost` 部分 |
| 团队标题 `合计 ¥0.42` | 本插件：`agentTeam.members` 全部成员（含 Lead）自身消费之和 |

没有配置价格的模型路由（如第三方 provider）不显示金额段，弹窗显示“未配置价格”，不会瞎猜。若网关给
官方模型起了别名（例如官方 API 是 `deepseek-flash`，而路由里是 `opencode-go/deepseek-v4.1-flash`），
需要自己加一条对应价目；`*/deepseek-v4.1-flash` 可以匹配任意 provider 下该模型。

## 金额如何计算

宿主端注册 `sessionCost` 会话投影，折叠的事件与官方 `tokenUsage` 完全一致
（`assistant/message` / `assistant/attempt` 的 usage 样本、`llm/retry-started` 的替换语义），
因此金额始终对应旁边显示的 token。

- **逐样本归因模型**：`assistant/message.data.message.source`；重试 attempt 继承最近一次 `request/header` 路由。
- **逐样本峰谷价**：官方 DeepSeek 价格为峰谷制，峰时 = 谷时 × 2，峰时为北京时间工作日
  09:00–12:00、14:00–18:00（法定节假日除外）；每条样本按自己的请求开始时间选价。
- **逐样本价格修订**：价目表是带日期的历史，官方调价前发生的会话仍按当时的价。
- **整数元 nano 单位精确计算**：

  ```
  cost_nano = Σ 每条样本 ( 未命中输入×miss + 缓存读取×hit + 缓存写入×miss + 输出×output ) × 峰谷系数
  cost      = cost_nano / 1e9
  ```

  `reasoningTokens` 已包含在 `outputTokens` 内；`totalTokens` 不使用（各桶互斥）。结果是整个持久化日志
  的会话累计值，包含 fork 继承的前缀。

## 价目更新与自动检查

插件内置 **2026-10-28 官方谷时快照**（CNY、USD 两套表），并且 **最多每 7 天抓取一次**官方定价页
（`autoCheck.intervalDays`），解析采用 fail-closed：展开 rowspan 表格、校验货币符号、合理性检查、
用全部峰谷比例反证 `peakMultiplier`。规则：

- 价格未变 → 只记录检查时间；
- 价格有变 → 为变化的模型追加一条**今天（北京日期）生效**的价格修订，并重注册投影：新请求按新价，
  旧会话保持旧价；
- 抓取/解析失败，或官方峰谷倍率与 `tariffs.peakMultiplier` 不一致 → **不静默改任何数字**，改为
  在界面报告失败：金额加 `!`、弹窗显示“失败 / 建议手动核对”、右下角出现可关闭的全局提示。

峰谷时段与中国法定节假日无法从定价页解析，`tariffs.holidays` 需年度手动更新。手动工具：

```sh
node scripts/refresh-prices.mjs   # 只读：抓取中英文定价页、与配置对比、打印可直接粘贴的带日期修订块
                                  # 失败时退出码 1
```

检查状态保存在 `~/.dsh/plugin-data/session-cost/price-state.json`（可用 `config.statePath` 覆盖），
删除它即可让下次启动重新检查。

## 配置

默认值在包的 `cordis.patch.yml`；在自己的 profile `cordis.patch.yml` 里覆盖 row `session-cost`
（覆盖会替换整个 `config`，需重述所有需要的键）。HMR 会自动重组，无需重启桌面端。

| 键 | 默认 | 含义 |
|---|---|---|
| `currency` | `CNY` | 显示币种；内置 CNY / USD 两套表，不做汇率换算 |
| `prices` | 官方快照 | 每币种/模型的带日期修订：`{ from, hit, miss, output }`，每百万 token，谷时价 |
| `pricesAsOf` | `2026-10-28` | 弹窗显示的快照标签 |
| `tariffs` | 官方规则 | `peakMultiplier`、`utcOffsetMinutes`、`peakWindows`、`weekdays`、`holidays` |
| `autoCheck` | `{ enabled: true, intervalDays: 7 }` | 有界自动检查；`intervalMs` 可覆盖间隔 |
| `pricingUrls` | 官方文档 | 每币种对应的定价页 |
| `statePath` | `~/.dsh/plugin-data/session-cost/price-state.json` | 检查状态与自动修订的持久化位置 |

路由解析顺序：`provider/model` → `*/model` → 裸 `model`。

## 隐私与网络

- 最多每 7 天对 `api-docs.deepseek.com` 发一次 HTTPS GET；不发送 API key、会话内容或 prompt。
- 无任何遥测。
- 本地只保存检查时间、自动检测到的价格修订，以及 Web UI 里一个 localStorage 忽略键。
- 所有金额均由你的会话日志和价目表在本地计算。

## 已知边界

- **是成本下限，不是账单**：官方 `tokenUsage` 未记录的辅助调用（压缩摘要、会话标题、联网搜索附加模型
  调用、Search/Fetch 费用）被刻意排除。
- **价格历史从内置的 2026-10-28 快照开始**：更早的官方价格没有可靠机器可读历史，这里不伪造；从今往后
  每次检测到的调价都会以带日期的修订保留。
- **峰谷时段/节假日需手动年度更新**；若官方峰谷倍率变化，插件会检测到并提示人工核对。
- **未定价路由**（无官方价格的第三方 provider）显示 token 与 `≈`/“未配置价格”；团队成员与合计读数
  同样带这个标记。
- **fork 成员**：fork 继承的前缀不计入该成员的卡片金额与团队合计（悬停可看到被排除的继承金额）；
  单独打开该成员的会话时，输入框胶囊仍显示整段日志的累计值，因为那是按完整持久化日志定义的口径。
- **团队面板采用 DOM 就地装饰**：官方团队面板没有子 slot，插件把两个金额节点挂到面板成员区
  （`[data-team-panel]`）。若 DSH 改动该属性或人员卡片结构，需要更新插件；面板自身的成员、任务板与
  跳转行为不受影响，输入框胶囊也与本功能互不影响。
- **依赖 DSH 内部 API**：会话投影、slot 阴影、locale 注册、会话列表投影，以及团队面板的 DOM 约定；
  已用 `engines.dsh` 版本收口，DSH 升级仍可能要求插件更新。
- 初始快照之前的历史会话无法重建未知的旧价格。

## 开发

纯 JavaScript，无构建步骤，无运行时 npm 依赖。

```sh
node test/prices.test.mjs       # 33 个 fail-closed 解析/抓取测试（真实页面 fixture）
node test/host-fold.test.mjs    # 12 个宿主折叠 + fork 拆分 + 自动检查测试（离线，本地 HTTP fixture）
node test/client-team.test.mjs  # 团队合计、格式化与面板装饰测试（假 DOM，离线）
node --check index.js && node --check client.js
npm pack --dry-run             # 检查实际打包文件清单
```

## 许可

MIT，见 [LICENSE](LICENSE)。部分 UI 派生自 DeepSeek Harness（MIT），见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。English README: [README.md](README.md)。
