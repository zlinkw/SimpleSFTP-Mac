# SimpleSFTP

SimpleSFTP 是一个 Windows VS Code 扩展，用于在本地项目和远端 Linux 项目目录之间同步代码、轻量结果和 Agent runtime。本地与远端之间使用系统 `ssh` 和 `tar` 流传输，Worker 之间支持分区并行的 tar 流同步，也不会保存云凭据。

`sync.serverToServerFpsync` 按指定路径比较两端 SHA256，仅传变化文件。稳定文件先取 size/mtime，读完后核对身份；发现变化才退避等待，首次 0.25 秒、最多 1 秒，总时限 15 秒。普通批次同时限制为 80 文件、512 MiB 和命令元数据大小；显式合并传输可跨 Plan 合并文件，但仍受 512 MiB 与元数据界限约束。最多两路流；全局最多两个传输，每个 Worker 最多一个，不同 Worker 可以独立推进。归档内容持续流式处理，不在内存中缓存整个批次。进度中的 completedFiles/totalFiles 与 completedGroups/totalGroups 是整次请求成功完成的文件/分组数，独立于当前 child 的 processedFiles 阶段计数，后续解包不会清零。任一路失败后停止启动新组，等待已启动的资源结算，不报整批完成。`sync.serverToServerBatch` 与 `sync.serverToServer` 的非删除路径复用该实现。无需安装 fpsync，不落盘中间压缩包；目标端独有旧文件只提供精确清理预览，删除仍需单独两次确认。

SimpleSFTP 与 [SimpleExperiment](https://github.com/zlinkw/SimpleExperiment) 配套使用。SimpleExperiment 负责服务器状态和实验调度；SimpleSFTP 只负责真实文件传输。

## 主要能力

- 创建或打开远端项目对应的本地工作区。
- 远端到本地同步；可按服务器选择远端文件或文件夹，并限制文件类型和大小。
- 全量上传、指定文件上传、manifest 受控同步。
- 可选的保存后增量上传。
- 共享服务器配置，可从 `~/.ssh/config` 导入。
- 独立的远端下载范围；上传与下载范围分别配置。
- 上传前强制确认本机路径、服务器账号和远端目标路径。
- 本机 JSON-RPC API 和 `simple-sftp-api` CLI，供自动化工具调用。

## 安装

1. 安装最新版 `simple-sftp-<version>.vsix`。
2. 如果使用 SimpleExperiment，也安装其配套版本。
3. 执行 **Developer: Reload Window**。

```powershell
npm run install:latest
```

## 快速开始

### 独立使用

1. 打开本地项目文件夹。
2. 运行命令 **SimpleSFTP: 创建或打开远端项目**。
3. 选择 SSH host 或共享服务器配置。
4. 填写远端项目目录。
5. 在强确认窗口核对本地目录、服务器账号和远端路径。
6. 使用 **远端同步到本地** 或 **上传工作区到目标**。

### 与 SimpleExperiment 配合

通常不需要手工填写 SimpleSFTP 目标。在 SimpleExperiment 中配置 Hub/Worker 后，“准备 Agent 并启动”和运行前同步会把最终解析出的远端项目路径写入共享服务器配置。

推荐顺序：

```text
配置 Xshell 会话
→ 在 SimpleExperiment 填写 Hub/Worker 项目父目录
→ 准备 Agent 并启动
→ 插件生成对应 SimpleSFTP 目标
→ 运行前自动同步代码
```

远端代码目录始终由用户配置计算：

```text
<项目父目录>/<当前工作区名称>
```

例如项目父目录为 `/data/experiments`，本地工作区名为 `my-project`，上传目标是 `/data/experiments/my-project`。不要把当前项目名填成父目录。

## 命令

| 命令 | 功能 |
| --- | --- |
| 创建或打开远端项目 | 选择远端目录并创建本地同步工作区。 |
| 远端同步到本地 | 已设置范围时仅下载所选远端文件；否则使用内置安全排除规则。 |
| 上传工作区到目标 | 上传全量文件或 manifest 指定的受管文件。 |
| 上传指定文件到目标 | 供 API/编排器上传明确文件。 |
| 上传并标记交接 | 上传后写入交接标记。 |
| 设置下载文件范围 | 浏览远端项目，选择允许下载的文件或文件夹，并设置文件类型与大小上限。 |
| 选择服务器 | 切换共享服务器配置。 |
| 导入 VS Code SSH 配置 | 从 `~/.ssh/config` 导入 host/user/port。 |
| 查看当前目标 | 显示当前本地路径、远端路径、host、user 和 port。 |

## 配置

普通用户优先使用面板和共享服务器配置。常用设置：

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `remoteBase` | 空 | 默认远端项目根目录；可为空，调用方显式传入时优先。 |
| `localBase` | 空 | 默认本地项目根目录。 |
| `sshHost` / `execHost` | 空 | 默认 SSH alias；不要填写私密信息。 |
| `userName` | 空 | 默认用户名。 |
| `sshPort` | `22` | 默认 SSH 端口。 |
| `uploadOnSave` | `true` | 保存时上传变更文件。 |
| `connectTimeoutSeconds` | `15` | SSH 建连超时。 |
| `uploadTimeoutSeconds` | `600` | 单次传输整体超时。 |
| `uploadCancellable` | `true` | 进度窗口显示取消按钮。 |
| `workspaceHostRoot` / `workspaceContainerRoot` | 空 | 仅 Dev Container 工作区映射需要。 |

共享服务器配置保存在：

```text
%APPDATA%\SimpleSFTP\server-profiles\servers.json
```

## 同步规则

默认排除 `.git`、IDE 目录、Python 缓存、虚拟环境、构建产物、`node_modules`、数据集、checkpoint、模型权重、日志、输出目录、压缩包和常见二进制数组文件。

旧的“设置跳过文件”和目标级 ignore 配置已移除，插件不再读取 `sftp-target-ignores.json`、调用参数或服务器配置中的自定义 ignore。未设置下载范围时使用内置安全排除规则；设置下载范围后，远端到本地同步只读取所选远端路径中符合扩展名和大小上限的文件。范围按服务器保存到本机项目的 `simple_cluster/sftp-download-scopes.json`。`.git`、`.vscode`、`.codex` 和插件状态目录始终不会进入下载范围。

全量上传不会镜像删除远端文件。manifest 同步采用调用方已确认的文件类型与大小规则，不再根据 `data/` 子目录或文件名重复过滤；仍会阻止路径越界以及 `.git`、`.vscode`、`.codex`、旧插件状态目录。manifest 同步只会清理上一版 manifest 存在、当前 manifest 缺失且通过路径安全检查的受管文件。

新版本状态文件写入 `simple_cluster/`。旧版 `zlk_cluster/code_sync_state.json` 只作为只读兼容来源；发现旧目录时会提示人工核对后手动删除，插件不会自动删除它。

## 文件位置确认

上传、下载、交接和下载范围配置前会显示：

- 本机宿主路径；
- 服务器 label/host/user/port；
- 完整远端目录；
- 文件范围和数量。

选择 **仅本次继续** 只放行当前操作。选择 **此后该路径不再提醒** 只记住完全相同的项目、账号、端口和路径组合；任一条件变化都会再次询问。

API 调用危险动作必须传 `confirm: true`。SFTP 路径动作还需要 `pathConfirmed: true`，或已有精确匹配的免提醒记录。缺少确认时返回 `CONFIRM_REQUIRED`，不会产生副作用。

## 本机 API

扩展启动后监听本机回环端口，默认首选：

```text
127.0.0.1:19766
```

实际地址、token、pid 和版本写入：

```text
%APPDATA%\SimpleSFTP\api.json
```

端点：

- `POST /api/v1/rpc`
- `GET /api/v1/health`
- `GET /api/v1/capabilities`
- `GET /api/v1/openapi.json`
- `GET /api/v1/events`

请求必须带：

```http
Authorization: Bearer <token>
```

CLI 示例：

```powershell
simple-sftp-api status
simple-sftp-api servers.list
simple-sftp-api upload.workspace --json upload.json
```

公开方法以 `/api/v1/capabilities` 的实时返回为准。

`sync.serverToServerFpsync` 支持跨 Plan 的精确文件数组，最多 5000 个安全相对路径。`compression: "auto"` 在源端只读采样最多 8 个文件的分散内容窗口、累计最多 256 KiB，SSH 采样最多 5 秒；比较实测样本压缩字节、CPU/耗时及近期链路吞吐，低收益或 CPU 成本过高时选择 `none`。gzip 总是兼容；zstd 只有两端均检测成功才参与选择，未安装时无需新增依赖。`singleStream: true` 不按 Plan 分包，但仍遵守字节与元数据边界。采样失败安全回退 gzip。吞吐摘要只在内存保留最近 64 个端点组合、15 分钟有效；尚无实测吞吐时使用明确标注的估计，估计耗时不等于实际提速。直接传输和本机中继都遵循同一策略，传后逐文件核对 SHA256。

超过 512 MiB 的单文件独立传输，以 8 MiB SHA256 块连续流式接收，上限 64 GiB；8 MiB 是恢复校验帧，不是每次重建连接的归档大小。重试先验证固定暂存槽中的已完成块，再从缺失位置继续；完整文件 hash 验证后才发布。普通 tar 批次也必须完整接收并验证所有文件后才替换最终路径。远端最多 32 个固定 `.simple-sftp-stage-*` 槽及锁文件；成功 `replace` 消耗数据暂存，保留小型归属/恢复记录并复用闲置槽。损坏、未知所有者和未结算槽不会自动删除或占用。失败/取消不把半成品发布为当前结果，无法证明远端结算时禁止并发重发。

`transfers.reconcile` 核实旧 `sync.serverToServerFpsync` 请求是否已退出。需要原 `operationId/operationInstanceId/requestKey`、相同 `retryMethod` 和只含端点身份的 `retryParams`；capabilities 公布 `transferSettlementReconciliation`。核对本地原实例、传输进程、两端同用户进程和固定接收槽锁，并同时持有两端项目资源租约；权限不足、连接失败、活动进程或锁、身份不符均保持阻止。只有退出证据完整且回执持久化成功才返回 `settled:true`，原失败原因继续保留。该回执只证明旧 writer 已退出，不能证明旧传输成功；后续新请求仍须重新核验 SHA256。核实不删除数据、不发送 kill、不生成远端临时文件，用户无须手工清空未知回执。

`sync.downloadMappedPaths` 一次接收多条源到目标映射。请求需要明确的 `server`、本机安全根 `localPath`，以及 `entries`：每项含远端项目相对路径 `remotePath` 和本机项目相对路径 `localRelativePath`。同一来源可跨 Plan 合并 tar 流，接收校验成功后按映射发布。`compression: "auto"` 在 gzip/none 中按样本选择，`"gzip"` 强制 gzip；省略或 `"none"` 保持无压缩兼容。它不扫描整个项目，也不对每个文件单独发起 SSH。`confirm: true` 和 `pathConfirmed: true` 都是必需的；预览里包含每条映射。`overwrite: true` 才覆盖已有普通文件。`maxFileBytes` 默认 128 MiB。`metricsOnly: true` 只接受 csv/json/md/txt/log，并拒绝权重和检查点。绝对路径、`..`、符号链接、越出项目根、重复目标、把目录当文件，都会在传输前拒绝。失败或取消不报整批成功，不删除已有目标。`sync.downloadPaths` 仍然要求远端相对路径与本机相对路径相同。

指定文件上传时，`remotePath` 是实际目标目录。若同时传入 `server.remotePath`，两者必须一致；不一致时插件会拒绝上传。`target.show`、API 确认预览和实际传输使用同一目标解析逻辑。用服务器名称指定目标时，该名称必须匹配已保存的服务器配置；未知名称不会回退到当前活动服务器。上传前请核对预览中的主机、端口与远端目录。

`memoryOnly: true` 仅返回逐项 SHA256 核验后的 Base64 内容，不创建原始文件、接收槽、结果表或暂存目录；单文件和批次均限 4 MiB，必须提供每项的大小和 SHA256。0.2.60 新增能力 `methodOptions["sync.downloadMappedPaths"].memoryWrapperResults`：配合 `metricsOnly: true, wrapperResults: true`，支持包装器声明的 TSV、JSONL、YAML 和轻量二进制结果在审核页临时展示。该选项只扩展内存接收，权重、检查点、代码、状态和受保护目录继续拒绝，不放宽磁盘下载范围；不支持该能力时客户端应明确报告并保留版本，禁止回退到落盘缓存。

### 清单校验与进度

`sync.projectInventory` 的精确 `scopePaths` 通过 SSH stdin 发送，每次最多 5000 路径、1 MiB；能力 `projectInventoryStdinScopes` 由 live capabilities 公布，旧客户端参数仍兼容。目录遍历只进入请求范围的祖先和子树；SQLite 分批索引读取本次范围的缓存，不载入整个项目历史。复用 SHA256 前核对 dev/ino/size/mtime/ctime、打开的文件身份和最终路径身份；内容或身份变化时重新哈希，缺失与未验证文件不能冒充成功。

清单、哈希、打包、网络传输、解包、复核、发布分别上报进度。`transferredBytes` 只统计实际流字节，控制 JSON、心跳和读取校验字节不混入；本机中继两端共用一个流身份避免重复计数。压缩流在 EOF 前持续转发并报告字节，哈希进度最多每 250ms 更新及阶段结束时补最终计数。既有 gzip/pigz/zstd 自动协商、SHA256 差异同步、背压与断点恢复继续使用，不新增必须安装的工具包，不生成落盘压缩包。

## 故障排查

| 问题 | 处理 |
| --- | --- |
| 连接超时 | 核对 host、port、VPN、防火墙和本机网络。 |
| 认证失败 | 先用系统 `ssh <alias>` 登录测试。 |
| SFTP subsystem 不可用 | 确认服务器允许 SFTP 子系统。 |
| 权限不足 | 确认远端目录存在且当前用户可写。 |
| 上传卡住 | 在进度窗口取消，或用 transfers API 停止；调低大文件并发并检查网络。 |
| 参数过长 | 升级到 manifest/file list 打包版本，并把大型第三方仓库加入 ignore。 |

## 开发

```powershell
npm test
npm run package
```

生成的 `.vsix` 位于仓库根目录。历史发布包不要覆盖。
