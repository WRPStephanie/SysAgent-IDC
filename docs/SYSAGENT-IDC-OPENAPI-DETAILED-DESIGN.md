# SysAgent 管家：本地采集、宿主协调与 OpenAPI 详细设计

## 阅读入口

本文说明实际实现中的职责、协议、计算口径、安全边界与运行限制，不把可选来源或未实现能力视为完整支持。查询客户端的路径、17 个数据集、字段、分页、错误与凭证示例见[本机查询 API](./LOCAL-HTTP-API.md)。

首次使用的顺序：启动桌面／IDE 宿主 → 核对系统 sysAK 与来源状态 → 获取资源或运行所需诊断 → 查看采样时间、覆盖和未知项 → 查询或导出已有报告。公开查询不会帮助客户端自动补采。

目录：

1. [目标与功能边界](#1-目标与功能边界)
2. [架构与职责](#2-架构与职责)
3. [系统 sysAK 采集](#3-系统-sysak-采集)
4. [数据模型与状态语义](#4-数据模型与状态语义)
5. [资源计算与证据边界](#5-资源计算与证据边界)
6. [体检与评分](#6-体检与评分)
7. [宿主 IPC 与开发网页](#7-宿主-ipc-与开发网页)
8. [内部 OpenAPI](#8-内部-openapi)
9. [状态机、调度与一致性](#9-状态机调度与一致性)
10. [受控进程操作](#10-受控进程操作)
11. [AgentSight 与 root 控制](#11-agentsight-与-root-控制)
12. [Qoder Hook 与独立累计](#12-qoder-hook-与独立累计)
13. [Agent 页面与报告](#13-agent-页面与报告)
14. [云端巡检](#14-云端巡检)
15. [公共查询、安全与生命周期](#15-公共查询安全与生命周期)
16. [构建、交付与源码导航](#16-构建交付与源码导航)
17. [实现限制](#17-实现限制)

## 1. 目标与功能边界

采集层获取有界系统证据，解析层计算资源与本地规则，展示层呈现结果和用户交互。云端巡检、AgentSight 与 Hook 是各自有来源和时间范围的链路，不以页面聚合掩盖来源差异。

| 功能 | 实际行为 | 不提供的能力 |
| --- | --- | --- |
| 资源与体检 | 当前用户调用系统 `sysak idc_inspect`，解析 schema `1.1` 证据 | root 资源采集、任意命令、全进程历史库 |
| GPU | 卡级遥测与短窗口专项检查／job 分析 | 连续历史、任意离线样例冒充实测 |
| 进程处置 | 普通用户、PID+starttime、二次确认、pidfd SIGTERM | root／异用户目标、数字 PID 信号回退、目标 SIGKILL、文件／Session 清理 |
| AgentSight | 独立进程、Session、中断、延迟与已存记录汇总 | 对话正文、完整业务健康证明、Session 独占资源 |
| Qoder Hook | 生命周期白名单元数据、窗口明细与 SQLite 独立累计 | 正文、工具输入输出、Token 测量、跨来源身份合并 |
| 公共 HTTP | 回环、认证、cache-only GET | 内部解析 POST、配置、采集、终止、上传、轮询 |
| 云端巡检 | sysAK 上传与触发分析，宿主只读轮询取报告 | 任意远端执行、持久云报告历史库 |
| 优化与修复 | 显示已有证据与说明，业务写操作拒绝 | 自动修复、重启恢复、清 Session、删除文件、真实 FD 回收 |

运行标识 `SysOMOpenAPI`、`sysom-openapi`、`window.sysomDesktop`、`SYSOM_*`、`sysom://` 和 systemd／socket 路径是实际代码标识，保持原样。`mode:"mock"` 是本机部署标签，不证明指标为模拟；`mode:"pre"` 是控制器的云端模式。实际资源解析返回 `state.mode:"collected"`、任务 `simulated:false`；独立离线 Demo 不作为本机证据。

`read_only:true` 表达采集证据及通用业务写接口的边界，不能据此断言整个应用没有执行能力：受信 UI 有专用进程确认接口，云端模式有上传；二者都不由公共 GET 驱动。

## 2. 架构与职责

```text
桌面受信页面 ── preload / Electron IPC ──┐
IDE Webview ── 扩展宿主 RPC ────────────┤
开发／预览页面 ── /api/idc ─────────────┤
                                       ▼
                              普通权限 IDC 控制器
                               │      │      │
           当前用户系统 sysAK ─┘      │      └─ AgentSight 元数据 + Hook
             idc_inspect               │                 │
                │                      ▼                 ▼
                └───────────── 内部 /openapi/v1 本地解析
                                       │
                              资源／Agent／任务缓存
                                       │
                     公共 /api/v1：独立认证、仅查询副本

AgentSight 采集控制：普通宿主 → 固定 Unix socket → root runner → 固定控制脚本
云端巡检：sysAK 上传／触发分析 → 云端 → 宿主只读轮询 → 内存云报告视图
```

- `idc-controller.cjs`：系统采集器定位、串行队列、缓存、巡检调度、取消、内部提交、进程确认与云端视图。
- `openapi-service.ts`：认证后的原始证据校验、本地规则分析、revision 原子提交、幂等结果和有界任务表；服务函数名 `startMockOpenApi` 不代表返回模拟证据。
- `collected-state.ts`：系统段解析、资源口径、功率归因与体检结果。
- `agentsight-client.cjs`：本机白名单元数据请求、独立历史汇总与 AgentSight 服务控制。
- `agent-hooks.cjs`、Hook Python 运行时：合法元数据 spool、独立累计与有界读取。
- `local-query-api.cjs`／`query-data.cjs`：公共查询生命周期、认证、规范路径、白名单数据集与契约。
- 桌面／IDE 共用资源和 Agent 视图。渲染器与 Webview 不获得内部 Bearer、root 凭证或任意宿主执行入口。

没有通用 SQLite 任务、快照、重试队列或云报告历史库；这些数据为内存。Hook `history.sqlite3` 是独立持久累计，不能与任务缓存混为一谈。

## 3. 系统 sysAK 采集

### 3.1 定位与启动前检查

资源与进程操作由当前用户直接 spawn **系统已安装**的 sysAK，不经 `sysom-idc.service`。主 deb 不安装系统 sysAK，应用 bundle 不替代系统资源采集依赖。

定位规则：

1. 控制器显式 `sysakBinary` 优先于 `SYSOM_SYSAK_BIN`；存在覆盖时只检查该候选，失败不自动回退。
2. 没有覆盖时依次查 `/usr/bin/sysak`、`/usr/local/bin/sysak`、`PATH` 各目录。
3. 二进制须为可执行常规文件。组件目录先取二进制 realpath 同目录的 `.sysak_components/`，该目录不存在才使用 `/usr/local/sysak/.sysak_components/`。
4. 启动前要求可读 `tools/idc_inspect` 与 `tools/.sysak.rules`，规则须匹配 `idc_inspect` 命令；缺失即拒绝，以拦截 sysAK 启动器的联网组件下载。

错误为 `UNSUPPORTED_PLATFORM`、`SYSAK_NOT_FOUND`、`SYSAK_COMPONENT_MISSING`。`status.collector.source` 区分 `system/override`，同时报告 binary、command、schema 和可取得的采集器 version。此检查不等于对用户所选系统二进制施加 root bundle 的信任策略；进程权限始终是当前用户。

### 3.2 固定命令与环境

```text
sysak idc_inspect --request-id <uuid> -o -
```

`collection.profile:"inspection"`，schema `1.1`。`snapshot/reset/inspect` 都使用同一采集命令；operation 决定解析行为，不改变 collector argv。不运行顶层 `resource_anomaly` 或 `memgraph` 作为主资源／体检路径，不进行目录占用扫描。

spawn 设置 `cwd=dirname(binary)`、`shell:false`、`detached:true`、stdin 忽略。基线环境仅 `PATH`、`LANG=C.UTF-8`、`PYTHONDONTWRITEBYTECODE=1`；云端模式按第 14 节白名单传递必要 `SYSOM_*`，不继承无关凭据。

### 3.3 限额、取消与 JSON 提取

- 外层采集期限 45 秒；采集器内部预算 24 秒、硬超时 30 秒，留出回收余量。
- stdout 流式限额 8 MiB；超限返回 `COLLECTION_TOO_LARGE`。stderr 持续排空，仅保留有界诊断前缀用于上传失败说明，不作为公共 raw 数据导出。
- 取消／超时向自有采集进程组发 TERM，最多 1 秒后对未结束的自有采集组发 KILL。此处是采集子进程回收，不是对业务清理目标发送 KILL。
- 非零退出为 `COLLECTION_FAILED`，无法启动为 `COLLECTOR_UNAVAILABLE`，超时为 `COLLECTION_TIMEOUT`，取消为 `COLLECTION_CANCELLED`。
- 启动器可能混入 stdout 诊断；`collectionJson()` 从首个 `{` 扫描字符串、转义与嵌套，提取首个完整 JSON 对象，不把 stdout 整体直接当 JSON，也不搜索多个对象择优拼接。

控制器验证 schema、request_id、collector name／command、profile、完成时间、`host/device`、`capabilities.read_only:true` 和 `cpu/memory/disk/fd` 对象段，只接受 `collection.status:ok/partial`。不合法为 `INVALID_COLLECTION`；内部解析服务能识别整体 `failed` 并拒绝，不将失败样本提交为健康快照。

云端模式允许上传成功的 32 位十六进制巡检 ID，内部 envelope 必须与 raw 中实际 request_id 完全一致。

## 4. 数据模型与状态语义

### 4.1 原始采集证据

schema `1.1` 的主要证据在 `raw.sections`；各段 `status/reason` 与业务字段同级，不使用通用 `content` 包装。`collection.sections` 是逐段摘要，`status.collection` 公开 command、version、时间、duration 和 `{name,status,reason}` 列表。

常用段为 `cpu/memory/disk/process/io/fd/energy/gpu/log`，专项证据位于 `diagnostics.ai`。核心段存在不表示字段完整：段权限受限、截断、工具缺失和超时必须由该段状态与原因表达。

### 4.2 展示状态

`HealthState` 主要包含 `mode/revision/sampledAt/hasGpu/resources/inspections/optimizations/operations` 与可选 `gpuDiagnostic`。

| 模型 | 关键字段与语义 |
| --- | --- |
| Resource | `id/label/usage/capacity/unit/source/status/note/sampledAt/quantity/rows`；五类资源 `cpu/energy/memory/disk/gpu` |
| ResourceRow | `id/name/detail/usage/cleanable/defaultSelected/effect`，可附 `quantity/pid/starttime/agentKind/powerSource/referenceWatts` |
| Quantity | 资源总量单位 `B/W`；行单位 `B/B/s/W/count`，不能把各资源行单位混加 |
| Inspection | `id/label/important/phase/status/usage/detail/evidence`，可附 `execution` |
| GPU | 资源 `gpuDevices` 与独立 `gpuDiagnostic/jobAnalysis`，分别保留来源、时间和覆盖 |
| Task | 内部完成任务与控制器成功任务元数据；任务 ID 不等于 request_id 或云端 inspectionId |
| AgentDiagnostic | `source:"agentsight"`、`analyzer:"sysom-openapi"`，独立窗口、totals、coverage、findings、hooks 与 history |

资源状态为 `available/partial/unavailable`，无可信百分比为 `usage:null`。检查结论为 `normal/abnormal/unchecked`，执行覆盖为 `complete/partial/unavailable`；结论与覆盖分离，部分证据可以确认异常，但不能证明完整正常。

`null` 是未知，不转成 0；缺字段与明确 null 的语义不同。合法遥测 0、零记录和真正不存在的硬件须有来源支持。名称白名单仅作 Agent 启发式标签，不建立可信 Session 归属。

## 5. 资源计算与证据边界

### 5.1 CPU

总体使用率取采集器配对 `/proc/stat` 的 `cpu.total.usage_pct`：busy 排除 idle 和 iowait，guest 不重复计入。使用总体统计而非进程排行榜之和。

进程取 `process.top_cpu` 的 `cpu_pct_node`，有效范围 0–100，表示相对可见机器总体的 CPU 份额，不再除逻辑核数。整体 Top20 与 Agent Top20 去重，单资源最多约 40 行；名字不是身份，进程行使用 PID+starttime。

### 5.2 内存

`total_kb/available_kb` 转字节：

```text
totalBytes = total_kb × 1024
availableBytes = available_kb × 1024
usedBytes = totalBytes − availableBytes
usage = usedBytes / totalBytes × 100
```

不能用 MemFree 替代 MemAvailable。进程行取 `top_rss.rss_kb × 1024`，份额为 RSS／机器 total；共享页可重复，因此排行 RSS 之和不是可释放内存。体检内存使用同源总量，PSI 可作辅助压力证据，不以 memgraph 作为主检查实现。

### 5.3 磁盘容量与 I/O 行

根挂载来自 `sections.disk.mounts` 中 `target:'/'`：显示总量 `size_bytes`、可用量 `avail_bytes`，展示已用量为 `size_bytes - avail_bytes`，占比以此除总量。此为可用容量口径，不能替换成另一空闲块公式或目录扫描结果。

进程排行来自 `sections.io.by_disk.disk_bytes_per_sec`；`by_vfs.vfs_bytes_per_sec` 只补没有 disk 行的 PID，包含页缓存层活动。行单位 B/s，既不是文件／目录占用，也不证明结束进程会释放磁盘空间。总体磁盘容量不能由这些速率行求和。

### 5.4 GPU 与专项 job

资源段使用一次 SMI 结果，最多 32 卡，总体利用率取已知卡中的最高值；逐卡保留 name、uuid、busId、利用率、显存、温度、功率、功率上限、ECC 和 PCIe。`N/A`、不可读或非法值不补零，空 NVIDIA 返回不证明所有类型 GPU 不存在。

`diagnostics.ai.native` 可提供原生／NVML 专项指标，但并不总有稳定 UUID／BDF。解析器不依据相同 index 或空 busId 拼接原生与 SMI 身份；原生设备视图可替换设备列表，不能声称已经建立跨来源卡身份。

job 分析窗口最多 10 秒，最多 128 个进程，每项最多 32 GPU indices，PID 去重。starttime 可空；空时身份未经核实，查询 ID 只属于该快照。`status/complete/reason/sampleWindowSeconds` 与总体 outcome 分开保留，不把未运行或不完整窗口当健康。

### 5.5 CPU／GPU 功率模型

`energy` 是功率而非能量积分：`usage:null`、资源 quantity 为 W，不参与百分比阈值。

CPU 优先 `sections.energy` 中有效 RAPL package 行，最多 32 个 zone，使用能量差／实际单调时间差。没有有效行才采用 CPU 模型：

```text
CPU reference = 环境校准，或 5 W × 可见逻辑 cpu_count
cpuWatts = CPU reference × CPU busy% / 100
```

cpu_count 须为正安全整数且不超过 20000。模型不是硬件 TDP，不含空闲基线。

GPU 逐卡优先有效 `powerWatts`，实际 0 也有效；否则：

```text
GPU reference = 环境校准 → 有效正 powerLimitWatts → 150 W
GPU watts = 核心利用率 / 100 × GPU reference
```

不覆写传感器字段，不用显存利用率补缺，不以最高卡利用率估算全部卡。参考值校准为：

- `SYSAGENT_CPU_FULL_LOAD_WATTS`：整个可见 CPU 的参考值。
- `SYSAGENT_GPU_FULL_LOAD_WATTS`：每张 GPU 的参考值。

两者 trim 后仅接受无符号十进制形式、有限且 `0 < W <= 100000`，无效值忽略，在分析宿主环境设置。本文不要求读取用户配置或凭据。

`power` 保留 `method:measured/estimated/mixed/unavailable`、可空 `cpuWatts/gpuWatts`、`missing`、`processes/unattributedCpuWatts`；组件行 `powerSource:rapl/gpu-sensor/cpu-model/gpu-model`，模型可附 `referenceWatts`。仅相加已知分量，覆盖不全标记 partial；没有 GPU 的判断须结合完整硬件枚举／原生 no_gpu，缺遥测不等于零。

### 5.6 CPU 进程功率估算

仅当以下条件同时满足才分摊：

1. CPU／process 段可用，两个采样窗口为正。
2. 窗口差不超过 `max(2 ms, CPU 窗口 × 1%)`。
3. CPU 功率已知，原始整体 busy% 有效且不超过 100。
4. 所有有效 top_cpu 占比之和不超过整体 busy%。
5. busy% 为正，或 busy% 与 cpuWatts 同为零。

```text
processWatts = cpuWatts × raw cpu_pct_node / raw overall busy%
unattributedCpuWatts = max(0, cpuWatts − 已归因进程功率之和)
```

busy 与功率同为零时估算为 0；条件不符时不分摊。CPU 功率未知则未归因也为 null。`power.processes` 映射有界 CPU 行，仅分摊 CPU，不分摊 GPU；`energy.rows` 本身为组件行。

未归因量独立保留，不强行分给 GPU 或 Session。共享 Qoder／MCP／renderer 不能证明 Session 独占。CPU／GPU 窗口不必同时，RAPL package 可能与集成 GPU 重叠；组件小计不含 RAM／磁盘／显示器／PSU／云端推理，不是认证整机总功率。重复 GET／UI 读取不采新样本，没有 Wh／kWh 积分。

## 6. 体检与评分

### 6.1 检查证据

资源刷新不依据最新资源百分比重算独立检查结论；`inspect` 才解析对应诊断，检查证据保留各自采样时间。

| 检查 | 当前证据与规则 |
| --- | --- |
| 根目录 | disk 根挂载总量／可用量，占比严格大于 90% 为异常 |
| 内存 | total／available，严格大于 90% 为异常，PSI 辅助；不调用 memgraph 主诊断 |
| FD | fd 系统 allocated／max 与 top_procs 的有效 fd_count／fd_limit；完整性单独验证 |
| 日志 | log 段 dmesg 关键事件与读取覆盖；无权限／部分读取不推定正常 |
| GPU | lost_card_num、xid_count、ecc_uncorr 和原生 AI 专项结果 |
| Agent／网络／I/O 健康项 | 仍有未检查项，独立 AgentSight 报告不自动填充它们 |

FD 的 allocated 已是有效计数，不再次减 unused。PID 与计数须为安全整数、进程 PID 唯一，fd_limit 为正；usage_pct 须与 fd_count／limit 的两位数结果一致，允许 limit 降低后占比超过 100%。

FD 完整条件为段 status ok、系统指标有效、`scanned:true`、denied 为 0 且未截断。部分扫描没有合法 >90% 异常时为 unchecked／usage null；部分扫描已知异常可以保留 abnormal，但 execution 仍 partial。段缺失不伪造已尝试执行。

日志重点事件为 `hung_task/soft_lockup/hard_lockup/rcu_stall/fs_error/io_error/oom/nfs_hang/gpu_xid`。可读且 status ok、无关键命中可判 normal；部分证据无命中为 unchecked，日志 usage 始终 null。GPU XID 的不可读值（如 -1）不转为零，原生 AI 可覆盖专项 GPU 检查结论。

实际 collected state 返回八项检查、五类资源和空 `optimizations`；有异常不等于具备自动优化执行方案。

### 6.2 本地分数

规则由共享 `src/health-data.ts` 执行：

```text
n = 重要检查数量
m = 其他检查数量 + 已知有限资源百分比数量
x = 已检查、usage 非空且 >90% 的重要检查数量
y = 其他异常检查数量 + >90% 的已知资源百分比数量
score = clamp(100 − x × (n ? 80/n : 0) − y × (m ? 20/m : 0), 0, 100)
```

energy 的百分比为 null，不参与资源占比评分。分数保留 `n/m/x/y/unchecked`，摘要提供 `checked/total/unavailable`。算法不是完整观察概率，重要项未检查仍须明确展示未知；高分不能证明未检查项正常。

颜色区间为 `<60`、`60–<80`、`80–<90`、`>=90`。全部没有评分证据时显示“暂无可用评分证据”；高分且存在未知时标注“仅已知项评分，未知不代表正常”。云端报告严重度来自后端，不能与本机分数互相替代。

## 7. 宿主 IPC 与开发网页

### 7.1 桌面内部接口

preload 暴露固定方法，经主进程受信 sender 检查后调用控制器：

| IPC | 控制器用途 |
| --- | --- |
| `health:snapshot` | `snapshot(refresh)`，普通读取可复用缓存，refresh 才采样 |
| `agent:diagnostic` | `agentSnapshot(refresh)`，独立 Agent 诊断 |
| `health:reset` | `reset(parameters)`，重新采样并清分析／操作状态 |
| `health:operation` | `operation(payload)`，当前只允许 inspect |
| `process:prepare-cleanup` | 选择、身份复查与确认计划 |
| `process:execute-cleanup` | 一次性确认后的 SIGTERM |
| `collector:status` | 状态读取 |
| `collector:enabled` | 启停、取消和重新调度 |
| `collector:interval` | 设置 1–1440 整数分钟巡检周期 |

IDE 经扩展宿主消息桥复用控制器，不让 Webview 获得 Node／任意 shell 能力。内部回复以结构化结果或错误呈现，页面不把失败包装为成功。

### 7.2 开发／预览网页

`demo-api.ts` 在 Vite 开发和 preview 挂载真实控制器 `/api/idc`，名称不代表隔离模拟环境；配置云端环境后能够真实上传。

GET 路由为 `snapshot/agent-diagnostic/status`；POST 为 `reset/operations/enabled/interval/process-prepare/process-execute`。snapshot 与 agent-diagnostic 可用 `refresh=true/false`。POST 要求 application/json，体积上限 8192 字节；校验回环 Host 与同源 Origin。

该开发通道可能触发采样／内部执行，**不是**公共 cache-only 查询协议。不得把公共 `/api/v1` 的“任何 GET 都不采样”推广到开发 `/api/idc/snapshot`。

## 8. 内部 OpenAPI

### 8.1 契约与路径

内部服务只绑定回环随机端口、独立 Bearer，拒绝浏览器 Origin。OpenAPI 规范为 `3.1.0`，内部契约 `info.version:"1.3.0"`；资源信封 schema `1.1`，Agent 信封 schema `1.0`。控制器云端 mode pre 不改变此服务响应的 mode mock。

| 方法与路径 | 行为 |
| --- | --- |
| `POST /openapi/v1/collections` | 校验并同步解析资源证据，提交设备快照 |
| `POST /openapi/v1/agent-diagnostics` | 独立分析 Agent 元数据，不修改资源 revision |
| `GET /openapi/v1/devices/{device_id}/snapshot` | 当前设备解析结果，不采集 |
| `GET /openapi/v1/tasks/{task_id}` | 已保留的完成任务，不是异步任务轮询状态机 |
| `GET /openapi/v1/capabilities` | 固定采集与诊断能力、执行和限额 |
| `GET /openapi/v1/openapi.json` | 内部机器可读契约 |

### 8.2 资源提交与操作语义

请求严格字段为：

```text
{schema_version:"1.1", request_id, device_id, operation, parameters, raw_snapshot}
```

request_id 为合法 UUID 或 32 位十六进制巡检 ID，device_id 为 UUID。raw request_id 与 envelope 字符串必须完全相同；大小写不敏感查表不能替代严格 raw 身份校验。parameters 允许 revision 与布尔 hasGpu，hasGpu 只是兼容提示，不覆盖硬件证据。

| operation | revision 与结果 |
| --- | --- |
| snapshot | revision 可省；提供时须匹配。重新解析资源，保留已有独立检查及时间 |
| reset | revision 可省；提供时须匹配。重新解析并清检查／操作，不把 revision 归零 |
| inspect | 要求正整数当前 revision，解析检查并推进 revision |
| cleanup／optimize／sessions-cleanup／alert-sample | 先校验 revision，再 `409 read_only`；不解析 raw、不建任务、不修改 state |

成功响应为 `{schema_version,request_id,task_id,mode:"mock",read_only:true,state,receipt,task}`。state 为 collected；task 为 `{id,status:"completed",operation,simulated:false,read_only:true}`。receipt 描述已接收采集来源、字节数、profile、时间和覆盖，不包含执行授权。

Agent 请求严格为 `{schema_version:"1.0",request_id,device_id,raw_snapshot}`，没有 operation／parameters；响应为同类信封加 `report`，任务 operation 为 `agent-diagnose`。它无需健康快照／revision，不分配或推进资源设备状态。

### 8.3 限额与校验顺序

- 未压缩 JSON 请求上限 10 MiB，严格 media type／UTF-8／JSON；raw_snapshot 原始 JSON 值字节预算 8 MiB，不能仅以反序列化再压缩的体积检查。
- 服务请求／请求头期限 30 秒，最多 32 个资源设备。
- 控制器内部提交期限 30 秒；资源响应读完后检查 1 MiB，并非资源响应流式硬上限。Agent 响应按流式累计检查 1 MiB。
- 成功 request 结果与任务共保留最多 100 份，FIFO 淘汰；没有一般异步 queued／running／持久恢复状态。

顺序为认证 → Origin／路由／方法 → media／UTF-8／体积／JSON → 幂等检查 → envelope → revision → 业务写拒绝 → raw 证据 → 规则解析 → 原子提交。revision 校验与内存提交之间没有 await，避免同事件循环并发请求交错覆盖。设备容量超限为 `503 device_capacity`，无效证据不提交任何快照或成功任务。

### 8.4 幂等与错误

同 request_id、同路由、**完全相同 UTF-8 请求字节**命中缓存时返回原结果，不推进 revision，也不把该结果再设为 latest。相同 ID 的不同字节或路由为 `409 idempotency_conflict`；空白差异也算不同。request ID 查表大小写不敏感，raw 字符串仍严格匹配。

幂等只对仍保留的成功结果有效；FIFO 淘汰后任务查询为 404，同 ID 不具备永久 exactly-once 保证。控制器每次采样生成请求身份，没有持久 replay 队列或离线重投设计。

内部错误信封为 `{schema_version,request_id?,error:{code,message,retryable}}`。认证 401，Origin 403，路由 404，方法 405，坏参数／证据 400，体积 413，媒体类型 415，revision／幂等／写拒绝 409，容量或服务不可用 503。内部错误码与公共查询的大写错误码不是同一套协议。

## 9. 状态机、调度与一致性

### 9.1 控制器状态

```text
定位成功 → idle → collecting → submitting → idle
定位／采集／解析失败 → error
暂停／关闭 → disabled
```

`installed` 表示系统 sysAK 启动前检查成功，不证明所有段可读；`enabled` 表示宿主允许采样。last_task 记录成功任务，error 记录失败；失败保留已缓存结果并展示未更新状态。

资源操作、进程准备／执行和 Agent 诊断共享串行 Promise 队列。相同待处理 snapshot 或 Agent 请求合并等待，不并行堆积采样；公共 GET 不进入执行队列。

### 9.2 周期巡检

默认 5 分钟，接受 1–1440 整数分钟。周期从任务收尾后调度，不按固定墙钟重叠执行；无初始缓存先 snapshot，再 inspect。automaticPending 和调度世代防止重复排队与暂停后的定时回调生效。

启停是宿主控制，不是公共 API；停用取消资源、Agent 和云端轮询，清确认计划并保留缓存。重新启用重新调度，不能宣称停用时仍在产生新证据。周期设置可由宿主保存为单项私有设置，但不等于持久任务／快照库。

### 9.3 revision、时间与缓存

解析资源通常为 previous revision + 1。首次 snapshot／reset 为 1；直接无前置资源的 inspect 解析路径可得到 2，控制器正常 inspect 流程先初始化。reset 清分析状态而不重置版本计数。

资源刷新保留独立检查；Agent 刷新不推进资源 revision。Agent 缓存复用期限为 60 秒；内部 refresh 可 ensure 服务、取元数据、导入 Hook 历史并提交分析，公共 GET 始终只读缓存。

成功资源提交后，控制器复查进程资格，再替换 state、collection summary 和成功任务记录；查询得到 structuredClone 副本。一个快照读的是同一宿主缓存时点，但不是 CPU／GPU／Hook／AgentSight 的共同采样时间线。

任务最多 100 条、操作最多 30 条；控制器最近任务列表与内部成功 request FIFO 是相关但独立的有界内存集合，不能当持久审计日志。导出健康文本使用 Top10，JSON 保留完整有界缓存，不临时补采。

## 10. 受控进程操作

### 10.1 命令与身份

```text
sysak idc_inspect --process-action check
sysak idc_inspect --process-action terminate
stdin: {manager_pid, targets:[{pid,starttime}]}
```

当前用户直接执行，`shell:false`，环境仅 PATH／LANG／no-bytecode；回复 schema `1.0`，15 秒期限、64 KiB stdout，stderr 不作为结果保存。逐项校验返回数量、顺序、PID、starttime、status 与 eligible 一致，不接受只成功一部分却伪造完整回复。

check 状态为 `eligible/protected/permission_denied/stale/gone/unsupported`；terminate 对应 `signalled/protected/permission_denied/stale/gone/unsupported`。root／异用户目标拒绝，身份或安全条件不可核实时拒绝。pidfd 绑定实际进程对象，用 SIGTERM；没有数字 PID 信号回退，不对目标 SIGKILL。

需要系统 Python 和内核具备 pidfd_open／pidfd_send_signal 能力，通常 Python 3.9+ 与 Linux 5.3+，发行版回移须以实际能力为准。Hook Python 3.6 最低要求不表示进程处置也只需 3.6。

### 10.2 准备与确认计划

采样后先把所有行 cleanable／defaultSelected 置 false；控制器按 raw 的 CPU／RSS／系统 CPU／块 I/O 等排行、I/O 与 FD 中有效 PID+starttime 建身份表，批量 check。只有 eligible 行可供选择，不根据名称猜身份。

`prepareProcessCleanup({resource,ids,revision})`：

1. 要求 enabled、installed、有 snapshot 且未 closed。
2. resource 只接受 `cpu/energy/memory/disk`；energy 候选为 `power.processes`，不是组件行。
3. ids 为 1–10 个唯一字符串，整数 revision 与缓存一致。
4. 行须 cleanable 且有 raw 身份表，重新 check 后全部 eligible 才可继续。
5. 生成 32 字节随机值的 64 位小写十六进制 token，TTL 60 秒，绑定 revision、targets 与显示进程；内存只保留一份计划。

成功返回 `{token,revision,expires_at,processes}`，UI 展示“结束整个进程（SIGTERM），可能中断任务”，不展示保证可释放量。新有效 prepare、采样资格标注、启停使计划失效。

### 10.3 执行与结果未知

`executeProcessCleanup({token})` 匹配当前计划后**先消费 token**，再校验 TTL 与 revision；失败不恢复计划。发送前关闭对应行 cleanable。执行成功记有界内存操作，返回 `{revision,results,refresh_required:true}`，不扣资源 usage，不推进资源 revision。

UI 必须重新整体采样核对，不用排行删行或百分比减法假装释放。`signalled` 只说明信号已送达，未证明 exited、任务完成、FD 释放或内存回收。回复不完整为 `PROCESS_RESULT_UNKNOWN`，先刷新，不自动重复 terminate。

| HTTP／宿主错误状态 | 代码 |
| --- | --- |
| 400 | `INVALID_PARAMETERS` |
| 409 | `COLLECTOR_DISABLED/SNAPSHOT_REQUIRED/STALE_SNAPSHOT/PROTECTED_PROCESS/INVALID_CLEANUP_PLAN/EXPIRED_CLEANUP_PLAN` |
| 503 | `PROCESS_CONTROL_UNAVAILABLE/PROCESS_RESULT_UNKNOWN`，以及系统采集器不可用错误 |

此协议只在内部受信宿主动作通道可用；公共 HTTP GET 和内部 collections 通用 cleanup 都不执行它。

## 11. AgentSight 与 root 控制

### 11.1 固定元数据来源

AgentSight 是独立本机服务，客户端 URL 限制为本机允许端点，不代理任意路径；每项 5 秒、2 MiB 流式限额，拒绝重定向。可通过 `SYSOM_AGENTSIGHT_URL`／`SYSOM_AGENTSIGHT_TOKEN` 指定连接环境，仅说明变量，不需要查看真实值。

固定近 24 小时来源：

| coverage key | 请求 |
| --- | --- |
| processes | `/api/agent-process-health?include_clients=true` |
| sessions | `/api/sessions`，固定时间窗、`include_auxiliary=true` |
| interruptions | `/api/interruptions`，固定时间窗、`resolved=false&limit=200` |
| interruptionCounts | `/api/interruptions/count`，固定时间窗 |
| latency | `/api/metrics/latency`，固定时间窗 |

投影最多 256 进程、500 Session、200 未解决中断、256 延迟项。只选元数据，不取对话正文；process 无 starttime，不能作为稳定 OS 身份。来源状态独立为 available／unavailable／invalid／truncated；缺数值不补 0，事件明细数量不替代上游全窗 count。

### 11.2 已存记录汇总

`agent.history` 的 scope 为 `all_stored`，独立于近 24 小时明细。usage 来自 `/metrics` 的权威累计指标，Session／中断 count 通过覆盖已存时间范围的有界请求读取；不会依赖明细的 500 条投影重算全量。

指标严格校验 HELP／TYPE／counter、唯一 Agent 标签与安全整数，缓存 Token 不重复相加。来源截断／缺失表示未知；“已存记录”不等于从未遗漏的全生命周期事实，也不等于 SysAgent 自己持久存储了这些元数据。

### 11.3 root 采集控制协议

`sysom-idc.service` 只负责 AgentSight 采集控制，不采资源、不 check／terminate 业务进程。普通宿主经 `/run/sysom-idc/idc.sock` 请求固定服务，不能执行用户可写代码为 root，也不提供任意 sudo／pkexec／shell 通道。

客户端发送兼容 args：`['idc','--agent-collection','status|ensure|disable']`。**`idc_inspect` 不支持该参数**。runner 对此严格白名单请求映射为可信 `/usr/bin/python3 -I <固定 AgentSight 控制脚本> <action>`，而不是据此保证系统 `sysak idc` 命令可用。可用性仍取决于可信安装、授权、脚本、内核／eBPF 能力和实际 collection 状态；API 可连接也不证明 trace 采集已运行。

每连接一个 UTF-8 JSON 行，字段严格为 `{schema_version,args,stdin,deadline,manifest_sha256}`：schema `1.0`，args 仅上述三种动作，stdin 为空，剩余 deadline 为 `0 < 秒 <= 35`。客户端总期限 35 秒、控制回复解码上限 16 KiB，root watchdog 最多执行 30 秒并预留回收时间。

服务在读取请求前验证 SO_PEERCRED、授权普通 UID、peer pidfd、凭据与 starttime；授权不是任意同机用户。manifest 与 root-owned 固定安装资源、非可写和非 symlink 路径核验，拒绝用户环境／路径／UID／命令注入。服务重建固定 PATH／LANG／no-bytecode 及服务核实的 `SYSOM_IDC_CALLER_UID/SYSOM_IDC_PEER_PID/SYSOM_IDC_PEER_STARTTIME`，不信任请求自报身份。

unit 为 root、Type=simple、Restart=on-failure、KillMode=control-group。固定安装与授权由安装流程负责；VSIX 和 Hook ZIP 不安装此 root 服务。没有授权、pidfd 支持或运行中 systemd 时，不把普通用户 fallback 描述为完整特权采集。取消／断连只回收服务拥有的控制子进程，不处置 Agent 业务进程。

## 12. Qoder Hook 与独立累计

### 12.1 插件与运行时

Hook 是可选独立来源，Linux、`python3 >= 3.6`。应用／CLI 使用 `sysagent-qoder-plugin-*.zip`，IDE 使用 `sysagent-qoder-ide-plugin-*.zip`，用户手动导入；静态打包不安装、上传或发起付费调用。

运行时向上检查最多 8 层 `/proc` 祖先，通过 exe basename 核实 `qoder/qoder-ide`，有界读取 stat 查 parent；不读 cmdline／environ，无法核实时使用包标签。

业务字段严格为：

```text
v:1
 event_id agent kind occurred_at session_id tool call_id error_type interrupt subagent model
```

event_id 是 8 字节随机值的 16 位小写 hex；Agent 标签须小写安全格式且最长 32，ID／工具标签最多 128 字符，模型／子 Agent 标签允许有界空格；时间为校验日历的 UTC 毫秒时间。不存 prompt／正文／cwd／工具输入输出／error 文本，不读 transcript 或工具文件。

### 12.2 注册事件与摘要注入

应用／CLI 注册 20 类：

| 原生事件 | kind |
| --- | --- |
| SessionStart／SessionEnd | session_start／session_end |
| UserPromptSubmit | prompt_submit |
| PreToolUse／PostToolUse／PostToolUseFailure | tool_start／tool_end／tool_failure |
| PermissionRequest／PermissionDenied | permission_request／permission_denied |
| Stop／StopFailure | turn_stop／turn_failure |
| Notification | notification |
| SubagentStart／SubagentStop | subagent_start／subagent_stop |
| TaskCreated／TaskCompleted | task_created／task_completed |
| TeammateIdle | teammate_idle |
| Elicitation／ElicitationResult | elicitation／elicitation_result |
| PreCompact／PostCompact | compact／compact_completed |

IDE 注册 12 类：SessionStart、SessionEnd、UserPromptSubmit、PreToolUse、PostToolUse、PostToolUseFailure、PermissionRequest、Stop、SubagentStart、SubagentStop、PreCompact、Notification。

仅 SessionStart 同步查询运行宿主的认证 `GET /api/v1/summary`，注入带采样时间／未知项的短 additionalContext JSON；无安全端点、无缓存或查询失败不注入。其余异步、不查询、不注入。运行时吞掉自身错误并退出 0，不用管家错误阻断 Agent；摘要查询不采集、不调用模型。

原生输入最多 16 MiB，超限排空后按空对象处理，坏 JSON／非对象也按空对象处理；失败不把原始 payload 放进诊断日志。

### 12.3 spool、安全与去重

默认 `~/.local/state/sysagent/agent-hooks/`；绝对 XDG_STATE_HOME 覆盖为 `$XDG_STATE_HOME/sysagent/agent-hooks/`。目录 0700、文件 0600、当前 UID、常规单链接文件、NOFOLLOW；拒绝不安全权限、所有权、链接，不自动修复。

`events.jsonl` 最大 1 MiB，轮转为 `events.1.jsonl`，只保留一个轮转文件，单行最多 2048 字节。`.lock` flock 互斥写入，失败仍不影响 Agent 主流程。

非空合法原生 payload 只在内存序列化，使用 32 字节私有 `.dedup-key` 做 HMAC SHA-256，取指纹写 `.dedup`；账本只保留 HMAC 和 expires，5 秒窗口、最多 256 项，不存 payload。追加成功后才提交去重，追加失败不压制成功副本；账本或密钥失败允许记录但不修权限，可能出现重复。缺不同发生 ID 的相同独立事件在窗口内无法区分。重复 SessionStart 不再次记录、查询或注入。

### 12.4 SQLite 累计与恢复边界

`history.sqlite3` 是 Hook 独立持久累计，不是一般任务数据库。SQLite 使用 DELETE journal、synchronous FULL、user_version 1 和 BEGIN IMMEDIATE；明细追加、保留文件导入及累计彼此有恢复检查。

- 以 event_id 与元数据指纹核验冲突，不凭行序号重复累计。
- spool 写入流程导入仍保留明细、恢复已追加但未累计的行，再轮转；宿主内部诊断也可有界导入存量。公共 GET 不启动 Python 导入。
- cursors 使用 dev／inode／offset／前缀哈希，减少轮转和 inode 复用误判。
- 累计只存允许元数据派生计数／指纹，Session 与 call 键使用 SHA-256，不存原始 payload。
- 明细删除或轮转不损失已经累计的值；启用前已删除记录、尚未累计且已不可读的事件不能恢复，不承诺永久原始明细。
- openTools 按记录时间配对，迟到 start 不任意重开已闭合调用；缺结束不证明卡死。tool_failure 的 interrupt true 计 interrupts，否则计 toolFailures；turn_failure 单列。
- 数据库 int64 累计，JS 仅接受安全整数；非法／溢出保留未知，不归零。

### 12.5 窗口明细与报告累计

宿主分别有界读取当前／轮转文件，每文件最多 2 MiB 尾部、单行 2048；校验来源安全、event ID 去重与时间，近 24 小时最多 5000 个输入事件、16 个 Agent 汇总，normalized events 仅最新 200 条。

缺目录／文件为 unavailable，安全空文件为 available，不安全来源为 invalid，跳过／上限／读取竞态／轮转不完整为 truncated。明细与累计状态独立，明细缺失不清累计，也不改变 AgentSight 固定五项 coverage。

`agent.hooks.history` 为 `{scope:"cumulative",status,reason,sampledAt,range,totals,activity}`：

- totals：`sessions/events/prompts/toolStarts/toolEnds/toolFailures/interrupts/permissionDenied/turnFailures/openTools`。
- activity：20 个 kind、最多 12 时间桶、8 个哈希 Session、64 工具、64 子 Agent 汇总，另保留 events／range／reason。

`agent-hook-events` 查询窗口明细，`agent-hook-agents` 查询窗口 Agent 汇总；累计在完整报告，不从最新 200 条重算。Hook 与 AgentSight 不做跨来源 Session／PID 关联，不把生命周期事件转换为 Token 或资源独占证据。

## 13. Agent 页面与报告

桌面与 IDE 共用七个视图：**总体统计、会话与明细、工具与协作、会话、中断、延迟、数据接入**。六张 Hook 卡展示独立累计活动，不是 AgentSight Token 卡。AgentSight Session／Token／未解决中断有自己的来源与范围。

- 进程可按名称／PID、角色／状态筛选，每页 20 条，筛选回第一页；窗口统计不随筛选变化。CLI no_port 正常，HTTP 探活不等于业务健康。
- Session 搜索只查已有 Agent／ID／Model，首末时间与关联中断仅为元数据，不请求正文；输入 Token 已含缓存用量，不重复累计。
- 中断展示事件 ID／类型／严重度／时间／Session／Call／PID／Agent／解决状态，不修改状态；明细条数不替代来源 count。
- 延迟按 E2E P95／TTFT P95／TPS P50 展示，保留 calls／streamingCalls／TPOT P95。只统计完整调用，TTFT／TPOT 只用于完整流式调用，没有任意业务故障阈值。
- Hook 图表与六卡消费 history totals／activity，筛选、表格分页或展开不改变累计；工具失败、权限拒绝、未配对工具开始不直接证明故障，轮次失败需要证据关注。

来源没有报告或数值缺失显示 `—`，只有记录支持零才显示 0。刷新失败保留报告并标记未更新，不显示成功采样。停用采集保留已存记录，不自动部署／修复／付费调用。

健康报告、GPU 专项、Agent 报告与云端巡检各自保留来源和采样时间。导出仅根据已有缓存，不补采，不将 Session 元数据、共享进程和 GPU job 拼成未经证明的资源归属。

## 14. 云端巡检

### 14.1 环境门控与子进程白名单

需要 `SYSOM_POP_ENDPOINT`、`SYSOM_ACCESS_KEY_ID`、`SYSOM_ACCESS_KEY_SECRET` 才创建云端客户端。可选 `SYSOM_SECURITY_TOKEN`、`SYSOM_REGION_ID`（默认 cn-hangzhou）、`SYSOM_DEVICE_ID`；`SYSOM_IDC_UPLOAD=0/false/no/off`（不区分大小写）关闭。

`status.mode = config ? 'pre' : 'mock'`，缺少配置保持本地模式；内部分析服务仍是本机 mode mock。凭据只从环境读取，不写源码、界面、公共响应或日志。本文仅列变量，不要求访问真实用户配置／凭据。

只在云端模式将上述七项 `SYSOM_*` 传给 sysAK，基线仍为 PATH／LANG／no-bytecode，无关父进程凭据不继承。启用云端意味着真实报告上传，不应把开发页面或 mock 标签当作隔离无外部请求的保证。

### 14.2 步骤、标识与结果

| 步骤 | 执行方 | 动作 |
| --- | --- | --- |
| 1 | sysAK | CreateHostInspectionUploadUrl，取得上传入口 |
| 2 | sysAK | PUT 预签名对象，上传采集报告 |
| 3 | sysAK | SubmitHostInspection，提交巡检 |
| 4 | 云端 | 分析并生成报告 |
| 5 | 宿主 | GetHostInspection 轮询，终态有 reportId 后 GetInspectionReport |

上传成功后 raw request_id 为 32 位十六进制 inspection_id，控制器用该身份提交内部解析并启动轮询；任务 `uploaded:true`、条件附 `inspection_id`。上传失败保留本地 UUID／结果，`uploaded:false`，不把 UUID 当巡检任务轮询。

宿主默认每 3 秒、120 秒轮询预算；终态为 `completed/partial_completed/failed/expired/cancelled`，可重试 5xx 在预算内间隔重试，取消为 PollCancelled／499，超时为 PollTimeout／504。预算在轮询检查点生效，不是对 SDK 单次网络调用的独立强制终止保证。

云端状态视图为 `{inspectionId,status,phase,progress,reportId,reportStatus,report,error,updatedAt}`。报告响应正文从 `{code,data,message}` 提取，code 非 Success 为 502；报告字段随后端返回，页面消费 itemSummaries／summary／scope／name／reportId，不假定固定检查项数。

### 14.3 失败与一致性

上传失败从有界 stderr 中 `idc_inspect: upload` 前缀解析说明，设 UploadFailed；本地采集继续可用。采样完成后启动的云轮询不阻塞资源队列；后续采样取消上一轮询，用 AbortController 和世代守卫避免迟到结果覆盖当前视图。暂停／关闭也取消轮询。

云端结果仅存内存，无历史报告库，公共 GET 不启动上传／轮询。云端总体级别来自后端，与本地健康分数有不同模型和证据，不能互相替代；缺报告或取报告失败应保留状态与原因。

## 15. 公共查询、安全与生命周期

### 15.1 独立查询服务

公共 `/api/v1` 是 cache-only GET，与内部解析、开发网页和 root socket 分离：仅 127.0.0.1 随机端口，独立 32 字节随机十六进制 Bearer，严格单 Host／单 Authorization，拒绝任何 Origin，不提供 CORS。HEAD／OPTIONS／写方法 405，GET body／Transfer-Encoding 拒绝。

URL 最长 4096，请求头 8192 字节，64 连接，请求／请求头 5 秒、keep-alive 2 秒，no-store／nosniff。每段 URI 解码后不得为空、点路径、斜杠、反斜杠或控制字符。来源 ID 含斜杠时即使整体编码也不能用详情路径，须用列表 filter.id／filter.queryId。

17 个数据集、完整字段白名单、类型、分页、投影与错误见[本机查询 API](./LOCAL-HTTP-API.md)。只复制契约允许的 own properties，不执行 SQL／表达式／正则，不暴露 raw 文件或任意代理。`resource-rows` 原始 id 可重复，详情用 resource:原始id；合成 ID 为快照作用域，Agent process PID 没有 starttime。

普通 snapshot.data 为 `{status,state,agent,tasks}`，无缓存时 state／agent null；summary 无健康缓存为 503，report 仅在健康和 Agent 均无时 503。已有报告中的 unavailable 来源以准确 meta 返回，不伪造正常。

### 15.2 发现凭证

桌面 userData／IDE globalStorageUri 下 `local-api/<instance UUID>.json`，目录 0700、文件 0600，当前 UID；直接父目录非组／其他用户可写，路径祖先无 symlink。不安全路径拒绝启动，不自动修权限，query_api.error 不阻止控制器独立体检。

字段 schema_version／instance_id／host_kind／pid／device_id／started_at／base_url／token／read_only。凭证不可打印、提交或上传，客户端只读取经安全核对的选定实例。正常关闭仅删除自身 inode／dev 的发现文件，崩溃残留不代表存活，多实例数据不共享。

### 15.3 关闭与信任边界

控制器 close 标记 closed／disabled、取消定时器和活动采样／Agent／云轮询，关闭查询端口，等待队列与服务控制收尾，再关闭内部 OpenAPI。缩窗／隐藏不等同于退出；公共服务仅随宿主生命周期存在。

渲染器／Webview 不提权，root 服务固定安装与信任校验只作用于 AgentSight 控制。资源采集器与业务目标操作由当前用户执行；采集子进程组回收和业务 SIGTERM 分开，不以“清理”泛称隐藏真实信号。

## 16. 构建、交付与源码导航

### 16.1 构建输入与产物

根入口为 `scripts/build.mjs`，targets 为 all／desktop／ide／web／qoder，默认 all。Node 20+；原生交付为 Linux x64，打包需 dpkg-deb，桌面运行需图形依赖和 Python；IDE 要求兼容 VS Code API 1.85+ 的本地扩展宿主。

根构建输出目录 `release/build-0.2.19/` 包含三个 deb（主 SysAgent、官方 GX、AgentSight runtime）、VSIX、应用／CLI Hook ZIP 与 IDE Hook ZIP；不生成 AppImage、source tarball 或 validation.json。
主 deb 不安装系统 sysAK；系统资源采集另需已安装 idc_inspect。vendor sysAK 输入包含 `idc_inspect`，构建前需验证组件、规则与完整性。应用 bundle 准备／校验为 `idc_inspect/resource_anomaly/memgraph/ai` 与相关诊断模块、规则和 manifest；bundle 用于交付及固定控制资源，不能把其中诊断命令或 manifest safe_profiles 解释为当前 root 主体检路径或完整无副作用认证。

AgentSight／官方 GX 来自对应 vendor 输入；云端 SDK 使用 vendor tgz。qoder 静态打包分别取插件允许文件，拒绝 symlink，不带 checkout／state／凭据，不要求 npm 安装、系统 sysAK 准备、前端构建或插件上传。应用／CLI 20 事件与 IDE 12 事件由各自插件注册，不混用宿主支持范围。

### 16.2 主要实现文件

| 相对仓库路径 | 职责 |
| --- | --- |
| `sysagent-idc/electron/idc-controller.cjs` | 采集、状态、任务、队列、调度、进程确认、云视图 |
| `sysagent-idc/electron/process-control.cjs` | 当前用户固定动作调用与严格回复验证 |
| `sysagent-idc/openapi-service.ts` | 内部契约服务、校验、幂等和原子提交 |
| `sysagent-idc/collected-state.ts` | 系统资源／体检与功率解析 |
| `sysagent-idc/src/health-data.ts` | 模型、评分与健康报告 |
| `sysagent-idc/electron/local-query-api.cjs` | 公共回环认证与发现生命周期 |
| `sysagent-idc/electron/query-data.cjs` | 17 数据集、查询算法、ID 和公共契约 |
| `sysagent-idc/electron/agentsight-client.cjs` | 元数据、已存记录汇总与采集控制 |
| `sysagent-idc/agent-diagnostics.ts` | AgentSight 本地分析 |
| `sysagent-idc/electron/agent-hooks.cjs` | Hook 安全读取与内部累计准备 |
| `sysagent-idc/agent-hook-diagnostics.ts` | Hook 窗口明细和累计报告校验 |
| `sysagent-agent-hooks/sysagent_hooks/runtime.py` | 输入、来源识别、摘要注入与退出语义 |
| `sysagent-agent-hooks/sysagent_hooks/spool.py` | 互斥追加、轮转和 HMAC 去重 |
| `sysagent-agent-hooks/sysagent_hooks/history.py` | SQLite 独立持久累计与导入 |
| `sysagent-idc/src/AgentDiagnostics.tsx` | 七视图与只读报告交互 |
| `sysagent-idc/electron/sysom-client.cjs` | 云端模式门控与步骤 5 |
| `sysagent-idc/build/sysak-root-runner.py` | 固定 root 控制协议与脚本映射 |
| `sysagent-idc/scripts/prepare-sysak.cjs` | bundle 准备与组件检查 |
| `scripts/build.mjs`／`scripts/package-qoder.mjs` | 根构建与两个独立 Hook ZIP |

实现文件说明是源码依据，不表示完成了任何机器的安装、真实硬件采集或管理员授权。

## 17. 实现限制

- 系统 sysAK、procfs、权限、GPU 工具与原生诊断能力决定证据覆盖；普通用户不能把受限日志／进程／硬件信息补成 root 结果。
- root AgentSight 控制是兼容请求与固定脚本映射；可信安装、授权、pidfd、systemd 与 eBPF 前提须分别满足，不能以 API 连通或 argv 形式保证采集运行。
- 任务、资源、Agent、操作和云结果没有通用持久历史／恢复队列；幂等受 100 份 FIFO 限制。Hook SQLite 仅累计合法已记录元数据，不恢复启用前删除事件。
- CPU／RSS／I/O 为有界排行，GPU job 与 Agent 明细为有界窗口；空列表、分页完成和高分不证明完整观察。
- 功率为传感器或模型的已知小计，无连续积分、整机完整功耗或 GPU／Session 独占归属；Hook／AgentSight 不建立跨来源身份。
- SIGTERM 已发送不证明退出／释放；结果未知必须刷新，不能自动重发。没有文件／FD／Session 清理、通用优化或自动修复。
- 资源响应 1 MiB 检查在读完后进行，云轮询预算不是 SDK 单请求强制 deadline；文档不将这些限额描述为更强的流式／网络中断保证。
