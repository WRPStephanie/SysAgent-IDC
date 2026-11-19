# SysAgent 管家 IDE 插件

扩展标识为 `sysagent-local.sysagent-ide`。插件在 IDE 面板与状态栏展示本机资源、体检、GPU 和 Agent 诊断，与桌面应用共用页面与分析逻辑；不提供系统桌面悬浮窗口，不需要同时启动桌面应用。

## 能力与数据来源

| 功能 | 数据来源与边界 |
| --- | --- |
| 本机资源与体检 | 当前用户运行系统 sysak `idc_inspect`；部分覆盖或未知不等于正常 |
| CPU／内存／磁盘与功率排行 | 已采集样本，支持名称／PID 搜索和 Agent 白名单筛选；不是全部系统进程 |
| 确认结束进程 | 复核 PID + starttime、当前用户权限和快照，确认后 SIGTERM；不清理文件或 Session |
| GPU 诊断 | sysAK AI／GX 与设备遥测；硬件、驱动及权限影响实际可用性 |
| Agent 管家 | Hook 独立累计／事件元数据与 AgentSight 会话、Token、中断、延迟、进程探活 |
| 云端巡检 | 显式提供环境凭据后上传与查询报告，可强制关闭上传 |
| 本机 HTTP API | 17 个只读数据集，查询已有宿主缓存，不触发采集或上传 |

插件面向扩展宿主机器，不自动诊断远程工作区。设备、远端、运维部署及部分日志页面中的演示对象不是本机真实证据，不提供真实远程执行、自动部署或自动修复。

## 安装前准备

- Linux x86_64；配套 AgentSight 要求 glibc 2.38+，其他发行版需核对原生依赖。
- IDE 要求 VS Code API 1.85+，支持 VS Code、Qoder IDE 等兼容宿主。Qoder 独立应用和 JetBrains 不支持该 VSIX；Hook ZIP 是不同的事件插件。
- 系统资源另需系统已安装含 `idc_inspect` 的 sysak，当前用户可执行，采集协议为 schema 1.1。主 SysAgent deb 不安装 sysak。
- 完整系统安装要求 systemd、Python 的 `os.pidfd_open`（通常 Python 3.9+）和可用 Linux pidfd（通常内核 5.3+）；辅助服务只供 AgentSight 采集控制，不是资源采集前提。
- 使用交付物不需要 Node、npm、Rust 或开发后端。安装 deb 需要管理员授权；IDE 必须以普通用户运行。

完整交付目录为 `release/build-0.2.19/`，包含三个 deb、VSIX、两个 Hook ZIP、`agentsight-runtime/`、`install-debs.sh`、`SHA256SUMS` 和三份许可文件，详见[打包说明](../docs/PACKAGING.md)。标准根入口不生成 AppImage、源码 tarball 或 `validation.json`。

## 安装与打开主页

先完全退出 SysAgent 与使用插件的 IDE；最小化不等于退出。在交付目录中，以实际使用插件的普通用户执行：

```bash
sha256sum --check SHA256SUMS
sh ./install-debs.sh
```

脚本通过管理员授权，用一次 `dpkg --install` 按 GX → AgentSight runtime → 主 SysAgent 顺序安装：

```text
gx_0.6.5-2_amd64.deb
sysom-agentsight-runtime_0.16.0_amd64.deb
sysagent-idc_0.2.19_amd64.deb
```

安装不联网下载，不自动补齐系统依赖或回滚；失败时由管理员准备依赖后重新执行，不只安装主 deb。主包提供桌面与受限采集控制服务，runtime 提供独立 AgentSight，GX 提供 GPU 原生运行时。安装不会开启默认主机级 trace，也不会注册 IDE 或 Hook 插件。

在 IDE 命令面板选择 **Extensions: Install from VSIX…／扩展: 从 VSIX 安装…**，选择 `sysagent-ide-0.2.19.vsix`，按提示重载。VS Code 也可在交付目录执行：

```bash
code --install-extension ./sysagent-ide-0.2.19.vsix
```

点击状态栏 SysAgent 入口，或执行 **SysAgent管家: 打开体检主页**（`sysagent.openHome`）；命令 `sysagent.inspect` 执行实际巡检。插件状态栏显示已知项评分或采集不可用；已采集资源跨过 90% 阈值时提示告警，不代表业务故障已被确认。未知项不参加完整健康保证。

只需 Agent 诊断时，可单独安装 `sysom-agentsight-runtime_0.16.0_amd64.deb` 后安装 VSIX；这不提供系统 sysak、GX 或主包辅助服务。资源与受控进程仍要求系统 sysak，GPU 原生诊断还要求适用的 GX 与驱动。

## 资源、体检与安全操作

系统 sysak 查找顺序：

```text
SYSOM_SYSAK_BIN → /usr/bin/sysak → /usr/local/bin/sysak → PATH
```

显式覆盖只检查指定路径，不静默回退；宿主注入的 `sysakBinary` 优先。组件取二进制 realpath 同目录的 `.sysak_components/`，否则 `/usr/local/sysak/.sysak_components/`，要求可读 `tools/idc_inspect` 与匹配规则，缺失不联网下载。VSIX 虽内嵌 sysAK bundle，但它只供采集控制，不作为资源采集的二进制来源。

资源与体检以当前用户运行，不经 root helper。可设置采集启停及 1–1440 分钟巡检周期；桌面与 IDE 的设置和快照各自独立。系统资源和一般推荐为只读，不自动优化、修复、清理文件或 Session。

在资源排行中按名称／PID 搜索、切换“全部程序／只看 Agent”，选择最多 10 个允许结束的进程。确认流程复核 PID + starttime、所属用户、受保护状态和快照，生成有效期 60 秒的一次性 token；确认后调用 sysAK 的受控 SIGTERM，不自动 SIGKILL。身份变化、快照变化、超时或响应不完整时刷新核对，不重复操作。该行为可能中断真实任务，不允许用 sudo 启动 IDE 来扩大权限。

“能耗”页面显示 **W（功率）**，不是 Wh／kWh 或完整整机能耗。CPU 优先 RAPL，否则使用 `busy × (5 W × 可见逻辑核数)`；GPU 逐卡优先功率传感器，否则使用核心利用率比例乘有效功率上限或默认每卡 150 W。缺失遥测不补零，可通过 `SYSAGENT_CPU_FULL_LOAD_WATTS`／`SYSAGENT_GPU_FULL_LOAD_WATTS` 在分析宿主环境校准模型参考，不覆盖传感器。

CPU 进程 Top10 按其占整机忙碌 CPU 的份额估算，不是逐进程实测；未归因 CPU 单独列出，不强行分摊剩余功率。GPU 不分摊到进程，也不推断 Session 独占 CPU／GPU。重复读缓存不生成连续能量样本。模型与覆盖细节见[开发说明](../docs/DEVELOPMENT.md#cpugpu-功率与进程估算)。

未取得资源采集快照且未识别到 GPU 时隐藏 GPU 入口；真实采集模式保留入口以展示硬件、执行与不可用状态，资源项以实际证据为准。`SYSOM_GPU=0|1` 仅控制宿主可见性，不证明硬件诊断能力。硬件、驱动、遥测缺失或短窗口诊断不完整时，应结合覆盖状态阅读，不把空列表当作无故障。

## Agent 管家：七个视图

顶部六张卡为 **Hook 累计统计**：已记录会话、Hook 事件、提交提问、工具开始、轮次失败、未配对开始。累计由 `history.sqlite3` 独立持久保存，不从最新明细重算，不受明细轮转、筛选或分页影响。不是近 24h 的 AgentSight 会话／Token KPI；未被记录的活动不在累计范围内，缺失显示 `—`。

| 视图 | 如何使用 |
| --- | --- |
| 总体统计 | 阅读 Hook 累计趋势、事件构成、会话／工具活动排行和分类表；查看归组问题、延迟对比与进程探活，点击跳转已有证据 |
| 会话与明细 | 查看 Hook 会话、升序轨迹、近 24h 汇总与最新事件；按 Agent、事件类型、分类或元数据搜索，打开只读证据 |
| 工具与协作 | 查看工具开始／结束／失败／显式中断与累计未配对，以及子 Agent、任务交互、授权和压缩事件 |
| 会话 | AgentSight 会话与来源已记录 Token，按 Agent／ID／Model 本地搜索，按最后活跃排序，展开关联中断元数据 |
| 中断 | 按类型筛选、翻页、打开九字段只读证据；仅在报告已有关联时跳转会话，不修改处理状态 |
| 延迟 | 切换 E2E P95／TTFT P95／TPS P50 对比，阅读调用数与 TPOT P95 等；仅统计完整调用，TTFT／TPOT 仅适用于流式调用 |
| 数据接入 | 查看 Hook 独立覆盖和 AgentSight 进程、会话、中断、计数、延迟五项覆盖，不自动安装或启用来源 |

Hook 近 24h 明细输入最多 5,000 个事件、16 个 Agent，最新列表最多 200 条。分类统计、工具统计和事件页可选每页 5／10／20 条；Hook 会话与 Agent 汇总每页 5 条、轨迹每页 8 条，AgentSight 会话／中断／延迟表每页 20 条、延迟图每页 8 条，进程探活每页 20 条。筛选、分页与证据跳转只处理已取得数据，不追加采集、不改变累计或全窗口统计；累计多于明细是正常的数据范围差异。

AgentSight 会话、Token 和延迟使用近 24h 窗口并包含辅助调用；输入 Token 已含缓存用量，不重复计算。未报告 usage 可能记录为 0，不能保证完整消耗；列表截断时完整总数未知。Hook 不提供 Token、调用延迟或健康分数，也不与 AgentSight Session ID／PID 跨来源关联。

报告缓存只复用 60 秒内结果，手动刷新绕过缓存；失败保留上次报告并明确标记刷新失败，更新中也注明尚未更新。正常 CLI 无端口不算探活故障，HTTP 响应不是业务健康结论；未配对开始不等于卡死，工具失败或授权拒绝也不直接等于故障。空列表、来源不可用或部分覆盖不能证明健康。

## 接入 Qoder Hook 元数据

VSIX 只提供诊断界面；记录 Qoder 活动需在相应客户端另外手动导入 Hook ZIP：

| 客户端 | 导入文件 | 注册范围 |
| --- | --- | --- |
| Qoder 独立应用／CLI | `sysagent-qoder-plugin-0.2.19.zip` | 20 个事件 |
| Qoder IDE | `sysagent-qoder-ide-plugin-0.2.19.zip` | 12 个事件，含 `Notification` |

校验后通过插件界面导入；Qoder IDE 的 Hook 配置不热加载，导入后重启。安装 VSIX 或 deb 不自动注册 Hook。运行要求 Linux、Python 3.6+，只使用标准库；无 Hook 事件时该来源不可用，不影响 AgentSight 五项覆盖。

两者共有 SessionStart／SessionEnd、UserPromptSubmit、PreToolUse／PostToolUse／PostToolUseFailure、PermissionRequest、Stop、SubagentStart／SubagentStop、PreCompact 和 Notification。独立应用／CLI 还注册 PermissionDenied、StopFailure、TaskCreated／TaskCompleted、TeammateIdle、Elicitation／ElicitationResult 和 PostCompact。事件覆盖按各自宿主注册范围判断，不推断 IDE 支持全部事件。

插件只记录 metadata-only 白名单，不含正文、提示词、cwd、工具输入输出或错误正文。只有 `SessionStart` 同步查询本机 `/api/v1/summary` 缓存并注入短摘要，其他 Hook 均异步；查询不触发采集或上传，摘要可能过期，失败不阻断 Agent。

spool 默认为 `~/.local/state/sysagent/agent-hooks/`，绝对 `XDG_STATE_HOME` 可覆盖基目录。目录／文件为 0700／0600；不安全权限、所有权和符号链接被拒绝，运行时不修权限。明细约 1 MiB 轮转，独立累计库不受轮转或 AgentSight 的容量软目标管理。

Qoder 独立应用与 IDE 的用户级插件可能重复启用。共用同一 spool 的运行时在锁下按 Agent 家族、原生事件与非空载荷进行 HMAC 指纹去重，窗口 5 秒、最多 256 项，身份在追加记录后提交；私有账本和密钥不保存载荷正文。空／无效载荷、不同 spool、不可用账本可能重复，同一窗口内完全相同且无独立发生标识的合法事件也无法区分。Linux `/proc` 有界父进程识别标注实际 `qoder`／`qoder-ide` 宿主，无法识别时保留插件标签，不保存执行路径或环境值。

## AgentSight 部署与主机级采集限制

插件复用可用 AgentSight API，或从独立配套件准备缺失文件并启动普通 `agentsight serve`。默认用户目录为 `~/.local/share/sysom/agentsight/`，绝对 `XDG_DATA_HOME` 可覆盖；相同 HOME／XDG 的桌面和 IDE 共享数据目录。已有配置、二进制与数据不由启动流程覆盖，显式独立部署优先。

需要指定独立部署时，在宿主启动环境提供 `SYSOM_AGENTSIGHT_BIN`、`SYSOM_AGENTSIGHT_CONFIG`、`SYSOM_AGENTSIGHT_URL`；令牌使用 `SYSOM_AGENTSIGHT_TOKEN` 或已有安全密钥机制。不读取、展示或改写真实用户配置与令牌。

默认不启用主机级真实调用采集。安装脚本的显式授权参数为 `sh ./install-debs.sh --enable-agent-collection`，要求 sudo 普通用户身份或 `SYSOM_IDC_UID`；**不能将该参数视为采集已启用**。控制器发送 `idc --agent-collection {status|ensure|disable}` 兼容请求，受限辅助服务将其映射到固定 AgentSight 控制脚本，不由 `idc_inspect` 执行。可信安装、授权、systemd、内核与 eBPF 能力决定实际可用性；API 服务可用、存在已有记录或 bundle 校验成功都不是 trace 可用的证据。

评估主机级采集时，应明确接受明文、参数和完整会话在本地保存的风险。匹配规则不是严格进程隔离，可能覆盖其他客户端；多用户和敏感主机应保持关闭。`traceEnabled:false` 不脱敏本地数据库，回环 API 也不是多用户鉴权隔离边界。

托管方案使用普通 UID 的专用目录 `/var/lib/sysom-agentsight/<UID>` 与回环端口 7397，普通独立部署使用 7396。trace 服务具有 eBPF／perf 所需 capabilities，含权限较大的 `CAP_SYS_ADMIN`；API 与 IDE 不获得此能力。托管数据库合计 50 MiB 是周期性软清理目标，不是硬配额，WAL、忙锁与空页可能使占用超出。

退出插件不等于停止独立 trace；停用保留已有数据，不自动调用模型。管理员可使用配套工具停用托管采集：

```bash
sudo /usr/bin/python3 -I /usr/share/sysom/agentsight-runtime/agentsight-collection.py disable
```

该操作不替代对实际服务状态的核对，也不用于强制停止显式指定的其他部署。完整安装与权限约束见[打包说明](../docs/PACKAGING.md#agentsight-主机级采集授权与限制)。

## 云端巡检与本机 API

提供 `SYSOM_POP_ENDPOINT`、`SYSOM_ACCESS_KEY_ID`、`SYSOM_ACCESS_KEY_SECRET` 后进入云端模式，sysAK 完成上传步骤 1–4，扩展宿主执行步骤 5：每 3 秒查询任务，最长 120 秒，到终态后取报告。可选 `SYSOM_SECURITY_TOKEN`、`SYSOM_REGION_ID`、`SYSOM_DEVICE_ID`；凭据不写入源码、配置、界面、日志或发布件。

`SYSOM_IDC_UPLOAD=0|false|no|off` 强制关闭上传，不关闭本地资源采集。上传失败仍提供本地结果；有云端报告时“体检报告”打开云端弹窗，展示级别、项目、主机与窗口范围和逐项原因。云端级别不是本机评分，`partial_completed` 不表示全部正常。报告只存扩展宿主内存，退出或重载后不作为持久报告保留。

公共回环 `/api/v1` 使用独立只读 Bearer token 和私有发现文件，提供 status、summary、report、snapshot、capabilities、契约与 17 个数据集，包括 `agent-hook-events`、`agent-hook-agents`。查询只读已有宿主缓存，不补采、不上传、不轮询、不执行进程操作。令牌与发现文件不能公开，空查询结果不等于健康。接口用法见[本机 HTTP API](../docs/LOCAL-HTTP-API.md)。

## 日常排错

- **系统资源不可用**：区分“未找到已安装的 sysAK”和“缺少 idc_inspect 组件”；由管理员准备系统 sysak，不把 VSIX 内 bundle 当作资源来源，不让应用下载缺失组件。
- **AgentSight 配套件缺失**：准备 runtime deb 后重载 IDE；API 可用但没有调用记录时看独立采集状态与覆盖，不自动开启 trace。
- **Hook 无数据**：确认对应宿主的 Hook 插件已手动启用、客户端已重启、事件确实发生且 HOME／XDG 指向同一私有 spool；不要修宽权限或公开内容来排错。
- **云端无报告**：确认宿主是否通过安全机制得到所需环境变量，是否显式关闭上传，以及上传／任务进度；不输出密钥或完整配置，本地报告仍可使用。
- **鉴权、端口或启动冲突**：检查既有部署，不删除用户配置、不结束未知进程、不公开 token。`sysom-idc.service` 仅是采集控制服务，不是系统资源采集前提。
- **库或 pidfd 缺失**：由管理员准备兼容依赖；不强制忽略依赖、禁用沙箱、修改免密规则或绕过完整性校验。
- **刷新失败**：页面保留上次报告并注明失败，不把该报告当作已更新状态；空或部分证据不能推断健康。
- **进程确认失效**：重新获取快照、选择与确认；响应不完整时先核对任务，不能重复结束。

## 开发与许可

在仓库根目录执行 `npm run build:ide` 可准备共享依赖、校验 sysAK bundle 并输出 VSIX；独立子项目的 `npm run typecheck`、`npm run build`、`npm run package` 分别用于类型检查、编译与打包。根 `npm run build`／`npm run release` 生成完整交付目录。共用页面与宿主逻辑应分别构建桌面与 IDE，不手改生成目录。

开发网页 `demo-api.ts` 是真实控制器，会采集，有完整凭据时会上传，不是隔离演示。开发测试中的 `health-score.test.cjs` 依赖未提供的参考夹具；完整开发流程与测试约束见[开发说明](../docs/DEVELOPMENT.md)。

原创代码采用 MIT。VSIX 含 `LICENSE.txt`、`THIRD_PARTY_NOTICES`、`FONT_LICENSE`，源码与交付目录保留对应许可声明。sysAK、AgentSight、GX、字体与依赖保持各自许可，不由 SysAgent 的 MIT 重新授权。
