# SysAgent 管家本机查询 API

## 目标与边界

面向本机脚本、其他应用和 Agent，查询管家已有的信息，不受页面 Top10 展示限制。查询与执行分离：公共 HTTP 不开放进程终止、配置修改、任意命令、文件读取或上传。

接入顺序：启动桌面或 IDE 宿主 → 在界面形成所需资源／GPU／Agent 诊断缓存 → 选择对应实例的发现文件 → 用独立查询 Bearer 凭证读取能力目录和数据。GET 不启动采集；未采集、部分采集和失败不得冒充正常。

资源与体检由**当前用户调用系统已安装的 `sysak idc_inspect --request-id <uuid> -o -`**获取，采集 schema 为 `1.1`，经内部回环分析接口解析。资源采集不经过 root 辅助服务；主 deb 不安装系统 sysAK。

## 接口选择与安全边界

本机 HTTP/JSON 是常见做法，但不是唯一做法：

| 方式 | 优点 | 局限 | SysAgent 用途 |
| --- | --- | --- | --- |
| 回环 HTTP/JSON | curl、Python、Node 和其他语言均可直接调用；可提供 OpenAPI 契约 | 同机其他用户也可能访问端口；必须认证和验证 Host/Origin | 普通权限下开放查询 |
| Unix domain socket | 可结合文件权限与 peer 凭据约束调用者，不暴露 TCP 端口 | 跨平台及通用客户端接入较复杂 | 保留 root 辅助服务边界（现仅用于 AgentSight 采集控制） |
| 应用 IPC/Webview RPC | 适合应用内部通信及受信 UI 调用 | 外部程序不便使用，属于宿主内部协议 | 保留桌面与 IDE 内部通道 |

Ollama 的官方 API 使用本机 HTTP；Docker 默认通过 Unix socket 提供 Engine API，也支持受保护的其他传输。说明这两种选择均有成熟实践，不需要将特权执行能力一起搬到公共 HTTP。

仅绑定 `127.0.0.1` 不等于安全：DNS rebinding、浏览器访问和多用户本机访问仍需考虑。MCP HTTP 传输规范要求校验 Origin、建议本机绑定和认证；Ollama 的历史 DNS rebinding 漏洞也说明 Host 校验不能省略。

使用独立版本化只读 HTTP API，由普通权限宿主提供；root 服务、授权和特权 socket 不属于查询接口。使用 Bearer 认证、严格回环 Host 校验、拒绝浏览器 Origin，不开启通配 CORS。凭据不出现在 URL、日志或响应数据里。本地凭据发现需要限定为当前用户可读；不能把内部写接口的 token 同时发给查询客户端。

## 查询设计要求

- 能力发现：列出真实可查询的数据集、可用状态、字段和查询参数；未知能力不默默返回 Demo。
- 完整快照：提供一次一致性读取，保留协议版本、采集时间、来源、状态、覆盖范围和不可用原因。
- 列表查询：按已有数据的名称、ID、类型、状态等筛选；支持分页、排序和字段投影，不执行用户表达式或 SQL。
- 明确覆盖：进程排行榜当前采集有上限，不因为 API 返回更多行而称为全系统进程数据库；未实现的时序历史或 Session 资源归属明确说明。
- 详情与报告：查询已存的资源、体检、建议、任务、结果与结构化报告，不在 GET 时隐式开始高成本诊断或改变采集配置。
- 原始证据：仅查询已解析并保留的业务证据，不提供任意路径文件读取、任意 root 命令或秘密配置。
- 错误：无数据、来源不可用、缓存版本不符、无权限分别返回明确错误，不使用 0 或健康结论掩盖缺失。
- 契约：提供机器可读 OpenAPI 描述及 curl/Python 示例，使客户端可以自主发现和接入。
- 生命周期：进程退出时关闭查询服务；服务实例与数据版本明确，不将一次进程内缓存描述为持久化历史库。

## 功能与对外查询清单

| 功能 | 查询信息／数据集 | 真实性及限制 |
| --- | --- | --- |
| 采集器 | `status`：安装、启停、周期、下一次巡检、最近资源／体检任务、错误，以及 `collector`（name/command/schema_version/binary/source/version）、`collection`（schema_version/command/version/status/collected_at/duration_ms 与逐段 `sections[{name,status,reason}]`） | 普通权限控制器状态；`command` 为 `idc_inspect`，`schema_version` 为 `1.1`；`source` 区分 `system` 与 `override`（`SYSOM_SYSAK_BIN`）；未采集时 `collection` 为 `null`；不公开内部写 token |
| 云端巡检 | `status.cloud_inspection`、`snapshot` 内同字段：`inspectionId`、`status`、`phase`、`progress`、`reportId`、`reportStatus`、`report`、`error`、`updatedAt` | 只在配置 SysOM 凭据（`mode:"pre"`）且 sysAK 上传成功后才有值；`report` 是后端报告正文，字段随后端演进，契约只约束信封。GET 不触发上传或轮询，未配置/失败时为 `null` 或带 `error` |
| 整体体检 | `snapshot`、`summary`、`report`、`inspections`、`optimizations` | 保留分数算法、未检查／受限、证据和建议；健康页面 Agent／日志／网络／I/O 部分项尚无证据链 |
| CPU／内存／磁盘／能耗／GPU | `resources`、`resource-rows` | 完整已存资源和排行，不限 UI Top10；进程采集整体 Top20 与 Agent Top20 去重，单资源最多约 40 行，并非全进程库 |
| 进程资源 | `resource-rows` 的 PID、starttime、usage、quantity、agentKind | 内存是 RSS；磁盘行是 B/s I/O 速率，不是进程／目录磁盘占用；清理资格仅信息，不开放执行 |
| GPU 当前状态 | `gpu-devices`、`gpu-findings`、`gpu-jobs` | 卡级遥测、sysAK AI 检查及短采样窗口的进程诊断；按需运行，无 GPU／未运行／部分／失败均明确 |
| Agent 运行与诊断 | `agent-processes`、`agent-findings`、`agent-coverage` | 独立 AgentSight 服务提供证据，SysAgent OpenAPI 分析；与健康页面 Agent 检查项分开 |
| Agent Session | `agent-sessions` | 模型、会话数、token、首末时间；没有对话正文或 Session 真实资源归属 |
| Agent 中断与耗时 | `agent-interruptions`、`agent-latency` | 已消费的中断事件、严重度、解决状态、TTFT／E2E／TPS／TPOT；保留覆盖原因 |
| Agent Hook 事件 | `agent-hook-events` | 已读取的生命周期白名单元数据；无正文、cwd、工具输入／输出／错误文本，不代表模型调用或资源归属 |
| Agent Hook 汇总 | `agent-hook-agents` | 按 Agent 汇总已有 Hook 元数据；独立来源及覆盖状态；缺目录／文件时 unavailable，安全空文件保留 available，不改变 AgentSight 五项 coverage |
| 操作与任务 | `operations`、`tasks` | 操作最多 30 条；成功采集／诊断任务最多 100 条，仅本进程生命周期，不是持久化任务数据库。任务的 `uploaded` 与 `inspection_id` 只在 pre 模式且 sysAK 返回 32 位 hex `inspection_id` 时置位；上传失败回退 UUID 时 `uploaded:false`，不带 `inspection_id` |
| 导出报告 | `report` | 根据已有缓存生成结构化 JSON 与健康报告文本，不另行采集；无历史报告库 |
| 设备列表、日志样例、GPU 离线案例 | 能力发现标明不开放为真实数据 | 静态 Demo、React 局部状态及离线样例，不冒充本机事实；不代理 AgentSight 任意路径 |

控制器／内部 OpenAPI 的 `mode: "mock"` 是本机部署标签，不表示快照一定为模拟；`mode: "pre"` 表示已配置 SysOM 凭据、sysAK 会在采集后上传云端巡检。外部程序应结合 `state.mode: "collected"`、任务 `simulated: false`、来源、时间和覆盖状态判断；任何缺证据／受限结果都不代表健康。云端 `report` 的结论级别来自后端，不是本机评分，二者不可互相替代。

Agent 明细证据固定最近 24 小时，最多 256 个进程、500 个会话、200 个未解决中断和 256 个延迟条目。独立 `agent.history` 汇总来源已存记录，不受近 24 小时明细投影限制。API 分页只对已有缓存分页，不能拓宽上游窗口或补齐未采到的信息；每个数据集的元信息和目录限制优先于上述概述。

## CPU／GPU 功率字段与查询边界

`resources`／`resource-rows` 中的 `energy` 表示已有样本的 CPU／GPU 功率分量：`usage: null`，`quantity` 以 W 表示，不使用百分比阈值，不返回累计 Wh，也不是整机功耗。详细算法、校准及限制见[开发说明：CPU／GPU 功率与进程估算](./DEVELOPMENT.md#cpugpu-功率与进程估算)，完整计算和内部接口见[详细设计](./SYSAGENT-IDC-OPENAPI-DETAILED-DESIGN.md)。

- CPU 优先使用配对 RAPL package 能量差除以实际单调时间差；仅无有效 CPU RAPL 行时用整台可见机器的配对 `/proc/stat` busy fraction（排除 idle/iowait，不重复计 guest）乘参考值，默认 `5 W × 已采集的可见逻辑 cpu_count`，不是硬件 TDP。GPU 逐卡优先有效 `powerWatts`（含实际 0），否则用核心利用率乘参考值；逐卡参考值优先环境覆盖、有效正数 `powerLimitWatts`、默认 150 W。不覆写传感器字段，不用 VRAM／显存利用率补缺，也不以最高 GPU 利用率计算多卡功率。
- `energy.power` 包含 `method: measured|estimated|mixed|unavailable`、可空的已知小计 `cpuWatts`／`gpuWatts` 和 `missing`（`cpu`／`gpu`）。`energy.rows[].powerSource` 为 `rapl|gpu-sensor|cpu-model|gpu-model`，模型行可附 `referenceWatts`。仅相加已知分量；缺失或覆盖不完整标记 `partial`，缺失遥测不等于 0。不存在 GPU 的判断须结合完整硬件枚举及原生 AI PCI `no_gpu` 证据；空 NVIDIA 查询不能证明所有类型 GPU 均不存在，缺失遥测不补零。`source=sysak` 是证据来源，不证明全部瓦数实测。
- 可选 `SYSAGENT_CPU_FULL_LOAD_WATTS` 覆盖整个 CPU 参考值，`SYSAGENT_GPU_FULL_LOAD_WATTS` 覆盖每卡参考值；只接受有限十进制数 `0 < W <= 100000`，无效值忽略。须在桌面／IDE 共用分析逻辑的 OpenAPI 分析宿主环境设置，不修改配置文件或凭据，不安装服务或重新生成发行包。模型未校准且不含空闲基线；不计 RAM／磁盘／显示器／PSU 或云端推理，RAPL package 还可能与集成 GPU 重叠，组件和不是互不重叠域的认证总量。

CPU／GPU 采样窗口可能不同，快照不是连续时间线；重复 UI 读取或 GET 不产生新样本，不实现 Wh／kWh 积分。`power.processes` 提供 CPU 进程功率估算：`cpuWatts × cpu_pct_node / 整体 CPU busy%`。要求 CPU／process 段可用，窗口差不超过 `max(2 ms, CPU 窗口的 1%)`，有效进程占比之和不超过整体 busy%；整体 busy 为 0 时，仅 CPU 功率也为 0 才可给出 0 估算。条件不满足则不分摊。

`power.unattributedCpuWatts` 单独保留未归因 CPU 功率，不分配给 GPU 或 Session。进程值不是逐进程实测；`resource-rows` 中 energy 行是组件，进程估算须通过 `resources.power.processes` 或完整报告读取。共享 Qoder／MCP／renderer 不证明 Session 独占资源。

## Agent 管家视图与查询边界

桌面和 IDE 共用七个视图：**总体统计、会话与明细、工具与协作、会话、中断、延迟、数据接入**。六张 Hook 卡消费独立累计活动，不是 AgentSight Token 卡。AgentSight 的会话、输入／输出 Token 和未处理中断保留独立来源和统计范围；`agent.history` 是来源已存记录的独立汇总，近 24 小时列表不代表全量历史。未返回报告或数值缺失显示 `—`，`0` 仅表示来源记录为零；会话与 Token 包含辅助调用，输入已含缓存用量，上游缺失 usage 可能未计入。

- “总体统计”展示累计活动、诊断结论与问题，可跳转只读证据；延迟与进程探活来自 AgentSight。进程支持名称/PID、角色/状态组合筛选和每页 20 条分页，筛选回第一页且全窗口统计不变；HTTP 响应不代表业务健康，正常 CLI 无监听端口不视为故障。
- “会话”只对已有列表进行 Agent / ID / Model 搜索，按最后活跃时间降序、同时间按 ID 排序；全窗口 KPI 不受搜索影响。展开仅看首末时间与关联中断元数据，不请求正文。
- “中断”以紧凑表和只读九字段弹窗展示事件 ID、类型、严重度、发生时间、Session ID、Call ID、PID、Agent、处理状态。仅在报告已有关联会话时可跳转，不请求补采或修改状态。明细条数不代替全窗口未处理中断 count。
- “延迟”按 E2E P95 / TTFT P95 / TPS P50 切换实测对比；详细表保留完整调用数、流式调用数及 TTFT P95、E2E P95、TPS P50、TPOT P95。仅统计完整调用，TTFT / TPOT 仅适用于流式调用，无自定故障阈值。

页面搜索、展开、切换指标和查看事件只是本地报告交互，不改变 HTTP 查询参数、采集授权或数据来源，不获取对话正文、不提供 Session 独占 CPU/GPU 归属、不自动修复、部署或发起付费调用。停用采集保留已存记录。刷新失败保留报告并明确标记未更新，不能当作刷新成功。公共 GET 只读取宿主缓存，UI 刷新诊断使用内部报告通道，不是公共执行接口。

Hook 累计和图表来自 `agent.hooks.history` 的 `totals/activity`，不从最新 200 条明细重算；筛选与分页不改变累计。工具失败、权限拒绝和未配对工具开始不直接证明故障或卡死，轮次失败是需查看证据的关注事件。

体检首页的云端巡检结论与报告弹窗是另一条链路：它消费 `status.cloud_inspection.report`，由 sysAK 上传（步骤 1–4）和宿主只读轮询（步骤 5）产生，不属于 Agent 24 小时窗口，也不通过公共 GET 触发。凭据门槛、上传内容与失败回退见[根 README](../README.md#云端巡检可选)。

## Qoder Hook 元数据与只读摘要

Qoder Hook 插件是可选元数据来源，独立于 VSIX 和 AgentSight eBPF 采集，要求 Linux 与 `python3 >= 3.6`。应用／CLI 手动导入 `sysagent-qoder-plugin-*.zip`，IDE 使用 `sysagent-qoder-ide-plugin-*.zip`；打包不安装或上传。运行时通过有界 `/proc` 祖先检查核实实际 `qoder`／`qoder-ide` 可执行文件名，无法核实时使用插件包标签。

应用／CLI 注册 20 类事件，IDE 注册 12 类（含 Notification）。`SessionStart` 同步读取运行宿主的认证 `GET /api/v1/summary`，注入带采样时间和未知项数量的短缓存摘要；无安全端点或查询失败时不注入。其余 Hook 异步，不查询或注入。运行时失败统一退出 0，不以管家错误阻断 Agent。共享 spool 对相同非空原生事件 payload 做 5 秒去重，重复 `SessionStart` 不再次记录、查询或注入。

读取本机 API **不会采集**、触发诊断、修改配置、修复权限或发起模型调用。Hook 本身只将事件种类、时间、Agent、会话／调用 ID、工具名称、模型、子 Agent、结构化错误类型／中断标志等白名单元数据写入 spool；不含正文、提示词、`cwd`、`tool_input`、`tool_output` 或 `error` 文本，不读取会话文件或工具文件内容。

spool 默认路径 `~/.local/state/sysagent/agent-hooks/`；绝对 `XDG_STATE_HOME` 可覆盖为 `$XDG_STATE_HOME/sysagent/agent-hooks/`。私有目录／文件须为当前用户拥有的 0700／0600；权限不安全、所有权错误或符号链接拒绝使用，**不自动改权限**。缺目录或事件文件时 Hook 来源标记 `unavailable`；安全可读的空文件为 `available` 加空列表，权限不安全为 `invalid`，轮转或跳过记录为 `truncated`。这些状态不影响 AgentSight 固定五项 coverage，不将零条事件解释为业务健康。Agent 适配由 adapter 与 plugin 接入，共用运行时、spool 和报告读取链路。

spool 的 `.dedup` 账本与 32 字节 `.dedup-key` 均为私有 0600 运行时文件，不是 API 数据集。账本只保留 HMAC 指纹和到期时间（5 秒、最多 256 项），不保存 payload。账本或密钥出错时允许记录但不修复权限，可能出现重复；事件成功追加后才登记去重，写入失败不压制后续成功副本。空／非法 payload 不参与去重；相同 payload 的独立事件若无不同发生标识，窗口内无法区分。

事件业务白名单为 `event_id agent kind occurred_at session_id tool call_id error_type interrupt subagent model`，另有协议标记 `v:1`。明细写入 `events.jsonl`，按 1 MiB 轮转为 `events.1.jsonl`；独立 `history.sqlite3` 持久累计已记录事件。明细删除或轮转不影响已累计数值；启用前已删除记录无法恢复。宿主内部诊断可导入仍保留的合法记录，公开 GET 不执行导入。近 24 小时最多 5000 个输入事件、16 个 Agent 汇总，明细仅最新 200 条；累计不受这些明细上限限制。Hook 与 AgentSight 不做跨来源 Session／PID 关联。

`GET /api/v1/datasets/agent-hook-events` 与 `GET /api/v1/datasets/agent-hook-agents` 仅分页／筛选已有宿主报告缓存，字段、时间窗口、截断与不可用原因以 `/api/v1/capabilities` 及响应元信息为准；不会直接开放任意 spool 文件读取或写入，不因 GET 补采。Hook 元数据不替代 AgentSight 模型调用、Token、延迟或 Session 独占 CPU/GPU 证据。

## HTTP 安全、路径与响应

- 仅监听 `127.0.0.1` 随机端口，每实例有独立的 32 字节随机十六进制 Bearer token，以 SHA-256 摘要恒定时间比较认证。
- `Host` 必须出现一次，严格等于发现地址的 `127.0.0.1:<端口>`；不接受 `localhost` 或代理主机。拒绝任何 `Origin`，包括 `Origin: null`，不提供 CORS；`Authorization` 必须出现一次。
- 仅 GET；HEAD、OPTIONS 和写请求均返回 `405`、`Allow: GET`。GET 不得带请求体或 `Transfer-Encoding`；`Content-Length` 只能缺省或为 `0`。
- URL 最长 4096，请求头上限 8192 字节，连接上限 64；请求／请求头超时 5 秒，keep-alive 超时 2 秒，响应关闭连接。
- 解码后的路径段不得为空、`.`、`..`，或含斜杠、反斜杠、控制字符；坏编码、非规范路径与对象原型访问拒绝。
- 响应设置 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。凭据不进入 URL、日志或响应。查询只取得 `queryView()` 的缓存副本，不直接读 Hook 文件、不访问 AgentSight、不触发云端轮询。

所有路径均需独立查询认证。没有健康／Agent 缓存时，快照的 `data.state`／`data.agent` 为 `null`，不是整个响应为 `null`。已有报告内来源受限保留真实状态，不伪造完整证据。

| 路径 | 内容及无缓存语义 |
| --- | --- |
| `/api/v1/capabilities` | 17 个数据集、字段类型、可用查询参数、来源、覆盖与限制；不开放功能另列，`demo_data_exposed:false` |
| `/api/v1/status` | 控制器状态，含 `collector`、`collection`、`query_api`、可选 `agent_sight`、`cloud_inspection` |
| `/api/v1/snapshot` | 一次读取 `{status,state,agent,tasks}` |
| `/api/v1/summary` | 健康分数、评分范围、未知／不可用数量；无健康快照为 `503 NO_CACHED_DATA` |
| `/api/v1/report` | `{health,health_summary,health_text,agent,gpu}`；健康或 Agent 任一存在即可返回，二者均无为 `503 NO_CACHED_DATA` |
| `/api/v1/datasets/{name}` | 数据集筛选、排序、投影、分页；无所属缓存为 `503 NOT_CACHED` |
| `/api/v1/datasets/{name}/{id}` | 缓存对象详情；仅接受 `fields`／`revision` |
| `/api/v1/openapi.json` | 公共 OpenAPI `3.1.0` 契约，`info.version:"1.0"`；不使用普通 `data` 信封 |

数据集之外的端点不接受查询参数。`tasks` 在宿主启动时即有空列表缓存，没有成功任务时返回空列表。报告健康文本排行为 Top10，JSON 保留完整缓存。已有报告中的某来源 `unavailable` 可以返回 `200` 和准确来源元信息，不等同于没有宿主缓存的 `503`。

### 普通信封与数据集信封

普通响应为 `{schema_version:"1.0",meta,data}`。`meta` 包含：

- `instance_id`、`host_kind`、`device_id`；
- `revision`、`sampled_at`：健康缓存版本与时间，无缓存时为 `null`；
- `agent_sampled_at`：独立 Agent 缓存时间，无缓存时为 `null`；
- `cache_only:true`。

列表为 `{schema_version,dataset,meta,total,offset,limit,items,next_offset}`；详情为 `{schema_version,dataset,meta,item}`，schema 均为 `1.0`。数据集 `meta` 为 `{source,status,sampled_at,revision,coverage,limitations}`，描述**筛选前的来源缓存**。`total` 为筛选后条数，末页 `next_offset:null`。空结果、投影和分页不改变覆盖口径。

单次快照是宿主缓存的一致性副本，不代表各来源同时采样；健康 revision 不保证 Agent 跨页一致。

## 17 个数据集与字段白名单

下表为全部允许查询／投影的字段路径，名称须精确匹配。对象／对象数组可整体投影，不能任意深入其子字段筛选；类型、枚举与支持的操作以能力目录和契约为准。

| 数据集 | 允许字段 |
| --- | --- |
| `resources` | `id label usage capacity unit source status note quantity quantity.value quantity.unit quantity.total quantity.available rankLabel rankUnit sampledAt gpuDevices rows power power.method power.cpuWatts power.gpuWatts power.missing power.processes power.unattributedCpuWatts` |
| `resource-rows` | `id queryId resource name detail usage cleanable defaultSelected effect quantity quantity.value quantity.unit pid starttime agentKind agentId sessions powerSource referenceWatts` |
| `inspections` | `id label important phase status usage detail evidence execution` |
| `optimizations` | `id inspection title action effect` |
| `operations` | `id kind names time revision` |
| `gpu-devices` | `id index name uuid busId utilization memoryUtilization memoryUsedBytes memoryTotalBytes temperatureCelsius powerWatts powerLimitWatts eccCorrected eccUncorrected pcieGeneration pcieMaxGeneration pcieWidth` |
| `gpu-findings` | `id check severity message suggestion scope processPid processStarttime` |
| `gpu-jobs` | `id pid starttime name state cpuPercent rssBytes gpuIndices smUtilization memoryUtilization status findings` |
| `agent-processes` | `id pid name role status ports lastCheckAt latencyMs parentPid hasCrash` |
| `agent-sessions` | `id agent model conversations inputTokens outputTokens firstSeenAt lastSeenAt` |
| `agent-interruptions` | `id sessionId callId pid agent type severity occurredAt resolved` |
| `agent-latency` | `id agent calls streamingCalls ttftP95Ms e2eP95Ms tpsP50 tpotP95Ms` |
| `agent-findings` | `id severity title detail suggestion` |
| `agent-coverage` | `id key status reason` |
| `agent-hook-events` | `id agent kind occurredAt sessionId tool callId errorType interrupt subagent model` |
| `agent-hook-agents` | `id agent sessions events prompts toolStarts toolEnds toolFailures interrupts permissionDenied turnFailures openTools lastEventAt` |
| `tasks` | `id request_id operation status profile collection_status raw_bytes collected_at simulated uploaded inspection_id` |

### 身份与详情 ID

- 资源固定为 `cpu/energy/memory/disk/gpu`。资源进程行 ID 为 `process-<pid>-<starttime>`，名称不是身份，PID 必须联合 Linux starttime 核实。
- `resource-rows` 保留原始 `id`，可跨资源重复；详情按 `queryId = resource + ':' + 原始id`，例如 `cpu:process-123-456`，路由中的整个 ID 应 URI 编码。
- GPU job 有 starttime 时使用 `gpu-job:<pid>:<starttime>`；starttime 为 `null` 时使用 `gpu-job:<pid>:unknown:<编码后的采样时间>:<revision>`，身份未经核实，ID 仅属于该采样快照。
- 目录标记为生成 ID 的数据集使用 `<数据集名>:<健康revision>:<编码后的来源时间>:<行序号>`，无版本／时间时用 `none`，仅在当前缓存中确定，不能跨刷新持久引用。`agent-processes` 没有 starttime，不能建立稳定操作系统身份。
- 详情无匹配为 `404 NOT_FOUND`，重复匹配为 `409 AMBIGUOUS_ID`；列表 `filter.id` 按原字段匹配，`resource-rows` 亦可用 `filter.queryId`。
- **来源 ID 含 `/` 或反斜杠时，即使整体编码也会被详情路径拒绝。** 此时使用列表的 `filter.id`／`filter.queryId`，不要绕过路径规范。

## 查询参数、类型与分页

| 参数 | 规则 |
| --- | --- |
| `filter.<field>=value` | 标量精确匹配、标量数组成员匹配；同字段重复值为 OR，不同字段为 AND，不拆分逗号值 |
| `min.<field>`／`max.<field>` | 数字或 ISO 时间范围，包含边界；`min > max` 为 `400 INVALID_RANGE` |
| `q` | 大小写无关的字面子串，递归检查白名单 JSON 字符串值；不查键名、数字或布尔值，不执行表达式／正则 |
| `sort=-usage,pid` | 逗号分隔允许标量路径，`-` 降序；稳定多键排序，时间按实际时刻比较，同值保持来源顺序；`null`／缺失始终最后 |
| `fields=id,resource,name,pid,usage` | 白名单投影；缺省返回完整允许对象。空项、重复或父子重叠（如 `power,power.method`）拒绝；缺属性省略，`null`／`0` 保留 |
| `offset` | 默认 0，非负十进制安全整数 |
| `limit` | 默认 100，范围 1–1000 |
| `revision` | 非负十进制安全整数；必须等于响应 `meta.revision`，不符或缓存 revision 不存在为 `409 REVISION_MISMATCH` |

- `offset`／`limit`／`revision` 不接受符号、指数、空白或多余前导零，例如 `+1`、`1e2`、`01`。
- 筛选值按字段类型解析：布尔仅 `true/false`，数值须有限，整数字段须安全整数，枚举须合法；字符串不自动按数字转型。数字筛选允许负号、小数和指数，不接受正号前缀、空白、多余前导零、NaN 或 Infinity；分页和 revision 仍只接受规范非负十进制整数。
- 可空标量的字面值 `null` 只匹配真正的 `null`，不匹配缺字段；范围不匹配 `null` 或缺字段。
- 时间接受合法 ISO 日期或带时区的日期时间，校验日历与时区，不猜测本机时区；时间字段的精确筛选按实际时刻比较，不按字符串拼写比较。
- 仅 `filter.<field>` 可重复；其他参数重复为 `400 DUPLICATE_PARAMETER`。未知参数／字段、对象字段的标量操作均拒绝。
- 详情仅 `fields/revision`，不接受列表筛选、搜索、排序或分页。

查询顺序为筛选 → 搜索 → 排序 → 计算 `total` → 切片 → 投影。分页不拓宽上游采样窗口；固定排序、传健康 revision 并核对 Agent `sampled_at`，缓存变化时从第一页开始。

## 启动、发现与接入

桌面创建控制器、IDE 激活扩展时启动查询服务；每实例随机端口、独立 token，不固定使用 8787 或 AgentSight 端口，不向外部程序分发内部采集凭证。

发现文件为宿主存储目录的 `local-api/<instance UUID>.json`：

- 桌面：Electron `app.getPath('userData')/local-api/`。
- IDE：`context.globalStorageUri/local-api/`，扩展标识 `sysagent-local.sysagent-ide`。
- Linux 桌面常见路径 `$XDG_CONFIG_HOME/sysagent-idc/local-api/`，未设置时位于 `~/.config`；VS Code 常见路径 `~/.config/Code/User/globalStorage/sysagent-local.sysagent-ide/local-api/`。宿主名称和自定义 profile 影响路径，不应硬编码。
- 目录须当前用户拥有且为 0700，JSON 为 0600；直接父目录须当前用户拥有且非组／其他用户可写，祖先不得为符号链接。不安全权限使查询服务拒绝启动，不自动修复；体检控制器可独立运行，`status.query_api.error` 给出失败状态。
- JSON 字段为 `schema_version`（`1.0`）、`instance_id`、`host_kind`、`pid`、`device_id`、`started_at`、`base_url`、`token`、`read_only`。不要上传或提交发现文件。
- 正常关闭仅删除自身设备号／inode 匹配的文件并关闭端口；崩溃残留不等于活实例，须连接并核对 `instance_id`。实例缓存不共享，关闭所有宿主后没有常驻公共 HTTP 服务。

先在界面形成缓存，再查询。客户端读取发现文件前须核对所有权、私有权限、常规文件类型及无符号链接路径；只读取选定实例，不批量输出凭证。

### Python：标准库直接回环，不代理、不重定向

设置 `SYSOM_QUERY_DISCOVERY` 为经安全核对的所选实例 JSON 路径。代码只打印查询结果，不打印发现文件或 token：

```python
import http.client
import json
import os
from urllib.parse import urlencode, urlsplit

with open(os.environ['SYSOM_QUERY_DISCOVERY'], encoding='utf-8') as file:
    endpoint = json.load(file)
base = urlsplit(endpoint['base_url'])
if (base.scheme != 'http' or base.hostname != '127.0.0.1'
        or base.username or base.password or base.path not in ('', '/')
        or base.query or base.fragment or base.port is None):
    raise ValueError('发现地址必须是直接回环端点')


def query(route, parameters=None):
    connection = http.client.HTTPConnection('127.0.0.1', base.port, timeout=5)
    try:
        target = route + ('?' + urlencode(parameters, doseq=True) if parameters else '')
        connection.request('GET', target, headers={
            'Authorization': 'Bearer ' + endpoint['token'],
        })
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError('查询失败：HTTP ' + str(response.status))
        return json.load(response)
    finally:
        connection.close()


print(json.dumps(query('/api/v1/capabilities'), ensure_ascii=False, indent=2))
print(json.dumps(query('/api/v1/datasets/resource-rows', {
    'filter.resource': 'cpu', 'sort': '-usage',
    'fields': 'id,queryId,resource,name,pid,starttime,usage,quantity',
    'limit': 100,
}), ensure_ascii=False, indent=2))
```

### curl：凭证仅通过 stdin 配置输入

Python 直接把配置传给子进程，不打印认证头；禁用 curl 默认配置与代理，不跟随重定向：

```bash
python3 - <<'CLIENT'
import json
import os
import subprocess
from urllib.parse import urlsplit

with open(os.environ['SYSOM_QUERY_DISCOVERY'], encoding='utf-8') as file:
    endpoint = json.load(file)
base = urlsplit(endpoint['base_url'])
if (base.scheme != 'http' or base.hostname != '127.0.0.1'
        or base.username or base.password or base.path not in ('', '/')
        or base.query or base.fragment or base.port is None):
    raise ValueError('发现地址必须是直接回环端点')
config = '\n'.join([
    'url = ' + json.dumps(endpoint['base_url'].rstrip('/') + '/api/v1/snapshot'),
    'header = ' + json.dumps('Authorization: Bearer ' + endpoint['token']),
]) + '\n'
subprocess.run([
    'curl', '--disable', '--silent', '--show-error', '--fail',
    '--noproxy', '*', '--max-time', '5', '--config', '-',
], input=config, text=True, check=True)
CLIENT
```

不要使用 `-v`、`--trace` 或 `-L`，不要调试打印 `endpoint`，不要把认证头放进命令行。失败时按实例、错误码与覆盖状态排查，不公开 token。

## 错误

业务错误信封为 `{schema_version:"1.0",error:{code,message}}`。按 `code` 判断，消息不作为稳定协议；源码消息可为英文。HTTP 解析层拒绝的超大请求头等不保证业务 JSON 信封。

| HTTP | 代码 | 含义 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST`、`INVALID_PATH` | GET 请求体、非规范路径或编码非法 |
| 400 | `INVALID_QUERY`、`INVALID_PARAMETER`、`DUPLICATE_PARAMETER` | 查询格式、未知参数或非法重复 |
| 400 | `INVALID_FIELD`、`INVALID_FIELDS` | 不允许字段、投影空项／重复／重叠 |
| 400 | `INVALID_NUMBER`、`INVALID_TIME`、`INVALID_BOOLEAN`、`INVALID_VALUE` | 类型、时间或枚举值非法 |
| 400 | `INVALID_LIMIT`、`INVALID_RANGE`、`INVALID_ID` | 分页限额、范围或详情标识非法 |
| 401 | `UNAUTHORIZED` | 凭证缺失／无效／重复，含 `WWW-Authenticate: Bearer` |
| 403 | `FORBIDDEN_CLIENT` | 存在 Origin 或 Host 不符合回环要求 |
| 404 | `NOT_FOUND`、`UNKNOWN_DATASET` | 路径／详情不存在或未知数据集 |
| 405 | `READ_ONLY` | 非 GET，含 `Allow: GET` |
| 409 | `REVISION_MISMATCH`、`AMBIGUOUS_ID` | 缓存版本不符或详情标识不唯一 |
| 503 | `NOT_CACHED`、`NO_CACHED_DATA` | 所属缓存／所需报告不存在 |
| 500 | `QUERY_FAILED` | 非预期缓存查询失败 |

已有报告中来源不可用／截断时，查看元信息与原因；HTTP 成功不表示业务健康。

## 实现与协议依据

本机接口位于 `sysagent-idc/electron/local-query-api.cjs`，目录、参数、ID 与契约来自 `query-data.cjs`，缓存由 `idc-controller.cjs` 提供。桌面与 IDE 共用控制器和报告解析。公共契约 `info.version` 为 `1.0`，其中 `Status.schema_version` 为 `1.1`；内部 `/openapi/v1` 契约 `info.version` 为 `1.3.0`，采集 schema `1.1`、Agent schema `1.0`，OpenAPI 规范均为 `3.1.0`。二者凭证和执行边界分离。

系统资源、任务、Agent 和云端结果为进程内缓存，无通用持久任务／历史库；Hook `history.sqlite3` 是独立持久累计来源。能力目录中的 `persistent-history` 不表示 Hook 已累计数值不存在。GPU job 为最多 10 秒短窗口；AgentSight API 可访问不证明 trace 采集运行。root 控制使用兼容 `idc --agent-collection {status|ensure|disable}` 请求，runner 映射到固定 Python 控制脚本；`idc_inspect` 不支持此参数，不能以请求形式保证采集可用。不存在跨来源 Session／PID 或 GPU／Session 独占资源归属。

云端凭据只通过 `SYSOM_POP_ENDPOINT`、`SYSOM_ACCESS_KEY_ID`、`SYSOM_ACCESS_KEY_SECRET` 说明，可选 `SYSOM_SECURITY_TOKEN`、`SYSOM_REGION_ID`、`SYSOM_DEVICE_ID`；`SYSOM_IDC_UPLOAD=0/false/no/off` 关闭上传。sysAK 执行步骤 1–4，宿主步骤 5 每 3 秒轮询、按 120 秒预算等待并取报告。结果仅存内存，公共 GET 不上传或轮询，不需要读取真实配置／凭据。

- [详细设计](./SYSAGENT-IDC-OPENAPI-DETAILED-DESIGN.md)
- [Ollama：本机接口说明](https://docs.ollama.com/api/introduction)
- [Docker：保护守护进程接口](https://docs.docker.com/engine/security/protect-access/)
- [MCP：HTTP 传输安全要求](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [NCC Group：DNS rebinding 安全分析](https://www.nccgroup.com/research/technical-advisory-ollama-dns-rebinding-attack-cve-2024-28224/)
- [OpenAPI：机器可读接口描述](https://learn.openapis.org/)
