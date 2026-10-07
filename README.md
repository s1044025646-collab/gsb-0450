# SRTF 抢占式单核调度后端

离线、单核、最短剩余处理时间优先（SRTF）抢占调度服务。只做 API 与 CLI，不含图形界面。
使用 TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`，无原生依赖），Windows 本地直接运行，
不依赖 Docker / WSL / 任何在线服务。所有计算基于逻辑时间，不启动真实线程、不等待、不修改系统调度。

## 环境要求

- Node.js >= 22.5（使用内置 `node:sqlite`；开发环境为 Node 25）
- 仅开发依赖：TypeScript 与 `@types/node`

## 常用命令

```powershell
npm install        # 安装开发依赖
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API 服务（默认自动选择空闲端口，PORT=8080 可指定）
npm run cli -- ... # 运行 CLI（见下）
npm run demo       # 运行内置样例 A/B/C 并打印片段表与统计表
```

## 调度规则（rules_version = srtf-1）

- **事件驱动**：事件只发生在“作业到达”与“当前作业完成”两类时刻。每个事件先结算当前作业
  自上一事件以来的执行，再记录本时刻完成的作业，然后加入本时刻全部到达作业，最后重新选择。
- **选择规则**：就绪集合中剩余需求最小者运行。
- **平局规则（固定，不依赖输入顺序）**：
  1. 剩余需求相同时，已在运行的作业继续（新到作业剩余相等不抢占）；
  2. 没有可保留的当前作业时，按到达时刻升序；
  3. 再按作业 ID 的 ASCII 字典序（ID 限定 `[A-Za-z0-9_]`，避免区域排序差异）。
- 只有真正换作业才产生抢占事件；同秒到达不会制造零长度执行片段。
- 相邻同作业片段在甘特表中合并，事件流中仍保留“为什么没有抢占”的解释。
- 无可运行作业时直接跳到下一到达时刻，并记录空闲区间（`jobId = null`）。
- 无上下文切换开销。

## 统计口径

- 周转时间 = 完成时刻 − 到达时刻
- 等待时间 = 完成时刻 − 到达时刻 − 总需求（= 周转 − 需求）
- 首次响应时间 = 首次开始时刻 − 到达时刻
- 时刻归属一律**左闭右开**：完成时刻不再属于该作业；最后完成之后查询返回“无运行者”。

## CLI

```
node dist/src/cli.js import <jobs.json> [名称]   # 导入作业集
node dist/src/cli.js list                        # 列出作业集
node dist/src/cli.js preview <jobsetId>          # 预览输入（保留原输入顺序）
node dist/src/cli.js run <jobsetId>              # 执行调度（相同输入返回同一冻结运行）
node dist/src/cli.js summary <runId>             # 片段表 + 统计表
node dist/src/cli.js events <runId>              # 导出全部调度事件（含就绪快照与理由）
node dist/src/cli.js at <runId> <t>              # 查询时刻 t 的运行者
node dist/src/cli.js job <runId> <jobId>         # 单作业经历
node dist/src/cli.js demo                        # 内置样例
```

`jobs.json` 格式：`[{"id":"A","arrival":0,"burst":8}, ...]`

## HTTP API

启动：`npm start`（默认端口 0 = 自动选择空闲端口，启动日志打印实际端口；`PORT` 环境变量可指定）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/jobsets` | 导入作业集 `{name?, jobs:[{id,arrival,burst}]}` |
| GET | `/api/jobsets` | 列出作业集 |
| GET | `/api/jobsets/:id` | 预览输入（原输入顺序） |
| POST | `/api/jobsets/:id/run` | 执行调度；相同输入+规则版本返回同一冻结运行 |
| GET | `/api/runs/:id` | 片段 + 统计汇总 |
| GET | `/api/runs/:id/events` | 全部调度事件 |
| GET | `/api/runs/:id/at?t=` | 时刻 t 的运行者（左闭右开） |
| GET | `/api/runs/:id/jobs/:jobId` | 单作业经历 |

错误统一返回 `{"error":{"code","message","details"}}`。

## 错误码

| 代码 | 含义 |
| --- | --- |
| `INVALID_ID` | ID 含非 `[A-Za-z0-9_]` 字符 |
| `DUPLICATE_ID` | 作业 ID 重复 |
| `NEGATIVE_TIME` | 到达/查询时刻为负 |
| `NON_POSITIVE_BURST` | CPU 需求 <= 0 |
| `NON_INTEGER` | 数值不是整数 |
| `UNSAFE_INTEGER` | 超出安全整数或加法越界 |
| `LIMIT_EXCEEDED` | 作业数超过上限（10000） |
| `EMPTY_JOBSET` | 空作业集 |
| `NOT_FOUND` | 作业集/运行/作业/路由不存在 |
| `BAD_JSON` / `BAD_REQUEST` | 请求体非法 |

校验在任何写库之前完成，批次失败不会留下半份报告（导入与运行均在事务内）。

## 持久化与一致性

- 数据保存在项目内 `data/srtf.db`。
- 保存作业集、规则版本、运行、片段、事件、统计；修改需求必须新建作业集，产生新运行，不覆盖旧时间线。
- 同一作业集 + 同一规则版本 + 相同内容哈希 ⇒ 返回同一冻结运行（`reused: true`），重启后读取结果不变。
- 不同作业集互不影响。

## 测试与核对

`npm test` 覆盖：已知样例（A:[0,1) B:[1,2) C:[2,4) B:[4,7) A:[7,14)，完成 14/7/4，等待 6/2/0）、
相等剩余不抢占、同秒多到达、完成与到达重合、开头空闲、输入打乱结果一致、零长度片段检查、
全部错误码，以及 200 组随机小规模输入与独立逐时间单位模拟的交叉核对
（每作业执行总长 = 需求、片段不重叠、等待非负、统计口径一致）。

## 适用范围与限制

- 纯离线逻辑时间计算；不模拟 I/O、锁、多核、随机到达，无上下文切换开销。
- 单作业集上限 10000 个作业；时刻为非负安全整数，运行前检查加法不越界。
- 一次性完成完整调度，不支持实时暂停/定时器/增量结构。
- `node:sqlite` 在 Node 25 仍标记为 experimental，启动时会有实验性警告，不影响功能。
