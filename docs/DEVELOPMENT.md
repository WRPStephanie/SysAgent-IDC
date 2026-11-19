# 开发说明

本文说明源码分工、开发入口、数据契约、真实操作边界和测试依赖。安装与交付见[打包说明](./PACKAGING.md)，插件使用见[IDE 说明](../sysagent-ide-extension/README.md)。命令默认在仓库根目录执行。

## 环境与安全前提

- Node.js 20+、npm；开发可使用 Node.js 22 或 24。
- 原生桌面与插件构建使用 Linux x86_64，桌面运行需要图形会话；打包 deb 需要 `dpkg-deb`。
- 真实资源采集要求系统已安装含 `idc_inspect` 的 sysak、可执行的 Python 3 和当前用户访问权限。安装 SysAgent 主 deb 不安装系统 sysak。
- AgentSight、GX 和系统辅助服务的原生库、glibc、Python pidfd 依赖见[运行依赖](./PACKAGING.md#运行依赖与-sysak-来源)。
- 可选 FastAPI 骨架使用 Python 3.12 与 venv，不是前端的真实后端。
- 自动截图工具使用 Google Chrome，默认路径 `/usr/bin/google-chrome`，需要对应开发依赖和图形环境。

开发网页不是隔离预览：`demo-api.ts` 创建真实控制器，会调用系统 sysak，有完整云端凭据时会上传；确认进程操作会影响真实任务。只调界面时不注入云端凭据，并用 `SYSOM_IDC_UPLOAD=0` 禁止上传；该开关不禁止本地采集或进程操作。需要无副作用测试时使用注入替身与固定夹具，不把真实开发网页当作替身。

凭据只通过环境变量或既有安全密钥机制提供，不写入源码、文档示例值、包内配置、日志或发布件。不读取真实用户配置排查测试，不改权限策略、免密规则或全局 npm 配置，不结束未知进程。

## 源码与运行链路

桌面、IDE 和开发网页共用 `sysagent-idc/src/` 页面与 `electron/idc-controller.cjs`。不同宿主各自持有资源快照、巡检设置和报告缓存。

```text
桌面 preload / IDE Webview RPC / 开发网页 /api/idc
                       ↓
              createIdcController
                ├─ 系统 sysak idc_inspect → 本地 OpenAPI → 资源与体检快照
                ├─ AgentSight API + Hook spool／累计数据库 → OpenAPI → Agent 报告
                ├─ 当前用户进程身份检查与确认后 SIGTERM
                └─ 可选 sysAK 上传 → SysOM 任务轮询与报告

公共 /api/v1 GET → 已有控制器缓存（不触发上述操作）
```

| 入口 | 责任 |
| --- | --- |
| `sysagent-idc/electron/main.cjs`、`preload.cjs` | 桌面窗口、本地协议、隔离 IPC 桥接 |
| `sysagent-ide-extension/src/extension.ts`、`webview/` | IDE 状态栏、面板、CSP 与 RPC；没有系统浮窗 |
| `sysagent-idc/demo-api.ts` | Vite 开发／预览服务上的真实 `/api/idc` 控制接口 |
| `sysagent-idc/electron/idc-controller.cjs` | 采集调度、schema 校验、缓存、云端状态机与确认操作 |
| `sysagent-idc/collected-state.ts`、`openapi-service.ts` | 资源与功率分析、标准化快照和 Agent 报告 |
| `sysagent-idc/electron/process-control.cjs` | 当前用户 sysAK 进程接口与响应校验 |
| `sysagent-idc/electron/sysom-client.cjs` | 环境凭据门槛、子进程白名单、SysOM 只读轮询与报告 |
| `sysagent-idc/electron/agentsight-client.cjs`、`agentsight-deployment.cjs` | 独立 AgentSight 数据接入与部署检查 |
| `sysagent-idc/electron/agent-hooks.cjs`、`sysagent-agent-hooks/sysagent_hooks/` | 私有 Hook 明细读取、独立累计持久与适配器 |
| `sysagent-idc/electron/query-data.cjs`、`local-query-api.cjs` | 公共只读查询字段白名单、数据集、回环服务与鉴权 |
| `sysagent-idc/scripts/build-openapi.cjs` | 生成共享分析模块与 Hook 运行时；不手改 `electron/generated/` |

主要页面为 `HealthGuardPage.tsx`（体检与报告）、`CloudReport.tsx`（云端报告）、`ResourceRankings.tsx`（排行与进程确认）、`HealthPerformance.tsx`（性能）、`GpuDiagnostics.tsx`（GPU 诊断）和 `AgentDiagnostics.tsx` 中的 `LiveAgentDiagnostics`（本机 Agent 诊断）。`App.tsx` 管理导航与公共窗口，`DesktopDemo.tsx` 管理页面快照、启动器和演示告警，`components.tsx` 提供公共组件，`src/styles/` 管理样式与本地字体。

## 开发、编译与打包

首次开发桌面：

```bash
npm --prefix sysagent-idc ci
npm --prefix sysagent-idc run dev
```

该子项目 `dev` 同时启动 Vite 与 Electron，开发地址为 `http://127.0.0.1:5173`。仅网页可使用：

```bash
npm run dev
# 或
npm --prefix sysagent-idc run dev:web
```

端口应空闲；需要其他端口时向 Vite 传入参数，不随意停止其他进程。开发网页与 `vite preview` 都挂载真实 `/api/idc`。

类型检查与静态前端构建：

```bash
npm --prefix sysagent-idc run build
```

在桌面子项目目录中可用 `SYSOM_LOAD_DIST=1 ./node_modules/.bin/electron .` 运行已编译页面。开发模式读取 Vite，静态运行与安装件通过 `sysom://app/index.html` 加载本地资源，不依赖开发服务器。

IDE 开发需要两个子项目的共享依赖及准备好的 sysAK bundle。根目标处理前置步骤：

```bash
npm run build:ide
```

已有前置输入时，可分别执行：

```bash
npm --prefix sysagent-ide-extension run typecheck
npm --prefix sysagent-ide-extension run build
npm --prefix sysagent-ide-extension run package
```

根 `npm run build`／`npm run release` 输出三 deb、VSIX、两个 Hook ZIP、runtime 目录、安装脚本、许可与校验清单；独立 `build:desktop`、`build:ide`、`build:web`、`build:qoder` 的边界见[构建入口](./PACKAGING.md#构建入口)。vendor sysAK 含 `idc_inspect`，VSIX 校验并复制 bundle；Qoder 静态 ZIP 不安装依赖或执行 Hook。共享页面或宿主代码应分别构建桌面与 IDE，不修改生成产物。

### 桌面行为与 GPU 可见性

Electron 启动显示体检主页；最小化或关闭主页会隐藏主窗口，显示独立透明、置顶、跳过任务栏的小管家。拖动限制在显示器工作区，点击或 Enter 恢复主页并保留位置和快照，右键“退出”才结束应用。主渲染器持有快照，浮窗只接收 IPC 异常摘要，不创建第二份模型；浏览器只模拟页面内桌面，不创建系统浮窗。

“动态告警演示”是模拟提示，不是资源采集证据。真实资源与体检通过宿主控制器调用系统 sysAK，不在渲染器内模拟采样。

`electron/gpu-detect.cjs` 只读识别宿主 GPU，`src/gpu-presence.ts` 提供纯浏览器 WebGL 判断。未取得资源采集快照且未识别到 GPU 时隐藏 GPU 入口；真实采集模式保留入口以说明硬件、执行与不可用状态，资源项按实际证据展示。`SYSOM_GPU=0|1` 可覆盖宿主可见性，浏览器使用 `?gpu=0|1`。覆盖值不证明 GPU 遥测或诊断可用。Linux 无 DRM render 节点时关闭 Chromium 硬件加速，不关闭沙箱。GPU 原生诊断使用 sysAK AI／GX 证据，硬件、驱动或权限不足必须标明不可用／部分覆盖，不能把依赖加载检查当作硬件成功路径。

## 系统资源、体检与进程操作

### sysAK 与协议

控制器按 `SYSOM_SYSAK_BIN → /usr/bin/sysak → /usr/local/bin/sysak → PATH` 解析系统 sysak；注入的 `options.sysakBinary` 优先。显式覆盖只检查指定路径。组件优先取二进制 realpath 同目录的 `.sysak_components/`，否则 `/usr/local/sysak/.sysak_components/`；启动前检查可读 `tools/idc_inspect` 与规则，防止组件缺失时下载。

采集命令为 `sysak idc_inspect --request-id <UUID> -o -`，envelope 要求 `schema_version = "1.1"`、`collection.profile = "inspection"`。失败包括 `UNSUPPORTED_PLATFORM`、`SYSAK_NOT_FOUND`、`SYSAK_COMPONENT_MISSING`。采集以当前普通用户运行，不经过 root helper；包内 bundle 只供 AgentSight 采集控制。

资源包含 CPU、内存、磁盘、FD、进程与 GPU、RAPL 等采集段。进程排行使用 PID + starttime 标识，含 CPU、RSS 等样本；各段的 `status`／`reason` 表达完整、部分或不可用状态，未知不补零。磁盘进程排行为 B/s I/O，不代表目录大小或磁盘空间归属；UI Top10 不代表全部系统进程。

采集外层时限 45 秒，sysAK 内部预算 24 秒、硬超时 30 秒，原始 stdout 上限 8 MiB；控制器截取首个完整 JSON 对象。标准化结果提交进程内回环 `/openapi/v1/collections`，展示服务契约的 `info.version = "1.3.0"`。外层 `mode: "mock"` 是本机部署标签，真实证据由 `state.mode = "collected"`、`task.simulated = false` 表达，不能按标签称其为模拟采集。

界面可设置采集启停及 1–1440 分钟巡检周期。资源展示与常规操作为只读，控制器只接受实际巡检，不执行文件清理、Session 清理、自动优化或模拟改值；推荐文案不等于已执行修复。

### 确认结束进程

资源排行支持名称／PID 搜索、全部程序／只看 Agent 筛选和最多 10 个可结束目标。Agent 标签由进程名称白名单识别，可能漏识别，不形成 Session 归属。

受控操作使用 `sysak idc_inspect --process-action check|terminate`，stdin 为 `{manager_pid, targets}`，响应协议 `schema_version = "1.0"`，时限 15 秒、响应上限 64 KiB。只允许当前用户的非受保护进程，root、其他用户或身份变化的目标不能结束。

准备阶段校验快照 revision、PID + starttime 与权限，生成有效期 60 秒的一次性确认 token。确认阶段消费 token 后再次执行受控 SIGTERM，不自动 SIGKILL；失效、快照变化或响应不完整时要求刷新核对，不重复操作。操作可能中断真实任务，不能绕过确认。

## 云端巡检（可选）

完整的 `SYSOM_POP_ENDPOINT`、`SYSOM_ACCESS_KEY_ID`、`SYSOM_ACCESS_KEY_SECRET` 使控制器进入云端模式 `pre`；否则保持本地模式 `mock`。`SYSOM_IDC_UPLOAD=0|false|no|off` 显式关闭上传。可选环境变量包括 `SYSOM_SECURITY_TOKEN`、`SYSOM_REGION_ID` 和 `SYSOM_DEVICE_ID`，不提供实际密钥示例。

sysAK 执行上传步骤 1–4，以 32 位十六进制 `inspection_id` 标识报告；宿主执行步骤 5：每 3 秒查询 `GetHostInspection`，最长 120 秒，到终态后取 `GetInspectionReport`。上传失败保留本地结果并记录错误，不轮询失败上传。子进程默认只保留基础环境，云端模式按白名单传递必要 `SYSOM_*` 变量；不输出凭据。

体检主页展示本地结论与云端进度／结论；有云端报告时“体检报告”打开云端弹窗，否则显示本地报告。云端规则级别不是本机评分，`partial_completed` 表示部分项目缺证据，不等于全部正常。云端结果仅存宿主进程内存，没有持久报告库。公共只读 GET 不采集、不上传、不轮询。

## Agent 管家与两类数据来源

`LiveAgentDiagnostics` 共用于桌面与 IDE，Hook 和 AgentSight 独立接入。页面顶部六卡为 Hook 累计：**已记录会话、Hook 事件、提交提问、工具开始、轮次失败、未配对开始**。累计计数及分类、趋势、会话活动和工具协作聚合由 `history.sqlite3` 独立持久保存，不从最新列表重算，不受明细轮转、筛选或分页影响。未被记录的活动不在累计范围内，缺失累计显示未知。

| 视图 | 内容与交互 |
| --- | --- |
| 总体统计 | Hook 累计趋势、事件构成、会话／工具活动排行与分类表；归组待关注问题、AgentSight 延迟对比与进程探活；点击可跳转已有证据 |
| 会话与明细 | Hook 会话分组、升序事件轨迹、近 24h 汇总及最新事件表；按 Agent、事件、分类和元数据搜索，可查看只读证据 |
| 工具与协作 | 工具开始／结束／失败／显式中断、累计未配对、子 Agent、任务交互、授权与上下文压缩 |
| 会话 | AgentSight 会话与来源已记录 Token，按 Agent／ID／Model 本地搜索，按最后活跃排序，展开已有中断关联 |
| 中断 | 类型筛选、分页表与九字段只读弹窗，仅在已有会话关联时跳转，不修改处理状态 |
| 延迟 | E2E P95、TTFT P95、TPS P50 对比及 TPOT P95 等表格；只统计完整调用，TTFT／TPOT 仅用于流式调用 |
| 数据接入 | Hook 独立覆盖与 AgentSight 进程、会话、中断、计数、延迟五项来源状态；不自动安装或启用 |

Hook 的近 24h 明细输入上限为 5,000 个事件、16 个 Agent，最新列表最多 200 条。分类统计、工具统计和事件页可选每页 5／10／20 条；Hook 会话与 Agent 汇总每页 5 条、轨迹每页 8 条，AgentSight 会话／中断／延迟表每页 20 条、延迟图每页 8 条，进程探活每页 20 条。筛选、翻页和证据跳转只处理已取得数据，不追加采集，不改变全窗口或累计数值。

AgentSight 使用固定近 24h 窗口，包含辅助调用；输入 Token 已含缓存用量，不重复相加。未报告 usage 可能记录为 0，不能宣称完整消耗；列表截断时完整会话／Token 总数未知。Hook 不提供 Token 或调用延迟，不与 AgentSight Session ID／PID 跨来源关联。

报告缓存只复用 60 秒内结果，手动刷新绕过缓存；过期或时钟回退时重新获取，失败保留上次报告并标明刷新失败，不延长有效期。进程探活支持名称／PID、角色和状态过滤；正常 CLI 无端口不算异常，HTTP 响应不等于业务健康。未配对开始只表示没有配对结束记录，不等于卡死；工具失败和授权拒绝也不直接等于 Agent 故障。空列表、来源不可用或部分覆盖都不代表健康。

### AgentSight 部署与主机级采集边界

首次启动复用可用 API，或从独立配套件准备缺失文件并启动普通 `agentsight serve`。默认用户目录 `~/.local/share/sysom/agentsight/`，绝对 `XDG_DATA_HOME` 可覆盖；相同 HOME／XDG 的桌面与 IDE 共享目录。显式 `SYSOM_AGENTSIGHT_BIN`、`SYSOM_AGENTSIGHT_CONFIG`、`SYSOM_AGENTSIGHT_URL` 指定的部署优先，令牌经 `SYSOM_AGENTSIGHT_TOKEN` 或已有安全机制提供，应用不覆盖已有部署配置。

默认无主机级采集。应用控制器发送 `idc --agent-collection {status|ensure|disable}` 兼容请求，root runner 严格校验后映射到固定 AgentSight Python 控制脚本，不调用 `idc_inspect` 执行此参数。可信安装、普通用户授权、systemd、pidfd 与 eBPF 能力决定实际可用性；不以授权参数、API 启动或包内 bundle 校验推断采集成功。

主机 trace 可能保存其他进程明文、参数和完整会话，匹配规则不是严格隔离，`traceEnabled:false` 不脱敏本地数据库；多用户主机尤其需要审慎授权。托管 trace capabilities 含 `CAP_SYS_ADMIN`，API／GUI／IDE 不获得。托管数据库合计 50 MiB 是软清理目标，WAL、忙锁与空页可使超出；停用保留数据，GUI 退出不等于停止独立 trace。详细安装、授权与停用边界见[打包说明](./PACKAGING.md#agentsight-主机级采集授权与限制)。

### Hook 事件适配与私有状态

Qoder 独立应用／CLI 注册 20 个事件；Qoder IDE 注册 12 个，含 `Notification`：

```text
两者都有：SessionStart、SessionEnd、UserPromptSubmit、PreToolUse、PostToolUse、
PostToolUseFailure、PermissionRequest、Stop、SubagentStart、SubagentStop、
PreCompact、Notification

独立应用／CLI 还注册：PermissionDenied、StopFailure、TaskCreated、TaskCompleted、
TeammateIdle、Elicitation、ElicitationResult、PostCompact
```

两者使用 `adapters/qoder.py` 与共享 Python 运行时，运行要求 Linux、Python 3.6+、仅标准库。只有 `SessionStart` 同步查询 `/api/v1/summary` 缓存，向 Agent 注入最多 600 字符的短摘要；其余异步，不查询正文、不产生模型调用。读取摘要不触发采集，失败不阻断 Agent。

metadata-only 白名单含事件、时间、Agent、Session／Call 标识、工具、错误类型、模型／子 Agent 及显式 interrupt；不保存正文、提示词、cwd、工具输入输出或错误正文。默认 spool 为 `~/.local/state/sysagent/agent-hooks/`，绝对 `XDG_STATE_HOME` 可覆盖。目录／文件为 0700／0600，不安全权限、所有权或链接被拒绝且不自动修复；明细约 1 MiB 轮转，累计库独立持久，不受 AgentSight 容量管理。

重复启用共用同一 spool 的插件时，文件锁下的 HMAC 指纹去重窗口为 5 秒、最多 256 项，身份在追加记录后提交；不保存载荷正文。空／无效载荷、不同 spool 或不可用去重账本可能产生重复。同一窗口内完全相同且无发生标识的合法事件无法区分。Linux `/proc` 有界父进程识别标注 `qoder`／`qoder-ide` 实际宿主，无法识别时保留插件标签；不保存可执行路径或环境值，不扩大注册事件范围。

## CPU／GPU 功率与进程估算

“能耗”资源返回的是 **W（瓦，功率）**，`usage = null`，不是百分比、Wh／kWh 或连续能量。合计仅为已知 CPU／GPU 分量，不是完整整机功耗。

### CPU

优先使用有效配对 RAPL package 样本：`CPU W = Δenergy_uj / 1e6 / Δt_monotonic_seconds`。只使用有效单调时间差，按路径去重并排除重叠子域；有效单次回绕依赖 `max_energy_range_uj`，重置或无效配对不能成为证据。只有无有效 RAPL 行时使用模型，部分 package 可用时保留已知小计和不完整状态，不叠加全机模型。

模型为 `CPU W = busy × (5 W × 可见逻辑核数)`；busy 来自配对 `/proc/stat` 整机样本，扣除 idle／iowait，guest 不重复计入。默认参考不是硬件 TDP，未校准且不含空闲基线；缺有效 busy 或参考时保持未知。

### GPU

逐卡优先有效 `powerWatts` 传感器读数，真实 0 W 有效；缺读数时用核心利用率比例乘参考瓦数。参考依次为有效 `SYSAGENT_GPU_FULL_LOAD_WATTS`、采集到的正数 `powerLimitWatts`、每卡默认 150 W。显存使用不能代替核心利用率；缺遥测不补零。逐卡选实测或模型后相加，部分卡未知时仅给已知小计并标明不完整，不用最高利用率代表多卡总功率。

| 环境变量 | 作用 |
| --- | --- |
| `SYSAGENT_CPU_FULL_LOAD_WATTS` | 替换整个 CPU 满负载参考值，不再乘逻辑核数 |
| `SYSAGENT_GPU_FULL_LOAD_WATTS` | 每张可见卡的满负载参考值 |

参考接受有限十进制数且 `0 < W <= 100000`，无效覆盖忽略；只影响模型，不覆盖传感器。变量需设置在 OpenAPI 分析宿主的启动环境，客户端／渲染器环境不改变宿主分析，不需要修改配置文件。

### 进程 Top10 与未知分量

CPU 进程功率按进程占整机忙碌 CPU 的份额归因估算：`进程 W = CPU 已知 W × 进程整机 CPU 百分比 / 整机 busy 百分比`。必须有匹配采样窗口、有效 PID + starttime 与占比；不满足时进程功率未知。UI 显示进程 CPU 功率估算 Top10，未归因 CPU 单独列出，不强行分摊剩余功率；GPU 不归因到进程或 Session。即便 CPU 总量来自 RAPL，逐进程值仍是估算。

`energy.power` 包含 `method`（measured／estimated／mixed／unavailable）、可空 CPU／GPU 已知小计、`missing`、`processes` 和 `unattributedCpuWatts`；行来源为 rapl／gpu-sensor／cpu-model／gpu-model。未知不补零，方法标签不保证完整覆盖。功率不覆盖 RAM、磁盘、显示器、供电损耗或云端推理；RAPL 与 GPU 能量域可能重叠。缓存重复读取不会生成连续样本，不累计 Wh／kWh，不推断共享 Qoder／MCP 进程的 Session 独占资源。

## 开发网页控制接口与公共只读 API

`demo-api.ts` 在 Vite 开发与预览服务挂载 `/api/idc`。仅接受回环 Host 和同源 Origin，响应不缓存；成功为 `{ok:true,data}`，失败为 `{ok:false,error:{code,message,status,retryable}}`。

| 路由 | 方法 | 行为 |
| --- | --- | --- |
| `/api/idc/status` | GET | 状态、采集来源、分段覆盖、云端与本机查询状态 |
| `/api/idc/snapshot` | GET | 资源快照，`?refresh=true|false` 显式控制刷新 |
| `/api/idc/agent-diagnostic` | GET | Agent 报告，`?refresh=` 控制报告刷新 |
| `/api/idc/reset` | POST | 重置控制器缓存并提交资源流程，不是无副作用清空 |
| `/api/idc/operations` | POST | 控制器接受实际 `inspect`；清理／优化／模拟改值返回只读错误 |
| `/api/idc/process-prepare` | POST | 目标身份复核与一次性确认 token |
| `/api/idc/process-execute` | POST | 消费 token 后执行受控 SIGTERM |
| `/api/idc/enabled` | POST | `{enabled}`，控制器采集启停，不等于主机 trace 开关 |
| `/api/idc/interval` | POST | `{inspection_interval_minutes}`，1–1440 整数 |

POST 要求 `application/json`，请求体上限 8192 字节。非法参数 400、跨站 403、未知路由 404、方法错误 405、快照冲突 409、过大请求 413、非 JSON 415。内部控制通道会真实采集、可能上传及结束进程，与公共 GET 边界不同。

公共回环 `/api/v1` 使用独立只读 Bearer token 和私有发现文件，只读宿主已有缓存，不补采、不执行操作、不上传或轮询。包括 status、capabilities、summary、report、snapshot、OpenAPI 契约与数据集查询，共 17 个数据集：

- 资源：`resources`、`resource-rows`、`inspections`、`optimizations`、`operations`。
- GPU：`gpu-devices`、`gpu-findings`、`gpu-jobs`。
- AgentSight：`agent-processes`、`agent-sessions`、`agent-interruptions`、`agent-latency`、`agent-findings`、`agent-coverage`。
- Hook：`agent-hook-events`、`agent-hook-agents`，读取已有缓存，不跨来源关联。
- 任务：`tasks`，为当前控制器的有界成功任务元数据，不是全局审计库。

字段投影、筛选、排序和分页遵守白名单，缺覆盖或空结果不能证明健康。不得公开发现文件或 token，不把回环地址当作多用户隔离保证。完整契约见[本机 HTTP API](./LOCAL-HTTP-API.md)。

## 模拟组件与未接入后端

源码内 `AgentDiagnostics` 模拟组件、`data.ts`、`agent-summary.ts`、`gpu-diagnostics-data.ts` 和离线内存 API 用于演示与固定状态测试，不是 `LiveAgentDiagnostics` 的真实来源。设备、远端、运维部署和部分日志页面中的演示对象不提供远程执行、自动修复或真实部署能力；来源必须明确区分。

`backend/app/` 是可选 FastAPI 骨架，可用 `npm --prefix sysagent-idc run backend:setup` 准备环境、`npm --prefix sysagent-idc run backend` 启动，监听 `127.0.0.1:8787`。healthz 提供健康检查；体检、设备、GPU、Agent、部署与日志路由返回模拟或占位响应，不执行真实诊断／重启／部署，前端不访问该服务。正常开发与运行无需启动它，虚拟环境不提交。

## 测试与调试

```bash
npm test                                  # 根构建、GX、Hook 打包与运行时测试
npm run test:api                           # 编译共享分析模块并测试公共只读查询
npm run check:versions                     # 受管理清单一致性
npm --prefix sysagent-idc test             # 应用测试
npm --prefix sysagent-ide-extension run typecheck
sh -n sysagent-idc/build/after-install.sh
```

应用测试覆盖控制器／采集契约、云端状态机与环境白名单、受控进程、root 辅助边界、打包、AgentSight、Hook、Agent UI、功率估算、GPU、查询与评分。隔离单元测试使用替身与固定夹具，不需要真实凭据或安装系统服务；真实网页、原生应用交互和云端测试必须单独评估副作用。

`sysagent-idc/tests/health-score.test.cjs` 依赖 `sysagent-analysis/port/c4-health-data.js` 参考夹具，该文件未随仓库提供，直接运行会因 ENOENT 失败。`sysak-package.test.cjs` 使用 15 秒子进程时限，运行耗时受并发与主机负载影响；超时应查看具体失败，不把完整测试套件默认视为通过。不要为通过测试读取用户配置、注入真实密钥或绕过安全校验。

云端端到端测试需要明确授权、凭据与可达服务，不属于默认测试范围。图形测试脚本需核对其交互是否适用于真实控制器，不能盲目触发进程操作或上传；调试只关闭自己启动的应用，不禁用沙箱，不修改系统权限。普通开发与使用无需开启远程调试端口。

原创代码采用 MIT，第三方、字体、sysAK、AgentSight 和 GX 保持各自许可。交付需保留三份许可声明及配套件许可，完整性检查不代替许可审查。
