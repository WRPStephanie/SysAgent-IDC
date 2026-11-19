# SysAgent 管家

SysAgent 是面向 Linux 工作站的本机资源与 Agent 诊断工具，提供 **Electron 桌面应用**和 **VS Code 兼容 IDE 插件**。两端共用页面与诊断逻辑，无需同时运行。

- **体检与资源：** 查看 CPU、内存、磁盘、GPU、功率、进程排行、检查证据和报告。
- **Agent 管家：** 查看 Hook 活动累计统计、会话轨迹、工具与协作记录，以及 AgentSight 提供的会话、Token、中断和调用延迟。
- **云端巡检：** 显式提供 SysOM 凭据后上传本次资源快照，查看云端结论与报告。
- **本机查询：** 其他受信程序通过只读 HTTP API 获取已有缓存，不触发采集或执行操作。

**缺失数据不等于零，空列表不等于健康。** 设备接入、研发运维、日志分析和部分 GPU 案例属于演示，不代表已接入远端系统。

## 阅读入口

| 你想做什么 | 阅读位置 |
| --- | --- |
| 安装并开始使用 | 本文“安装与首次运行” |
| 理解所有页面、指标和操作 | [功能指南](./docs/FUNCTION-USER-GUIDE.md) · [浏览器阅读版](./docs/FUNCTION-USER-GUIDE.html) |
| 在 IDE 中使用 | [IDE 插件说明](./sysagent-ide-extension/README.md) |
| 让脚本读取结果 | [本机只读 HTTP API](./docs/LOCAL-HTTP-API.md) |
| 从源码构建或维护交付件 | [打包说明](./docs/PACKAGING.md) · [开发说明](./docs/DEVELOPMENT.md) |
| 理解采集与接口边界 | [技术设计](./docs/SYSAGENT-IDC-OPENAPI-DETAILED-DESIGN.md) |

## 环境与组件

| 场景 | 要求 |
| --- | --- |
| 桌面运行 | Linux x86_64 图形桌面、glibc 2.38+；建议 Ubuntu 24.04 x64 |
| IDE 运行 | VS Code API 1.85+ 兼容宿主，例如 VS Code、Qoder IDE；Qoder Desktop 独立应用和 JetBrains 不支持该 VSIX |
| 系统资源与进程操作 | 本机已安装含 `idc_inspect` 的 sysAK，当前用户可执行；进程操作还需 Python 3.9+ 和 Linux pidfd 支持 |
| AgentSight 诊断 | 配套独立运行时，或明确配置的可用本机 AgentSight API |
| Qoder Hook 插件运行 | 支持插件 Hook 的 Qoder 宿主、Linux、`python3 >= 3.6`，仅使用 Python 标准库 |
| deb 与 VSIX 构建 | Linux x86_64、Node.js 20+、npm、`dpkg-deb`，预留依赖与打包所需空间 |
| 仅构建 Hook ZIP | Node.js 20+，无需 npm 依赖、Python 或原生组件 |

安装系统 deb 需要管理员授权，日常运行桌面与 IDE 使用普通用户。**不要用 sudo 启动 GUI、禁用沙箱或跳过依赖检查。** 其他发行版需自行核对运行库、驱动与权限。

### 三条独立数据链路

1. **资源与体检：** 当前用户直接运行系统 sysAK `idc_inspect`，本机分析服务解析资源、检查与 GPU 证据。主 deb 不安装系统 sysAK。
2. **Hook 活动：** Qoder 插件写入白名单事件元数据与独立累计数据库；不采集提示词、工具输入输出或对话正文。
3. **AgentSight：** 独立 API 提供已采集的会话、Token、中断、延迟与进程探活。API 可用不代表真实调用采集已开启。

每个宿主有独立资源缓存、巡检设置和查询实例。相同用户环境可以复用 Hook 存储与 AgentSight 来源，但不会自动同步两个宿主的资源快照。

## 安装与首次运行

### 1. 获取并校验完整交付件

使用可信来源的完整构建目录，不要混用不同构建的 deb、VSIX 和校验文件。

```text
release/build-0.2.19/
├── sysagent-idc_0.2.19_amd64.deb
├── gx_0.6.5-2_amd64.deb
├── sysom-agentsight-runtime_0.16.0_amd64.deb
├── sysagent-ide-0.2.19.vsix
├── sysagent-qoder-plugin-0.2.19.zip
├── sysagent-qoder-ide-plugin-0.2.19.zip
├── agentsight-runtime/
├── install-debs.sh
├── SHA256SUMS
├── LICENSE
├── THIRD_PARTY_NOTICES
└── FONT_LICENSE
```

在该目录打开终端，执行 `sha256sum --check SHA256SUMS`。校验失败时不要安装；校验只确认文件完整性，不能代替可信来源验证。

### 2. 安装桌面与配套件

先彻底退出正在运行的 SysAgent 客户端，再以日常使用应用的普通用户执行：

```bash
sh ./install-debs.sh
sysagent-idc
```

安装脚本请求管理员授权，用一次 `dpkg --install` 按 **GX → AgentSight runtime → 主 SysAgent** 顺序安装三个本地 deb，不联网补齐依赖、不自动回滚。缺依赖时由管理员补齐后重跑入口，不要只安装主 deb。也可从应用菜单打开“SysAgent管家”。

GX 提供 GPU 原生运行时，AgentSight runtime 提供独立 Agent 诊断来源。主 deb 包含桌面、控制器和 AgentSight 采集控制辅助服务；**不安装、不下载系统 sysAK**。安装不会自动开启主机级 Agent 调用采集。

### 3. 准备系统资源来源

资源采集使用本机已安装、组件完整的 sysAK，解析顺序为：

```text
SYSOM_SYSAK_BIN → /usr/bin/sysak → /usr/local/bin/sysak → PATH
```

需要可执行的 sysak、可读的 `tools/idc_inspect` 与匹配规则。找不到二进制时报 `SYSAK_NOT_FOUND`，缺组件时报 `SYSAK_COMPONENT_MISSING`；管家会停止该次采集，不联网下载组件、不以演示数据替代。

包内私有 sysAK bundle 供 AgentSight 采集控制核对使用，不是资源采集来源。`sysom-idc.service` 只承担 AgentSight 采集控制，不是资源采集的前提。

### 4. 在 IDE 中使用（可选）

在命令面板选择 **Extensions: Install from VSIX… / 扩展: 从 VSIX 安装…**，选择交付目录中的 VSIX，按提示重载 IDE。VS Code 也可执行：

```bash
code --install-extension ./sysagent-ide-0.2.19.vsix
```

点击状态栏 SysAgent，或执行 **SysAgent管家: 打开体检主页**（`sysagent.openHome`）；`sysagent.inspect` 提供巡检入口。无需同时启动桌面应用。插件读取本地扩展宿主机器，不自动诊断 SSH 远程工作区。

仅需 IDE 内 AgentSight 诊断时，可以安装 runtime deb 与 VSIX，不安装桌面主 deb。此方式不建立主机级采集控制服务；系统资源仍需宿主机器上的完整 sysAK。详见[IDE 说明](./sysagent-ide-extension/README.md)。

### 5. 查看第一份结果

1. 打开体检首页，先看采样时间、可用资源与未检查项，再看评分。
2. 从资源“详情”查看进程 Top10，按名称或 PID 搜索，或筛选 Agent。
3. 进入 Agent 管家，刷新诊断；Hook 与 AgentSight 各自缺失时，分别查看“数据接入”的原因。
4. 查看逐卡 GPU 资源；原生 GPU 检查和作业证据需按需执行，资源刷新不等于深度检查。
5. 导出已有报告；刷新失败保留的结果会标为旧结果，应按原采样时间理解。

关闭或最小化桌面主页会收起为悬浮小管家。单击恢复、拖动调整位置，右键选择“退出”才会彻底退出。退出宿主停止该实例的巡检与查询服务，不自动停止独立 AgentSight 服务。

## 功能与数据口径

### 体检、资源与功率

首页展示当前资源、评分、检查状态、已有证据与巡检配置。巡检周期为 1–1440 分钟，默认 5 分钟，每个宿主独立保存；暂停或退出宿主停止本实例巡检。

- CPU 排行是进程占整机 CPU 的份额；内存是 RSS；磁盘排行是进程读写 I/O 速率（B/s），不是目录占用。
- 能耗展示当前功率（W），不是累计电量（kWh）。CPU 优先使用 RAPL，否则按负载估算；GPU 优先使用传感器，否则按利用率与功率上限估算。
- 能耗详情先列 CPU/GPU 功率及来源，再列进程 CPU 功率估算 Top10；未归因 CPU 功率单独显示，不强行分摊 GPU 或 Session 功率。
- 进程结束只允许当前用户的非受保护进程，必须二次确认与 PID/starttime 复核，发送 SIGTERM，不删文件、不自动强杀，也不保证进程已退出。

未检查、受限、不可用项没有正常结论；高分不能证明全部项目完成。详细公式、单位与操作步骤见[功能指南](./docs/FUNCTION-USER-GUIDE.md)。

### Agent 管家

顶部六张卡片为 **Hook 累计历史**：已记录会话、Hook 事件、提交提问、工具开始、轮次失败、未配对开始。独立 SQLite 累计不受明细轮转、筛选或分页影响；累计不可用显示 `—`，不从最新明细推算全历史。记录启用前已删除的数据无法恢复。

| 视图 | 内容 |
| --- | --- |
| 总体统计 | 活动趋势、事件构成、会话活动排行、工具活动排行、分类统计、需关注问题、调用延迟和进程探活 |
| 会话与明细 | Hook 会话、按时间排列的轨迹、近 24h Agent 汇总、最新事件筛选与只读证据 |
| 工具与协作 | 工具回调、子 Agent、任务与交互、授权、上下文压缩和工具累计表 |
| 会话 | AgentSight 会话、模型、计数、已记录 Token 与关联中断 |
| 中断 | AgentSight 中断类型筛选、只读证据和已有会话跳转 |
| 延迟 | TTFT P95、E2E P95、TPS P50、TPOT P95 与调用样本量 |
| 数据接入 | Hook 与 AgentSight 的独立覆盖状态、时间和限制 |

点击趋势、类别、工具或分类入口筛选**已经取得的最新 Hook 明细**；累计排行不保证相应明细仍保留。列表提供分页，事件、分类与工具表可选每页 5/10/20 条。进程探活支持名称/PID、角色与状态组合筛选，每页 20 条；这些本地操作不追加采集。

Hook 近 24h 汇总最多处理 5,000 条事件和 16 个 Agent，返回最新 200 条明细。AgentSight 使用近 24 小时窗口，进程最多 256、会话最多 500、中断明细最多 200；Token 包含辅助调用和已记录缓存用量，不是费用或会话终身累计。两种来源不跨来源关联 Session ID 或 PID。

## Qoder Hook 插件

Hook 插件与 VSIX、AgentSight 真实调用采集独立，不需要 root、pip、sysAK 或 AgentSight。

1. 校验交付目录的 `SHA256SUMS`。
2. Qoder 独立应用／CLI 导入 `sysagent-qoder-plugin-0.2.19.zip`；Qoder IDE 导入 `sysagent-qoder-ide-plugin-0.2.19.zip`。
3. 在宿主插件界面确认已启用，按提示重载；Qoder IDE 的 Hook 配置需要重启 IDE。
4. 产生正常活动后，在 SysAgent 的 Agent 管家刷新并查看来源状态。生成 ZIP 不等于已安装或启用。

独立变体注册 20 个事件，IDE 变体注册 12 个事件（含通知）。覆盖会话生命周期、提问提交、工具回调、授权、子 Agent 和上下文压缩；独立变体还提供轮次失败、任务、队友空闲、信息补充与压缩完成等事件。事件表见[功能指南](./docs/FUNCTION-USER-GUIDE.md)。

- 只保存 Agent、事件类型与时间、Session/Call ID、工具名、结构化错误类型、中断标志、子 Agent 与模型。**不保存提示词、正文、cwd、工具输入输出或错误文本，不读取会话文件。**
- 只有 `SessionStart` 同步只读查询本机 `/api/v1/summary` 缓存并注入短摘要；查询失败或无缓存不注入。其他 Hook 异步记录，不查询、不注入、不触发采集或付费调用。
- 存储位于 `~/.local/state/sysagent/agent-hooks/`，绝对 `XDG_STATE_HOME` 可改变根目录；明细每 1 MiB 轮转，`history.sqlite3` 独立保存累计。
- 目录 0700、文件 0600。权限、所有权或符号链接不安全时拒绝，不自动修复；失败不阻断 Agent。
- 同一存储下的重复安装使用共享锁与 HMAC 去重，窗口 5 秒、最多 256 项；只存指纹，不存原始载荷。空载荷或去重状态不可用时仍可能重复；窗口内无不同标识的合法相同事件也可能合并。
- Linux `/proc` 祖先进程检查识别 `qoder` 或 `qoder-ide` 的实际宿主标签，不保存进程路径或环境值。事件支持范围仍由各自注册表决定。

## 云端巡检（可选）

默认只在本机采集与分析。仅在明确接受上传范围后，由部署环境注入下列变量；不要把凭据写入源码、配置示例、shell 历史或公开日志。

| 环境变量 | 用途 |
| --- | --- |
| `SYSOM_POP_ENDPOINT` | 必需，SysOM POP 网关地址 |
| `SYSOM_ACCESS_KEY_ID` / `SYSOM_ACCESS_KEY_SECRET` | 必需，访问凭据 |
| `SYSOM_SECURITY_TOKEN` | 可选，STS 临时凭据 |
| `SYSOM_REGION_ID` | 可选，默认 `cn-hangzhou` |
| `SYSOM_DEVICE_ID` | 可选，上报设备标识 |
| `SYSOM_IDC_UPLOAD` | `0` / `false` / `no` / `off` 强制关闭上传 |

sysAK 申请上传地址、上传快照并提交任务，云端生成报告；桌面／IDE 每 3 秒查询任务，最长等待 120 秒，再读取报告。上传包括本次资源、进程与检查证据，不包含 Agent 对话正文。

有云端报告时，首页显示云端结论，“体检报告”打开总体级别、巡检项与实例计数、主机范围及逐项原因。云端正常／建议／警告／错误／严重来自后端规则，**不是本机评分**；“部分完成”不等于全部正常。

上传或查询失败保留本地结果并提示原因。云端结果只存在当前宿主进程内存，不提供历史报告库。公共 HTTP GET 只读已有缓存，永不触发上传或轮询。

## AgentSight 采集与隐私

AgentSight API 可复用已有本机部署，或由配套运行时准备缺失文件并以普通用户启动。启动 API 不生成调用历史，也不覆盖已有用户配置。

真实 eBPF 采集可能捕获主机进程的明文、参数与完整会话并本地保存，不能严格限定进程；敏感或多用户机器应保持关闭。`traceEnabled:false` 不代表历史内容脱敏。仅 trace 服务获得包括 `CAP_SYS_ADMIN` 在内的采集能力，API、GUI、IDE 不获得；回环地址不是多用户鉴权边界。

**采集授权与核对：** 安装入口提供 `--enable-agent-collection` 授权选项。控制器发送 `idc --agent-collection {status|ensure|disable}` 兼容请求，root 辅助服务将其映射到固定 AgentSight 控制脚本，不由 `idc_inspect` 执行。实际采集仍依赖可信安装、普通用户授权、systemd、内核与 eBPF 能力；须核对服务状态和覆盖，不能仅凭安装或 API 连通宣称采集中。

配套运行时提供直接状态检查与停用入口；停用保留数据：

```bash
sudo /usr/bin/python3 -I /usr/share/sysom/agentsight-runtime/agentsight-collection.py status
sudo /usr/bin/python3 -I /usr/share/sysom/agentsight-runtime/agentsight-collection.py disable
```

托管数据库合计 50 MiB 是周期性软清理目标，不是硬配额；WAL、忙锁、空页可能使实际占用超过目标。专用数据目录为 `/var/lib/sysom-agentsight/<UID>`，专用 API 使用回环端口 7397。

自定义部署可用 `SYSOM_AGENTSIGHT_URL`（仅回环 HTTP/HTTPS）、`SYSOM_AGENTSIGHT_BIN`、`SYSOM_AGENTSIGHT_CONFIG`、`SYSOM_AGENTSIGHT_PACKAGE`；文件路径须为绝对路径。鉴权通过 `SYSOM_AGENTSIGHT_TOKEN` 或已有密钥机制提供。已有明确配置优先，勿公开令牌、完整配置或数据库。

## 本机只读查询

桌面与 IDE 各启动随机 `127.0.0.1` 端口，在宿主用户存储目录的 `local-api/<实例 UUID>.json` 写入私有发现文件。受信程序读取自己选定的实例，使用独立 Bearer token 访问；不硬编码端口、不打印 token、不从浏览器绕过 Origin 校验。

提供状态、能力目录、一致快照、摘要、报告、17 个数据集的列表与详情，以及 OpenAPI 3.1 契约。数据集包含资源、排行、检查、GPU、AgentSight、Hook 事件与汇总、任务元数据。GET 只读宿主缓存，不重新读取 spool、不采集、不结束进程、不修改配置，也不代理任意内部路径。完整示例见[本机 HTTP API](./docs/LOCAL-HTTP-API.md)。

## 从源码构建

获取完整源码，在含根 `package.json` 的目录运行 `npm run build`。入口检查清单一致性，准备并校验 sysAK、AgentSight 与 GX 输入，安装子项目 npm 依赖，编译桌面与 IDE，并生成上述完整交付目录。请保留 `vendor/`、隐藏的 `.sysak_components/` 和本地 SDK tarball；无需 Git LFS 或子模块。

```bash
npm run build:desktop           # 三个 deb
npm run build:ide               # VSIX
npm run build:web               # 网页生产构建
npm run build:qoder             # 两个静态 Hook ZIP
npm run build -- --skip-install # 已具备依赖时使用
npm run build -- --help
```

`npm run release` 与完整构建使用同一入口。构建使用已提供的原生输入，不重新编译完整上游 SysAK、AgentSight、GX 或 coolbpf；不生成 AppImage、不安装系统服务、不启用采集、不结束进程、不上传发布件。Electron 镜像可通过 `ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR` 指定，不修改全局配置。

### 开发与检查

```bash
npm run build:web
npm run dev
npm run preview
npm test
npm run test:api
npm run check:versions
npm --prefix sysagent-idc test
```

`dev` 为网页热更新，`preview` 查看网页构建；桌面开发使用 `npm --prefix sysagent-idc run dev`。**开发网页挂载真实控制器，不是隔离演示：刷新会采集，有 SysOM 凭据会上传。** 仅查看 UI 时不要注入云凭据，必要时设 `SYSOM_IDC_UPLOAD=0`。

根测试、API 测试、应用测试的范围不同，不能互相替代。应用 `health-score` 测试依赖未随仓库提供的参考夹具，完整测试需先解决该依赖；不要伪造夹具或把失败视为通过。浏览器、原生运行和文档生成检查方法见[开发说明](./docs/DEVELOPMENT.md)。

## 常见问题

| 问题 | 处理方式 |
| --- | --- |
| 提示未找到 sysAK 或缺少组件 | 安装完整系统 sysAK，或用 `SYSOM_SYSAK_BIN` 指向可信可执行文件；主 deb 不代装 |
| Agent API 可用但没有会话 | 检查来源、时间窗口与真实采集状态；API 不产生调用历史 |
| Hook 统计为 `—` | 核对插件启用、实际事件与安全存储；无来源不能当成零 |
| 累计事件很多，但明细少 | 累计独立保存；近 24h 明细与轮转有界，筛选只作用于最新列表 |
| 能耗没有进程数据 | 进程样本或同窗 CPU 数据不足时无法估算，不当作零功率 |
| 本机高分但云端严重 | 两者规则与证据不同，应看项级原因，不互相替代 |
| GPU 资源有值但诊断不可用 | 核对硬件、驱动和执行状态；传感器与 GX 原生诊断是独立能力 |
| GET 后数据不变 | 查询只读缓存；在界面刷新或等待已配置巡检 |
| 端口或鉴权异常 | 重新发现自己的活跃实例；不结束未知进程、不删除配置、不公开凭据 |
| 关闭主页后应用仍在 | 主页收起为小管家，右键“退出”彻底退出 |

反馈时提供系统、宿主、命令与脱敏错误信息，不附私人配置、数据库、令牌或会话内容。

## 源码与许可

| 目录 | 职责 |
| --- | --- |
| `sysagent-idc/` | 共享 React 页面、Electron、采集控制器、内部分析与本机查询 |
| `sysagent-ide-extension/` | IDE 宿主、Webview、状态栏与报告保存 |
| `plugins/qoder/` / `plugins/qoder-ide/` | 两种宿主的 Hook 注册与插件入口 |
| `sysagent-agent-hooks/` | 共享 Python 元数据运行时、累计存储与 adapter |
| `scripts/` | 统一构建、清单同步、原生输入校验与 Hook ZIP 打包 |
| `vendor/` | SysAK、AgentSight 与官方未修改的 GX 构建输入及清单 |
| `sysagent-idc/vendor/` | SysOM SDK 本地依赖包 |
| `docs/` | 使用、对接、开发与打包文档 |

二进制、隐藏组件、规则、manifest 和许可必须完整保留；不能只保留清单或用私人配置替代构建输入。生成的私有 bundle、依赖、缓存与交付目录不作为源码输入。

原创代码采用 [MIT](./LICENSE)。SysAK、AgentSight、GX、Electron、字体与其他第三方组件遵循各自许可，SysAgent 的 MIT 不重新授权它们。分发时保留 [THIRD_PARTY_NOTICES](./THIRD_PARTY_NOTICES)、[FONT_LICENSE](./FONT_LICENSE) 与 [AgentSight LICENSE](./vendor/agentsight/linux-x64/LICENSE)。GX deb 原样再分发；其许可通知与对应源码义务需按上游实际许可核对，不能因 deb 缺少完整许可文件而推断整个 GX 为 MIT。
