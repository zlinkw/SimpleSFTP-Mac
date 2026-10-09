# SimpleSFTP Mac

SimpleSFTP Mac 是 Apple Silicon Mac 的 VS Code 文件传输扩展，与 [SimpleExperiment Mac](https://github.com/zlinkw/SimpleExperiment-Mac) 配套。沿用 SSH/tar 流式传输、路径确认和传输结算职责，扩展身份、设置、配置目录和更新源与 Windows 原版独立。

**当前为 preview 测试版，完整 Mac 传输和认证尚未真机验收。** 本地 POSIX 工作区、中文/空格路径和大小写处理已加入源码；密钥、ssh-agent、密码、私钥口令、断连恢复仍需后续适配与验收。不要套用原 Windows 的使用说明。

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

业务适配完成后的操作流程：打开本地项目 → 选择服务器与用户配置的远端目录 → 核对本机路径、账号、端口及完整目标路径 → 上传或下载。SimpleExperiment Mac 负责调度，SimpleSFTP Mac 负责真实传输。

保留命令：**创建或打开远端项目**、**选择服务器**、**查看当前目标**、**上传工作区到目标**、**上传指定文件到目标**、**远端同步到本地**、**设置下载文件范围**、**上传并标记交接**。设置命名空间为 `simpleSftpMac.*`。

认证目标为独立支持密钥、ssh-agent、密码和私钥口令，默认仅会话内记忆，勾选后才使用 VS Code SecretStorage。Termius 登录不会自动授权 SimpleSFTP，插件不读取其密码。上述认证入口仍在适配，以实际版本发布说明与真机结果为准。

跨服务器传输目标为分别认证两端，经本机流式中转，无需服务器之间免密互联。保留哈希核对、有限并发和资源结算职责，本地与远端路径必须来自用户配置。

上传前的路径确认保留。API 缺少确认返回 `CONFIRM_REQUIRED`。永久删除需要精确目标、直接父目录核验与两次确认，普通上传不镜像删除远端内容。

## 数据目录与 API

| 内容 | Mac 位置 |
| --- | --- |
| 服务器配置 | `~/Library/Application Support/SimpleSFTPMac/server-profiles/servers.json` |
| API 发现文件 | `~/Library/Application Support/SimpleSFTPMac/api.json` |
| 共享租约 | `~/Library/Application Support/SimpleLocalMac/SimpleExperiment/` |

API 方法沿用原契约。地址、token、pid、版本来自当前发现文件，请求需要 Bearer token；每次调用前读取 `/api/v1/capabilities` 或 `/api/v1/openapi.json`，禁止猜端口和参数。

CLI 为 `simple-sftp-mac-api`，从源码 npm 包入口使用，不保证 VSIX 安装后自动加入 shell PATH；自定义发现文件环境变量为 `SIMPLE_SFTP_MAC_API_FILE`。

## 发布与验收

两仓验证、提交并同步 origin/master 后，在 SimpleExperiment-Mac 执行 `npm run release:prepare`、`npm run release:publish`。release.json 绑定两仓提交，核验全部附件后发布，已发布版本不可覆盖。不使用 GitHub Actions，不自动安装开发机扩展。

本地构建、测试和包闭包检查与 M5 真机验证分别记录。M5、24 GB、macOS 27.0 上的更新、Termius、认证上传下载、中文路径、断连恢复和三拓扑尚待验收，用户已安排延后验证。

详情见 [Mac 发布与验收](https://github.com/zlinkw/SimpleExperiment-Mac/blob/master/docs/mac-release-guide.md)，持续适配见 [目标模式计划](https://github.com/zlinkw/SimpleExperiment-Mac/blob/master/docs/target-mode-plan.md)。
