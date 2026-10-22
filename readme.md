# SimpleSFTP Mac

Apple Silicon、macOS26+ 的 VS Code SSH/tar 传输扩展，配套 [SimpleExperiment Mac](https://github.com/zlinkw/SimpleExperiment-Mac)。Windows为业务唯一权威；Mac只适配本机路径、SSH/凭据、应用数据和CLI。

**2026-10-22 对齐源码尚未构建、测试或发布。** package 已统一递增为 0.2.102，满足 ≥0.2.102 共同更新租约协议的最低要求，但首次过渡尚未构建验证。冻结 Windows SFTP **0.2.104 / 13ef630a12c6ea02ad9277452e75dbf443b9a34b**，配套 Experiment **0.5.400 / 30626e78ea2f4b8a3e19e2cb09ae6aefcc6deb39**。本轮同步批量隔离/快速清理、控制器对象身份忙证据、进度/结算和等待策略；保留 Mac 原生认证、路径、CLI、更新租约及 Darwin 句柄证明。7 类运行验证未执行；Experiment 旧同步范围本机直接删除另有 1 项源码缺口，已显式阻断。见 [078 对齐说明](https://github.com/zlinkw/SimpleExperiment-Mac/blob/master/docs/windows-alignment-2026-10-22.md)。

## 安装和更新入口

两份darwin-arm64 VSIX和release.json统一在 [SimpleExperiment Mac Releases](https://github.com/zlinkw/SimpleExperiment-Mac/releases)，公开下载不要求登录。首次 **⇧⌘P → Extensions: Install from VSIX…** 按 **SimpleSFTP Mac → SimpleExperiment Mac** 安装，再 **Developer: Reload Window**。本轮没有新包。

| 入口 | 操作 |
| --- | --- |
| 命令面板 | **SimpleSFTP Mac：检查 preview 配套更新** 转到 SimpleExperiment Mac。 |
| 底部右侧状态栏 | 点击 **配套更新：…**。 |
| Experiment面板 → 设置 | **插件配套更新 → 检查更新 → 安装并重载**。 |
| 安装/补装 | **SimpleExperiment：安装或补装配套更新并重载**；旧Mac preview安装命令保留为别名。 |

共同更新流程保留检查与安装分离、每30分钟检查、同版跳过、禁止降级、全部下载校验、SFTP先装以及部分失败补装。已开始的本地传输继续，新业务在更新期间被阻止；取消等待不终止远端任务。旧mac-preview-update及新paired-plugin-update租约均被识别，实际事务只用共同实现。旧版过渡仍待验证。

## 配置与认证

1. **File → Open Folder…** 打开本机项目，一个窗口一个项目。
2. **⌘,** 搜索simpleSftpMac，填写真实localBase和remoteBase项目父目录；首次可关闭uploadOnSave，先 **查看当前目标**。
3. **SimpleSFTP：打开共享服务器配置** 填真实主机、用户、SSH端口和远端目录，再 **选择服务器**。已有服务器资产不从Windows扩展自动导入，不自动迁移真实目录。
4. **SimpleSFTP Mac：配置服务器认证** 选择该目标的认证方式。Termius密码不由插件读取。

| 方式 | Mac适配 |
| --- | --- |
| 系统SSH配置 / 自动 | 使用本机OpenSSH配置和默认密钥；需要SSH别名/跳板时选此模式。 |
| 私钥 | 选择实际私钥文件；首次连接按需输入私钥口令。 |
| ssh-agent | 使用VS Code进程可见的SSH_AUTH_SOCK，不要求服务器间免密。 |
| 密码 | 在VS Code密码输入框输入对应服务器密码。 |

默认仅本次会话记忆。明确勾选 **使用 VS Code SecretStorage 保存密码 / 私钥口令** 后才持久保存；密码不写服务器JSON、命令参数或临时文件。每个SSH地址/用户/端口分别认证。Agent生命周期和新增远端进度查询也使用同一认证适配器。

## 传输、进度与清理

保留Windows共同的命令、API、同步范围、错误分类和结算流程：**创建或打开远端项目、选择服务器、查看当前目标、上传工作区到目标、上传指定文件到目标、远端同步到本地、设置下载文件范围**。本机POSIX路径保留实际中文、空格和大小写；远端路径、类型、链接和范围按共同规则校验。

SSH/tar保持流式传输；跨服务器经本机流式中转，分别认证两端。进度和清理状态以本轮查询为准，失败结束本轮等待并提供重查；旧回执不造成永久忙状态。Agent更新接口直接复用Windows受管Agent与独立Scheduler生命周期，保留已运行/排队任务。

SimpleExperiment的每job同步取最新产物与当前勾选范围交集。默认Worker间同步整个work_dirs，兼容work_dir；不恢复旧attempt/历史产物机制。

删除继续要求精确目标、安全根、直接父目录、类型/链接防护和两次完整路径确认；失败不能当作完成。mac_cleanup_handles.py已为共同流程的原有句柄检查分支补入Darwin libproc只读适配，Experiment本机缓存执行器也复用该模块。扫描同用户的工作目录/线程目录、FD、fileport及映射，按冻结清单设备号/inode判断占用；占用返回ACTIVE_HANDLE，缺权限、ABI不符、枚举截断、身份变化或超时返回HANDLE_CHECK_UNAVAILABLE，不提权、不终止进程、不另建清理状态机。最新 path-only/fast batch/archive/顶层扫描路径均接入同一原生证明，目录冻结清单超过上限仍阻断。共同confirmed_paths/managed_tmux边界不变；这份源码尚未在Mac执行。本轮没有真实传输、部署或删除。

## 数据和CLI

| 内容 | 位置 |
| --- | --- |
| 服务器资产 | ~/Library/Application Support/SimpleSFTPMac/server-profiles/servers.json |
| API发现文件 | ~/Library/Application Support/SimpleSFTPMac/api.json |
| 共同租约 | ~/Library/Application Support/SimpleLocalMac/SimpleExperiment/ |

**SimpleSFTP Mac：查看 CLI 入口** 提供simple-sftp-mac-api实际路径，终端需Node.js20+。自定义发现文件使用SIMPLE_SFTP_MAC_API_FILE；每次业务调用先读取当前发现文件和capabilities/openapi，不猜端口、不补确认、不自动重发未知请求。

本轮仅静态语法、依赖路径与源码指纹核对。类型/包闭包/构建/测试、M5凭据/中文路径/传输/断连、共同更新过渡及服务器生命周期均待验证；历史0.2.101测试结果不能套用到当前源码。详细使用流程见 [Mac配置说明](https://github.com/zlinkw/SimpleExperiment-Mac/blob/master/docs/simple-experiment-setup.md)。
