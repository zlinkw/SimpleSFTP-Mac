# SimpleSFTP Mac

SimpleSFTP Mac 是 Apple Silicon Mac 的 VS Code 文件传输扩展，与 [SimpleExperiment Mac](https://github.com/zlinkw/SimpleExperiment-Mac) 配套。沿用 SSH/tar 流式传输、路径确认和传输结算职责，扩展身份、设置、配置目录和更新源与 Windows 原版独立。

**当前为 preview 测试版，完整 Mac 传输和认证尚未真机验收。** 已接入本地 POSIX 工作区、中文/空格路径、大小写及独立密钥、ssh-agent、密码和私钥口令；断连恢复与完整科研接入仍在适配。不要套用原 Windows 的使用说明。

## 系统要求与首次安装

- Apple Silicon、macOS 26 及以上；配套使用 VS Code 1.100.0 及以上。
- 本地 file 工作区；Dev Containers 和 Intel Mac 不在首版支持范围。
- 远端 Linux 使用 SSH、tar 和受管 Python 辅助代码。

两个 VSIX 都在 **[SimpleExperiment Mac Releases](https://github.com/zlinkw/SimpleExperiment-Mac/releases)**，公开下载无需 GitHub 登录。

1. 在同一个 preview Release 下载两份 `darwin-arm64.vsix` 附件。
2. 按 **⇧⌘P**，运行 **Extensions: Install from VSIX…**，先安装 `simple-sftp-mac-<版本>-darwin-arm64.vsix`。
3. 再安装 `simple-experiment-mac-<版本>-darwin-arm64.vsix`。
4. 运行 **Developer: Reload Window**，确认扩展身份 `simple-local.simple-sftp-mac` 与 `simple-local.simple-experiment-mac`。

无需运行原 Windows 的 install:latest 脚本。

## 更新按钮入口

| 入口 | 操作 |
| --- | --- |
| **底部右侧状态栏** | 点击 **Mac preview：…**，检查配套更新。 |
| **SimpleSFTP 命令面板 ⇧⌘P** | 运行 **SimpleSFTP Mac：检查 preview 配套更新**。 |
| **SimpleExperiment 命令面板** | 运行 **SimpleExperiment Mac：检查 preview 配套更新**。 |
| **SimpleExperiment 面板 → 设置** | 在 **插件配套更新** 中点击 **检查更新**。 |

SimpleSFTP 的检查入口会激活 SimpleExperiment Mac 并检查两个插件，配套插件未安装时提示首次安装步骤。独立更新入口不需要服务器、Termius 或业务面板成功加载。

发现更新后点击通知中的 **更新并重载**。同一版本只主动提醒一次；关闭通知后，运行 **SimpleExperiment Mac：安装 preview 配套更新**。启动检查一次，此后每 30 分钟检查，只使用 preview 通道。

安装前等待已有本地传输和子进程退出，阻止新业务操作；先下载并校验全部待更新包，再按 **SimpleSFTP Mac → SimpleExperiment Mac** 安装并重载。不会停止远端实验，相同版本跳过，不自动降级。

源不可达或限流显示 **检查失败**，网络恢复后手动重试。部分安装失败显示已完成与待完成组件，选择 **重载后补装** 后只安装剩余组件。

## 文件传输使用说明

### Mac 上先配置目标

1. VS Code 菜单 **File → Open Folder…** 打开本机项目；一个窗口只打开一个项目。
2. 按 **⌘,** 搜索 `simpleSftpMac`。`localBase` 填本机项目父目录，例如 `/Users/实际用户名/Projects`；`remoteBase` 填真实 Linux 项目父目录。初次接入可将 `uploadOnSave` 关闭，先检查目标再手动上传。`workspaceHostRoot` 与 `workspaceContainerRoot` 留空。
3. 按 **⇧⌘P → SimpleSFTP：打开共享服务器配置**。下面示例中的主机、用户名、端口和路径均需替换；多个服务器各有唯一 `id`：

```json
{
  "version": 1,
  "activeServerId": "worker-a",
  "servers": [
    {
      "id": "worker-a",
      "label": "Worker A",
      "host": "你自己的 SSH 主机名或别名",
      "user": "远端实际用户名",
      "sshPort": 22,
      "remotePath": "/data/你的实验父目录",
      "localBase": "/Users/实际用户名/Projects",
      "enabled": true
    }
  ]
}
```

4. 保存后运行 **SimpleSFTP：选择服务器**，然后 **SimpleSFTP：查看当前目标**，核对账号、SSH 端口及完整路径。`sshPort` 填服务器 SSH 端口，不能填 Agent HTTP 转发端口。
5. 已有本机 `~/.ssh/config` 时，可运行 **SimpleSFTP：导入 VS Code SSH 配置** 导入主机描述；不会读取 Termius 私有会话。随后运行 **SimpleSFTP Mac：配置服务器认证**，为每个真实 SSH 目标选择认证方式。选择或导入配置不表示连接测试通过。

设置中的路径使用绝对 POSIX 路径，不填盘符、`~`、`$HOME` 或未替换的用户名。保留中文、空格与大小写，终端中的路径有空格时加引号。完整的本机配置、Termius 手动转发及三拓扑接入约定见 [Mac 配置说明](https://github.com/zlinkw/SimpleExperiment-Mac/blob/master/docs/simple-experiment-setup.md)，配套面板顶部 **配置说明** 也可打开。

本机/远端根目录保留 Unicode 拼写和目录名首尾空格，不解码字面 `%20`。重复 `/` 合并，末尾分隔符去掉；包含 `.`、`..`、反斜杠、控制字符或 Windows 路径会拒绝。`/Data/项目` 与 `/data/项目` 是不同远端目标，确认预览、上传和保存队列保持大小写。只读浏览允许 `/`，创建项目与上传必须使用具体目录。若请求与服务器对象的完整路径不一致，插件报“远端目标冲突”；核对真实目录后修改配置，不删去目录名中的真实空格来绕过检查。

上传清单、Worker 相对文件路径和映射下载也保留中文、大小写、Unicode 拼写及首尾空格。相对路径以项目目录为根，不填绝对路径；拒绝 `..`/`.` 路径段、内部连续 `/`、反斜杠、冒号、控制字符和超过 4096 UTF-8 字节的名称。全部上传条目通过校验后才建立 SSH/tar。远端 `Model/a.json` 与 `model/a.json` 是两项，可分别映射到 `upper.json`、`lower.json`；本机映射仍拒绝只差大小写的目标名以防别名覆盖。tar 解包不删去文件名真实空格，也不将错误条目转换成另一目标。

以上绝对路径、目录浏览、上传清单及映射下载通过本地模拟和真实本地 tar/Python 协议验证；CLI 及完整科研传输继续分批适配，尚无 M5/真实 SSH 验收证据。

### 上传、下载与认证边界

业务适配完成后的操作流程：打开本地项目 → 选择服务器与用户配置的远端目录 → 核对本机路径、账号、端口及完整目标路径 → 上传或下载。SimpleExperiment Mac 负责调度，SimpleSFTP Mac 负责真实传输。

保留命令：**创建或打开远端项目**、**选择服务器**、**查看当前目标**、**上传工作区到目标**、**上传指定文件到目标**、**远端同步到本地**、**设置下载文件范围**、**上传并标记交接**。设置命名空间为 `simpleSftpMac.*`。

在 Mac 按 **⇧⌘P → SimpleSFTP：设置下载文件范围**，核对本机/远端目标后选择 **添加远端文件夹** 或 **添加远端文件**；文件选择保留中文、大小写及真实首尾空格。范围浏览只允许当前远端项目内的路径，手动输入必须是该项目内的完整绝对 POSIX 路径。保存后可 **查看已选远端路径**，再运行 **远端同步到本地**；文件类型和大小上限按保存的规则过滤，选中的符号链接会拒绝下载。

空字符串和非法路径会拒绝保存，不隐式变成整个项目。手动选择 **使用当前目录** 可明确选中项目根目录，预览显示 `.`；未设置任何范围时，原有整项目同步入口继续保留。API `sync.downloadPaths` 则必须提供具体相对文件或目录，拒绝 `.`、`./` 等整个项目别名。移除下载范围只修改配置，不删除文件。下载范围 UI/API、文件名/大小列表和本地 Python 归档通过本地模拟与协议验证，真实 SSH/M5 尚待验收。

### 独立认证入口

按 **⇧⌘P → SimpleSFTP Mac：配置服务器认证**，或在资源管理器 **SimpleSFTP → 配置服务器认证** 中选择已填写的服务器：

| 方式 | 操作 |
| --- | --- |
| 系统 SSH 配置 / 自动 | 沿用本机 OpenSSH 配置及默认密钥；私钥口令由插件密码输入框获取 |
| 选择私钥 | 在 Mac 文件选择框选择真实私钥文件；保留中文和空格路径。加密私钥在首次连接时提示输入口令 |
| ssh-agent | 使用当前 VS Code 进程可见的 `SSH_AUTH_SOCK` 中已加载身份，不转发 agent 到服务器 |
| 密码 | 首次连接时在 VS Code 密码输入框填写该服务器密码，不要求服务器间免密登录 |

独立密钥、agent 和密码模式直接使用服务器实际地址、用户和端口；不要将只能靠 `~/.ssh/config` 解析的别名当作真实主机。需要沿用自己的 SSH 别名/跳板配置时选择自动模式。

认证按实际 SSH 地址、用户名和端口区分，两端分别配置。记忆选项默认不勾选，只在本次扩展会话内记忆；勾选 **使用 VS Code SecretStorage 保存密码 / 私钥口令** 后，输入的凭据才会保存以供重载后使用。选择不勾选时，不读取以前保存的凭据。重新运行配置命令可切换方式和记忆选项。

密码和口令不写入 `servers.json`、项目设置、命令参数或临时文件；SSH 的 tar 标准输入仍只传文件数据。[VS Code SecretStorage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage) 负责已选择保存的凭据。Termius 登录不会自动授权 SimpleSFTP，插件不读取其密码。真实密钥/密码上传下载、连接恢复仍待 M5 验收。

Mac 跨服务器传输分别认证两端，默认经本机 SSH 流式中转，无需服务器之间免密互联。普通 tar 分组和大文件断点分块沿用哈希核对、接收检查点及有限并发；文件流通过本机内存管道传递，不生成本地中转压缩包。失败时等两个本地 SSH 进程退出；远端接收结果不明时须完成恢复核验才可补传，不盲目重试。两端地址、账号、端口及本地/远端路径必须来自用户配置。当前仅通过本地模拟与协议测试，真实跨服务器传输仍待 M5 验收。

上传前的路径确认保留。API 缺少确认返回 `CONFIRM_REQUIRED`。永久删除需要精确目标、直接父目录核验与两次确认，普通上传不镜像删除远端内容。

## 数据目录与 API

| 内容 | Mac 位置 |
| --- | --- |
| 服务器配置 | `~/Library/Application Support/SimpleSFTPMac/server-profiles/servers.json` |
| API 发现文件 | `~/Library/Application Support/SimpleSFTPMac/api.json` |
| 共享租约 | `~/Library/Application Support/SimpleLocalMac/SimpleExperiment/` |

API 方法沿用原契约。地址、token、pid、版本来自当前发现文件，请求需要 Bearer token；每次调用前读取 `/api/v1/capabilities` 或 `/api/v1/openapi.json`，禁止猜端口和参数。

CLI 为 `simple-sftp-mac-api`，保留原 npm 入口。VSIX 在受支持 Mac 激活时生成固定入口，更新并重载后刷新到当前包；终端需要 **Node.js 20 或以上**。按 **⇧⌘P → SimpleSFTP Mac：查看 CLI 入口**，点击 **复制自检命令** 后执行，或直接运行：

```sh
"$HOME/Library/Application Support/SimpleSFTPMac/cli/simple-sftp-mac-api" self-check
```

自检只核对 CLI、发现文件和本机 API 监听，不连接 SSH 或验证远端任务。入口保留当前工作目录及中文/空格/引号参数，不自动修改 PATH；用户可自行将此 `cli` 目录加入终端 PATH，更新后无需重设。旧实例不把入口降级，未知文件/链接拒绝覆盖。找不到 Node 时先配置终端 Node；缺少发现文件/监听时，打开 VS Code 并确认 SFTP Mac 已激活。自定义发现文件环境变量为 `SIMPLE_SFTP_MAC_API_FILE`。固定入口与自检通过真实本地 shell/Node/API 模拟测试，业务命令与 M5 继续分批验收。

CLI 业务 RPC 自动读取当前 Mac 发现文件和 `/api/v1/capabilities`，核对实时方法、身份与版本后发送原参数。未知方法、监听变化、非本机地址和错误 HTTP/JSON 响应会停止本次调用；不会自动重试传输或补上 `confirm`、`pathConfirmed`。出现预检失败时，打开对应 VS Code 扩展并重新自检，再核对实时契约主动调用。自行调用 HTTP API 时仍需自行发现与查询契约；此预检通过本地监听和真实 CLI 测试，真实传输/M5 尚待验收。

科研 Plan 通过配套 `simpleex-mac experiment run` 申请标准路线，SimpleSFTP 保持传输职责。CLI 与 VS Code 的项目必须一致，在线路线检查通过后仍需 VS Code 人工确认；`requested: true`、`submitted: false`、`waiting_confirmation` 是等待确认回执，使用返回的 `operationId` 与实时 `operations.list` 查看后续状态。[Mac 配置说明](https://github.com/zlinkw/SimpleExperiment-Mac/blob/master/docs/simple-experiment-setup.md) 提供完整路径与预检示例；离线 `local_only` 不能作为科研就绪证明。

配套 Mac 服务端在准备、校验及提交关键边界核对当前真实工作区；项目变化后重新预检，活动 Plan 不通过旧自动停止 fallback 中断。正式种子配置在保存的 Plan `seeds` 中，在线 Plan CLI 的 `--seed` 和 workflow API 的 `seed` 覆盖参数会拒绝；离线预览只返回 `seedApplied: false`。这些检查通过本地模拟，真实科研仍待验收。

## 发布与验收

两仓验证、提交并同步 origin/master 后，在 SimpleExperiment-Mac 执行 `npm run release:prepare`、`npm run release:publish`。release.json 绑定两仓提交，核验全部附件后发布，已发布版本不可覆盖。不使用 GitHub Actions，不自动安装开发机扩展。

本地构建、测试和包闭包检查与 M5 真机验证分别记录。M5、24 GB、macOS 27.0 上的更新、Termius、认证上传下载、中文路径、断连恢复和三拓扑尚待验收，用户已安排延后验证。

详情见 [Mac 发布与验收](https://github.com/zlinkw/SimpleExperiment-Mac/blob/master/docs/mac-release-guide.md)，持续适配见 [目标模式计划](https://github.com/zlinkw/SimpleExperiment-Mac/blob/master/docs/target-mode-plan.md)。
