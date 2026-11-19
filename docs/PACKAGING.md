# 打包与安装

本文说明交付物、构建入口、安装步骤和权限边界。开发流程见[开发说明](./DEVELOPMENT.md)，IDE 的安装与使用见[插件说明](../sysagent-ide-extension/README.md)。构建命令在仓库根目录执行；安装命令在交付目录执行。

## 交付物与用途

根目录 `npm run build` 与 `npm run release` 使用同一入口 `scripts/build.mjs`，完整目标输出到 `release/build-0.2.19/`：

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

| 交付物 | 用途与边界 |
| --- | --- |
| 主 SysAgent deb | 桌面应用、包内 sysAK bundle 和受限的 AgentSight 采集控制辅助服务；不安装系统 sysak |
| GX deb | 官方未修改的 GPU 原生运行时；真实诊断还取决于硬件与驱动 |
| AgentSight runtime deb | 独立程序与部署辅助工具；安装不等于开启主机级采集 |
| VSIX | VS Code API 兼容 IDE 的面板与状态栏；不内嵌 AgentSight 二进制，不安装系统服务 |
| 两个 Hook ZIP | 分别供 Qoder 独立应用／CLI 和 Qoder IDE 手动导入，记录白名单事件元数据 |
| `agentsight-runtime/` | 独立配套目录，含程序、完整性清单、部署工具与其许可 |
| 安装脚本与校验清单 | 离线安装三个 deb、校验交付目录中的文件 |

标准根入口不生成 AppImage、源码 tarball、离线 HTML 或 `validation.json`。打包不会安装系统服务或插件、开启采集、结束进程、提交代码或上传发布件。

## 构建环境与输入

- 根入口要求 Node.js 20+、npm；开发可使用 Node.js 22 或 24。
- 桌面与 VSIX 原生构建要求 Linux x86_64；桌面打包需要 `dpkg-deb`。网页和静态 Hook ZIP 有独立目标。
- 首次安装 Node 依赖需要网络；已有完整依赖时可用 `--skip-install`。构建输入应完整保留在源码树中。
- `vendor/sysak/linux-x64/` 含 `idc_inspect`。原生目标将其准备到 `sysagent-idc/resources/sysak/` 并校验组件、规则、架构与逐文件摘要；VSIX 构建校验后复制到 `dist/sysak/`。
- `vendor/agentsight/linux-x64/` 与 `vendor/gx/linux-x64/` 提供桌面交付输入，入口核对完整性与主 deb 的精确依赖。
- `sysagent-idc/vendor/alicloud-sysom20231230-3.3.2.tgz` 是云端巡检 SDK 的本地依赖，执行 `npm ci` 时必须在位。

根入口默认通过环境变量选择 npmmirror 的 Electron 与 Electron Builder 下载镜像。可设置 `ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR` 指定镜像，不需要修改 npm 全局配置；镜像不免除完整性和依赖检查。

## 构建入口

```bash
npm run build                 # 完整交付目录
npm run release               # 与 build 相同
npm run build -- --skip-install
npm run build:desktop         # 三个 deb、runtime 目录、安装脚本、许可与校验清单
npm run build:ide             # VSIX、许可与校验清单
npm run build:web             # sysagent-idc/dist/ 网页生产构建
npm run build:qoder           # 两个静态 Hook ZIP 与校验清单
```

也可使用 `npm run build -- --target ide` 选择目标；`--target` 的取值为 `all`、`desktop`、`ide`、`web` 或 `qoder`。原生目标准备 sysAK bundle；网页目标不下载 Electron；Qoder 目标只需要 Node，不安装依赖、不准备 sysAK、不构建前端、不执行 Hook。

单独构建子项目：

```bash
npm --prefix sysagent-idc ci
npm --prefix sysagent-idc run build:deb
npm --prefix sysagent-ide-extension ci
npm --prefix sysagent-ide-extension run typecheck
npm --prefix sysagent-ide-extension run build
npm --prefix sysagent-ide-extension run package
```

IDE 需要桌面子项目的共享依赖与已准备的 sysAK bundle；根 `build:ide` 处理这些前置步骤。子项目 `build` 是编译，`package` 才输出 VSIX。桌面子项目 `build:electron` 按其 Linux 打包目标执行，可能生成 AppImage；它不是标准三 deb 交付入口。

`npm run check:versions` 检查根项目、桌面、IDE 与两个 Hook 插件的清单一致性，`npm run sync:versions` 同步受管理清单与 lockfile；AgentSight 使用独立的运行时依赖标识。共用页面或宿主逻辑需要分别编译桌面与 IDE，不手工修改生成目录。

## 运行依赖与 sysAK 来源

完整本机能力要求 Linux x86_64、兼容图形环境与原生库；配套 AgentSight 要求 glibc 2.38+。主 deb 精确依赖 `gx (= 0.6.5-2)`、`sysom-agentsight-runtime (= 0.16.0)`，并声明 `python3`、`systemd`、`zlib1g`、`libzstd1` 等系统依赖；GX 自身要求 glibc 2.27+。安装辅助服务要求 Python 具备 `os.pidfd_open`（通常 Python 3.9+）及可用 Linux pidfd（通常内核 5.3+）。缺少依赖时由管理员准备，不强制忽略依赖。

系统资源采集以当前普通用户运行系统已安装的 sysak：

```text
SYSOM_SYSAK_BIN → /usr/bin/sysak → /usr/local/bin/sysak → PATH
```

控制器显式注入的 `sysakBinary` 优先于环境变量。指定覆盖路径时只检查该路径，不静默回退。组件目录优先使用二进制 realpath 同目录的 `.sysak_components/`，否则使用 `/usr/local/sysak/.sysak_components/`；必须有可读的 `tools/idc_inspect` 和匹配规则。缺失时返回 `SYSAK_NOT_FOUND` 或 `SYSAK_COMPONENT_MISSING`，不会下载组件。

资源命令为 `sysak idc_inspect --request-id <UUID> -o -`，要求采集协议 `schema_version = "1.1"`、`collection.profile = "inspection"`。包内 bundle 只供采集控制使用，不作为资源采集的二进制来源。主 deb 不安装 sysak，安装成功不保证系统资源采集可用。

## 安装与启动

在交付目录中先完全退出 SysAgent 与使用插件的 IDE；最小化不等于退出。以实际使用应用的普通用户执行：

```bash
sha256sum --check SHA256SUMS
sh ./install-debs.sh
sysagent-idc
```

安装入口请求管理员授权，用一次 `dpkg --install` 按 GX、AgentSight runtime、主 SysAgent 顺序安装三个本地 deb，不联网下载。缺系统依赖时不会自动补齐或回滚，应由管理员补齐后重新执行。不要只安装主 deb。

应用安装到 `/opt/SysAgent管家`，可从 Ubuntu 应用菜单打开“SysAgent管家”。GUI 与 IDE 必须以普通用户运行；运行发布件不需要 Node、npm、Rust 或 Python 开发后端。GUI 启动不下载组件或提权。

VSIX 和 Hook ZIP 分别在相应客户端手动导入；安装 deb 不注册插件。安装完成后启动应用或重载 IDE，不需要同时运行桌面与 IDE。

### 安装产生的系统操作

`sysagent-idc/build/after-install.sh` 在包管理器的 root 安装阶段：

- 校验包内 sysAK 文件白名单、manifest、逐文件 SHA-256、ELF 架构、Python 入口与规范化规则，拒绝不安全所有权、链接或可写路径。
- 设置资源的 root 所有权与普通用户读取／执行权限，不给 sysAK 或应用主程序设置 SUID。
- 运行 GX 辅助程序核对可信文件，为 `/usr/lib64` 注册动态库路径并执行 `ldconfig`；GX 自带的通用 ELF／DWARF 库不加入全局搜索路径。
- 通过 `update-alternatives` 注册 `/usr/bin/sysagent-idc`，部署受限辅助服务与普通用户 UID 授权。仅在有效授权 UID 存在、systemd 处于 running／degraded 时启动该辅助服务；其运行不代表 AgentSight trace 已开启。
- 仅对安装目录内的 `chrome-sandbox` 设置 root 所有权和 `4755` 权限，并刷新桌面菜单及图标缓存。

不要用 sudo 启动 GUI／IDE，不禁用 Chromium 沙箱、AppArmor 或完整性校验，不递归设置 SUID。Dock 图标匹配要求 `StartupWMClass` 与窗口 WM_CLASS 均为 `sysagent-idc`；缓存未刷新时可注销后登录。

## AgentSight 主机级采集：授权与限制

默认安装不启用主机级真实调用采集。资源采集、普通 AgentSight API 服务和主机级 trace 是不同链路；API 可用、出现已有数据或安装成功都不能证明 trace 正在采集。

安装脚本提供显式授权参数 `sh ./install-debs.sh --enable-agent-collection`，要求通过 sudo 提供普通用户身份，或显式设置 `SYSOM_IDC_UID`。它表达主机级采集的授权意图，不能作为启用成功的证据。控制器发送 `idc --agent-collection {status|ensure|disable}` 兼容请求，root 辅助服务将其映射到固定 AgentSight 控制脚本，不由 `idc_inspect` 执行。应核对可信安装、授权、systemd、内核能力、真实服务状态与数据覆盖，不以安装或 API 连通推断采集成功。

评估主机级采集时必须理解：

- 可能捕获其他进程的明文、参数和完整会话并保存到本地。Agent 匹配规则不是严格进程隔离；多用户或敏感主机应保持关闭。
- `traceEnabled:false` 不代表本地数据库已脱敏。回环 AgentSight API 不应当作多用户鉴权隔离边界。
- 托管方案的 trace 服务具有 eBPF／perf 所需 capabilities，包含权限较大的 `CAP_SYS_ADMIN`；API、桌面和 IDE 不获得此能力。
- 托管数据目录为 `/var/lib/sysom-agentsight/<UID>`，API 使用回环端口 7397；普通独立部署使用 7396。显式独立部署优先，已有用户配置不由应用改写。
- 托管数据库合计 50 MiB 是周期性软清理目标，不是硬配额；WAL、忙锁与空页会使占用超出。该目标不适用于 Hook 的独立累计数据库。
- 退出 GUI／IDE 不等于停用独立 trace，停用保留已有数据，不自动发起模型调用。管理员可使用配套工具的 `disable` 操作停用托管采集，并核对实际服务状态。

## Qoder Hook ZIP 的导入与运行

| 客户端 | ZIP | 事件覆盖 |
| --- | --- | --- |
| Qoder 独立应用／CLI | `sysagent-qoder-plugin-0.2.19.zip` | 20 个独立注册事件 |
| Qoder IDE | `sysagent-qoder-ide-plugin-0.2.19.zip` | 12 个事件，含 `Notification` |

ZIP 是事件插件，VSIX 是诊断界面。校验摘要后通过客户端插件界面手动导入对应 ZIP；Qoder IDE 的 Hook 配置不热加载，导入后重启客户端。打包不安装、注册、启用、上传插件或修改用户设置。Hook 要求 Linux、Python 3.6+，仅使用标准库。

两个 ZIP 都直接以插件文件作为根布局：

```text
.qoder-plugin/plugin.json
hooks/hooks.json
bin/sysagent_hook.py
lib/sysagent_hooks/
LICENSE
```

静态打包器使用纯 Node ZIP32 实现，不调用外部打包命令或网络；固定条目时间与权限，相同源内容产生相同 ZIP。只选插件文件与共享 Python 源码，排除测试、缓存、依赖、用户设置、凭据和 spool，拒绝所选路径中的符号链接。两个变体先完成校验与内存生成再写出；IDE 变体校验事件与命令字段、显式 1–30 秒超时和非阻断命令结尾。

插件只记录 metadata-only 白名单字段，不保存正文、提示词、`cwd`、`tool_input`、`tool_output` 或错误正文。只有 `SessionStart` 同步查询本机 `/api/v1/summary` 缓存并注入短摘要；其他 Hook 为异步。缓存 GET 不触发采集或上传，摘要可能过期，失败不阻断 Agent。

共享 spool 为 `~/.local/state/sysagent/agent-hooks/`，绝对路径 `XDG_STATE_HOME` 可覆盖基目录。目录／文件为 0700／0600；不安全权限、所有权和符号链接被拒绝，运行时不修权限。明细 `events.jsonl` 达到约 1 MiB 时轮转为 `events.1.jsonl`；`history.sqlite3` 独立持久累计，不受明细轮转影响，也不受 AgentSight 的 50 MiB 软目标管理。

Qoder 独立应用与 IDE 的用户级插件可能重复启用。共用同一 spool 的运行时在文件锁下按 Agent 家族、原生事件及非空载荷进行 HMAC 指纹去重：私有 `.dedup-key` 为 32 字节，`.dedup` 最多 256 项、窗口 5 秒，只在记录追加后提交身份，不保存载荷正文。密钥或账本不可用时不修权限，允许继续记录，因此可能重复；空／无效载荷和不同 spool 不去重。同一窗口内完全相同且无独立发生标识的合法事件也无法区分。

Linux `/proc` 的有界父进程识别使用可信可执行名称 `qoder`／`qoder-ide` 标注实际宿主；无法识别时保留插件标签，不保存可执行路径或环境值。去重不扩大各插件的注册范围，也不关联 AgentSight Session ID／PID。无 Hook 数据时来源显示不可用，不影响 AgentSight 五项覆盖。

## 检查与许可

维护者准备好依赖后可执行以下检查；结果应独立判断，不以打包成功替代运行能力核对：

```bash
npm test
npm run test:api
npm run check:versions
npm --prefix sysagent-idc test
sh -n sysagent-idc/build/after-install.sh
npm --prefix sysagent-ide-extension run typecheck
```

组包后在交付目录使用 `dpkg-deb --info` 检查三个 deb 的依赖与架构，并执行 `sha256sum --check SHA256SUMS`。测试依赖与限制见[开发说明](./DEVELOPMENT.md#测试与调试)。

原创代码采用 MIT；交付时保留 `LICENSE`、`THIRD_PARTY_NOTICES`、`FONT_LICENSE`。VSIX 内含 `LICENSE.txt`、第三方声明与字体许可。AgentSight、sysAK、GX、字体和依赖保持各自许可，SysAgent 的 MIT 不对第三方重新授权。完整性校验、构建成功或硬件识别不等于许可审查或硬件功能认证。
