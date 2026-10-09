const vscode = require("vscode");
const { AsyncLocalStorage } = require("node:async_hooks");
const { ProgressInactivity } = require("./progress-inactivity");
const { LatestSnapshotWriter } = require("./latest-snapshot-writer");
const { TransferCapacity } = require("./transfer-capacity");
const transferCapacity = new TransferCapacity();
let extensionDeactivating = false;
const { chooseSampleFiles, chooseCompression, CompressionHistory, SAMPLE_TIMEOUT_MS } = require("./compression-policy");
const compressionSampleScript = require("node:fs").readFileSync(require("node:path").join(__dirname, "compression-sample.py"), "utf8");
const compressionHistory = new CompressionHistory();
let compressionProbeTransport = null;
const transferContext = new AsyncLocalStorage();
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { READ_ONLY_SETTLEMENT_METHODS, clientRequestKey, retryIdentity, localTransferExitProof, settlementProbeCommand } = require("./transfer-settlement");
let transferRecoveryTestHooks = null;
const transferRecoveries = new Map();
const { execFile, spawn } = require("child_process");
const { resolveWorkspaceLocation, normalizeMacRelativePath, localPathText, remotePathText } = require("./workspace-path.js");
const { toTarPath: tarEntryPath, validateTarEntries, writeTarEntriesToStream } = require("./tar-writer.js");
const { LocalApiServer, confirmationRequired, currentApiRequestContext } = require("./api-server.js");
const {
  HostOperationLeaseConflictError,
  HostOperationLeaseManager,
} = require("./host-operation-lease.js");
const PACKAGE_JSON = require("./package.json");
const { MacAuthentication, sshAuthArgs } = require("./mac-auth");
let macAuthentication;
const APPDATA = require("./mac-paths").applicationDataRoot();
const SHARED_SERVER_DIR = path.join(APPDATA, "SimpleSFTPMac", "server-profiles");
const SHARED_SERVER_FILE = path.join(SHARED_SERVER_DIR, "servers.json");
const LEGACY_SHARED_SERVER_FILE = path.join(APPDATA, "SimpleSFTPMac", "legacy-server-profiles", "servers.json");
const API_CONFIG_NAMESPACE = "simpleSftpMac";
const API_CONFIG_PREFIX = `${API_CONFIG_NAMESPACE}.`;
const SIMPLE_SFTP_CONFIG_KEYS = new Set(Object.keys(PACKAGE_JSON.contributes?.configuration?.properties || {}));

const DEFAULT_HANDOFF_MARKER = ".simple-sftp-handoff.json";
const AGENTS_BLOCK_START = "<!-- SIMPLE_SFTP_START -->";
const AGENTS_BLOCK_END = "<!-- SIMPLE_SFTP_END -->";

const DEFAULT_IGNORES = [
  ".git",
  ".vscode",
  ".idea",
  DEFAULT_HANDOFF_MARKER,
  ".ipynb_checkpoints",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".cache",
  ".tox",
  ".venv",
  "venv",
  "env",
  "build",
  "dist",
  "node_modules",
  "comparison_methods/_repos",
  "data",
  "dataset",
  "datasets",
  "Datasets",
  "VOCdevkit",
  "checkpoints",
  "checkpoint",
  "weights",
  "weight",
  "pretrained",
  "pretrained_ckpt",
  "runs",
  "work_dirs",
  "wandb",
  "tensorboard",
  "logs",
  "log",
  "output",
  "outputs",
  "results",
  "result",
  "backup",
  "tmp",
  "temp",
  "*.log",
  "*.out",
  "*.err",
  "*.csv",
  "*.tsv",
  "*.xlsx",
  "*.xls",
  "*.zip",
  "*.tar",
  "*.tar.gz",
  "*.tgz",
  "*.rar",
  "*.7z",
  "*.h5",
  "*.hdf5",
  "*.pkl",
  "*.pickle",
  "*.joblib",
  "*.pth",
  "*.pt",
  "*.ckpt",
  "*.onnx",
  "*.engine",
  "*.nii",
  "*.nii.gz",
  "*.mha",
  "*.mhd",
  "*.dcm",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.bmp",
  "*.tif",
  "*.tiff",
  "*.npy",
  "*.npz",
];

// These editor and Git internals never belong in a project transfer.
const FIXED_IGNORES = [".git", ".vscode", ".simple-sftp-stage-*", "*.simple-sftp-partial-*"];

const HIDDEN_TOP_LEVEL = new Set([
  ".codex",
  ".vscode-server",
  "run",
  "tmp",
  "tensorboard",
]);

const promptedWorkspaces = new Set();
const uploadQueues = new Map();
const activeTransfers = new Map();
const cancelledTransferOperations = new Map();
const activeUploadOperations = new Map();
const transferOperationLedger = new Map();
const activeTransferResources = new Map();
const SAVE_UPLOAD_STATE = "simple-sftp-upload-state.json";
const TARGET_DOWNLOAD_SCOPE_STATE = "sftp-download-scopes.json";
const DEFAULT_DOWNLOAD_EXTENSIONS = ["*"];
const DEFAULT_DOWNLOAD_MAX_FILE_SIZE_MB = 1024;
const PATH_CONFIRMATIONS_STATE = "simple-sftp-confirmed-transfer-paths.v1";
const TRANSFER_OPERATION_STATE = "simple-sftp-transfer-settlement.v1";
const MAX_TRANSFER_OPERATIONS = 512;
const SETTLED_TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;
let transferSequence = 0;
let transferLedgerLoaded = false;
let transferLedgerWrite = Promise.resolve();
const transferLedgerWriter = new LatestSnapshotWriter(async ({ context, rows }) => {
  if (context?.globalState?.update) await context.globalState.update(TRANSFER_OPERATION_STATE, rows);
});
let defaultConnectTimeoutSeconds = 15;
let extensionContext;
let localApiServer;
let serverStatusButton;
let sharedWatcher;
const hostOperationLease = new HostOperationLeaseManager();

async function activate(context) {
  extensionDeactivating = false;
  extensionContext = context;
  if (process.platform === "darwin") {
    macAuthentication = new MacAuthentication(context, vscode.window);
    await macAuthentication.start();
  }
  loadTransferOperationLedger();
  refreshConnectTimeoutFromConfig();
  const command = vscode.commands.registerCommand(
    "simpleSftpMac.createOrOpen",
    (options) => createOrOpenProject(options)
  );
  const syncCommand = vscode.commands.registerCommand(
    "simpleSftpMac.syncFromRemote",
    () => syncFromRemote()
  );
  const uploadWorkspaceCommand = vscode.commands.registerCommand(
    "simpleSftpMac.uploadWorkspace",
    (options) => uploadWorkspace(options)
  );
  const uploadFilesCommand = vscode.commands.registerCommand(
    "simpleSftpMac.uploadFiles",
    (options) => uploadFiles(options)
  );
  const selectServerCommand = vscode.commands.registerCommand(
    "simpleSftpMac.selectServer",
    () => selectServer()
  );
  context.subscriptions.push(vscode.commands.registerCommand("simpleSftpMac.configureAuthentication", async () => {
    require("./mac-update-gate").assertBusinessAllowed();
    if (!macAuthentication) throw new Error("独立认证入口仅支持 Mac。");
    const servers = readSharedServers().servers;
    const selected = await vscode.window.showQuickPick(servers.map(server => ({ label: server.label || server.id, description: `${server.user || server.username || ""}@${server.host}`, server })), { title: "选择要配置独立认证的服务器" });
    if (selected) await macAuthentication.configure({ ...apiTransferSftp({ server: selected.server }),
      username: selected.server.user || selected.server.username || "", port: normalizeSshPort(selected.server.sshPort || selected.server.port, 22) });
  }));
  const importSshConfigCommand = vscode.commands.registerCommand(
    "simpleSftpMac.importSshConfig",
    () => importSharedSshConfig()
  );
  const openSharedServerConfigCommand = vscode.commands.registerCommand(
    "simpleSftpMac.openSharedServerConfig",
    () => openSharedServerConfig()
  );
  const showCurrentTargetCommand = vscode.commands.registerCommand(
    "simpleSftpMac.showCurrentTarget",
    () => showCurrentTarget()
  );
  const handoffCommand = vscode.commands.registerCommand(
    "simpleSftpMac.markHandoffReady",
    () => markHandoffReady()
  );
  const configureDownloadScopeCommand = vscode.commands.registerCommand(
    "simpleSftpMac.configureDownloadScope",
    (options) => configureDownloadScope(options)
  );
  context.subscriptions.push(command, syncCommand, uploadWorkspaceCommand, uploadFilesCommand, handoffCommand, configureDownloadScopeCommand, selectServerCommand, importSshConfigCommand, openSharedServerConfigCommand, showCurrentTargetCommand);
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      void handleSavedDocument(document);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("simpleSftpMac.connectTimeoutSeconds")) {
        refreshConnectTimeoutFromConfig();
      }
      if (event.affectsConfiguration("simpleSftpMac.uploadOnSave")) {
        applyUploadOnSaveSettingToOpenWorkspaces();
      }
    })
  );

  const actionsProvider = new ActionTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("simpleSftpMac.actions", actionsProvider)
  );

  context.subscriptions.push(
    createServerStatusButton(),
    createStatusButton(
      "$(cloud-download) SimpleSFTP 项目",
      "选择远端项目并创建本地 SFTP 同步工作区。",
      "simpleSftpMac.createOrOpen",
      102
    ),
    createStatusButton(
      "$(sync) 远端到本地",
      "从远端同步代码到当前本地工作区，适合开始编辑前使用。",
      "simpleSftpMac.syncFromRemote",
      101
    ),
    createStatusButton(
      "$(cloud-upload) 交接",
      "上传本地代码并写入交接标记，适合切换设备前使用。",
      "simpleSftpMac.markHandoffReady",
      100
    ),
    createStatusButton(
      "$(cloud-download) 下载范围",
      "选择允许从远端下载到本机的文件和文件夹。",
      "simpleSftpMac.configureDownloadScope",
      99
    )
  );
  initializeSharedServerProfiles();
  startSharedServerWatcher();
  updateServerStatusButton();

  applyUploadOnSaveSettingToOpenWorkspaces();
  void maybePromptForHandoff().catch((error) => {
    vscode.window.showWarningMessage(`SimpleSFTP 工作区路径检查失败：${formatError(error)}`);
  });
  startLocalApiServer(context);
}

function startLocalApiServer(context) {
  const server = new LocalApiServer({
    name: "SimpleSFTP",
    version: String(PACKAGE_JSON.version || "0.2.0"),
    preferredPort: 19766,
    discoveryPath: path.join(APPDATA, "SimpleSFTPMac", "api.json"),
    methods: createLocalApiMethods(),
    methodOptions: {
      "sync.projectInventory": { scopeTransport: "stdin", maxScopePaths: 5000, maxScopeBytes: 1048576 },
      "sync.serverToServerFpsync": { compression: ["auto", "gzip", "zstd", "none"], singleStream: "boolean", compressionPolicy: "bounded-sample-cpu-link-v1", maxBatchBytes: FPSYNC_MAX_BATCH_BYTES, chunkBytes: 8 * 1024 * 1024, fileProgress: "committed-files-v1" },
      "sync.downloadMappedPaths": { compression: ["auto", "gzip", "none"], maxBatchBytes: "number", memoryOnly: true, memoryWrapperResults: true, maxMemoryBytes: 4 * 1024 * 1024, manifestTransport: "stdin", maxManifestBytes: 1024 * 1024 },
    },
  });
  localApiServer = server;
  context.subscriptions.push({
    dispose: () => {
      void server.dispose().catch(() => undefined);
    },
  });
  void server.start().catch((error) => {
    console.warn(`SimpleSFTP local API failed to start: ${formatError(error)}`);
  });
  return server;
}

function createStatusButton(text, tooltip, command, priority) {
  const button = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    priority
  );
  button.text = text;
  button.tooltip = tooltip;
  button.command = command;
  button.show();
  return button;
}

function createServerStatusButton() {
  serverStatusButton = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    103
  );
  serverStatusButton.command = "simpleSftpMac.selectServer";
  serverStatusButton.tooltip = "选择共享服务器配置。";
  serverStatusButton.show();
  return serverStatusButton;
}

function emptySharedServers() {
  return { version: 1, updatedAt: new Date().toISOString(), updatedBy: "simple-sftp", activeServerId: "", servers: [] };
}

function readSharedServers() {
  try {
    if (!fs.existsSync(SHARED_SERVER_FILE)) return emptySharedServers();
    const parsed = JSON.parse(fs.readFileSync(SHARED_SERVER_FILE, "utf8"));
    return {
      version: 1,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      updatedBy: parsed.updatedBy || "simple-sftp",
      activeServerId: parsed.activeServerId || "",
      servers: Array.isArray(parsed.servers) ? parsed.servers.filter((item) => item && item.enabled !== false) : [],
    };
  } catch {
    return emptySharedServers();
  }
}

function writeSharedServers(data) {
  fs.mkdirSync(SHARED_SERVER_DIR, { recursive: true });
  const next = { ...data, version: 1, updatedAt: new Date().toISOString(), updatedBy: "simple-sftp" };
  const temp = `${SHARED_SERVER_FILE}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(temp, SHARED_SERVER_FILE);
}

function getActiveSharedServer() {
  const data = readSharedServers();
  return data.servers.find((item) => item.id === data.activeServerId) || data.servers[0];
}

function updateServerStatusButton() {
  if (!serverStatusButton) return;
  const active = getActiveSharedServer();
  serverStatusButton.text = active ? `$(plug) SimpleSFTP：${active.label || active.id}` : "$(plug) SimpleSFTP：未选服务器";
  serverStatusButton.tooltip = active
    ? `${active.user || ""}@${active.host}${active.remotePath ? ":" + active.remotePath : ""}`
    : "尚未配置共享服务器。";
}

function initializeSharedServerProfiles() {
  fs.mkdirSync(SHARED_SERVER_DIR, { recursive: true });
  if (fs.existsSync(SHARED_SERVER_FILE)) return;
  if (fs.existsSync(LEGACY_SHARED_SERVER_FILE)) {
    fs.copyFileSync(LEGACY_SHARED_SERVER_FILE, SHARED_SERVER_FILE);
    return;
  }
  writeSharedServers(emptySharedServers());
}

function startSharedServerWatcher() {
  try {
    if (sharedWatcher) sharedWatcher.close();
    sharedWatcher = fs.watch(SHARED_SERVER_DIR, (_event, filename) => {
      if (filename !== "servers.json") return;
      updateServerStatusButton();
    });
  } catch {}
}

async function selectServer() {
  const data = readSharedServers();
  const items = data.servers.map((item) => ({
    label: item.label || item.id,
    description: `${item.user || ""}@${item.host}${item.remotePath ? ":" + item.remotePath : ""}`,
    id: item.id,
  })).concat([
    { label: "+ 从 VS Code SSH 配置导入", id: "__import" },
    { label: "+ 打开共享服务器配置", id: "__open" },
    { label: "+ 刷新服务器列表", id: "__refresh" },
  ]);
  const picked = await vscode.window.showQuickPick(items, { title: "SimpleSFTP 服务器" });
  if (!picked) return;
  if (picked.id === "__import") return importSharedSshConfig();
  if (picked.id === "__open") return openSharedServerConfig();
  if (picked.id === "__refresh") return updateServerStatusButton();
  writeSharedServers({ ...data, activeServerId: picked.id });
  updateServerStatusButton();
}

async function openSharedServerConfig() {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(SHARED_SERVER_FILE));
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function importSharedSshConfig() {
  const result = importSharedSshConfigCore();
  updateServerStatusButton();
  vscode.window.showInformationMessage(`已导入 ${result.imported} 个 SSH 配置。`);
  return result;
}

function importSharedSshConfigCore() {
  const imported = readProfilesFromSshConfig();
  const data = readSharedServers();
  const byId = new Map(data.servers.map((item) => [item.id, item]));
  for (const item of imported) byId.set(item.id, { ...byId.get(item.id), ...item, enabled: true });
  const next = { ...data, servers: [...byId.values()] };
  if (!next.activeServerId && next.servers[0]) next.activeServerId = next.servers[0].id;
  writeSharedServers(next);
  return { ok: true, imported: imported.length, activeServerId: next.activeServerId };
}

function readProfilesFromSshConfig() {
  const sshConfigPath = path.join(os.homedir(), ".ssh", "config");
  if (!fs.existsSync(sshConfigPath)) return [];
  const text = fs.readFileSync(sshConfigPath, "utf8");
  const lines = text.split(/\r?\n/);
  const profiles = [];
  let current;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === "host") {
      if (current && current.host && current.id !== "*") profiles.push(current);
      current = { id: value, label: value, sshConfigHost: value, source: "vscode-ssh-config", authType: "ssh-config", enabled: true, port: 22 };
      continue;
    }
    if (!current) continue;
    if (key === "hostname") current.host = value;
    if (key === "user") current.user = value;
    if (key === "port") current.port = Number(value) || 22;
  }
  if (current && current.host && current.id !== "*") profiles.push(current);
  return profiles;
}

class ActionTreeProvider {
  getTreeItem(item) {
    return item;
  }

  getChildren() {
    return [
      new ActionTreeItem({
        label: "创建或打开项目",
        description: "选择远端项目目录并创建本地工作区",
        icon: "cloud-download",
        command: "simpleSftpMac.createOrOpen",
      }),
      new ActionTreeItem({
        label: "远端同步到本地",
        description: "开始编辑前同步远端代码",
        icon: "sync",
        command: "simpleSftpMac.syncFromRemote",
      }),
      new ActionTreeItem({
        label: "上传并标记交接",
        description: "切换设备前上传并写入交接标记",
        icon: "cloud-upload",
        command: "simpleSftpMac.markHandoffReady",
      }),
      new ActionTreeItem({
        label: "设置下载文件范围",
        description: "选择允许下载的远端文件和文件夹",
        icon: "cloud-download",
        command: "simpleSftpMac.configureDownloadScope",
      }),
      new ActionTreeItem({
        label: "查看当前目标",
        description: "查看当前 SFTP 工作区映射",
        icon: "info",
        command: "simpleSftpMac.showCurrentTarget",
      }),
      new ActionTreeItem({ label: "配置服务器认证", description: "密钥、ssh-agent、密码与口令", icon: "key", command: "simpleSftpMac.configureAuthentication" }),
    ];
  }
}

class ActionTreeItem extends vscode.TreeItem {
  constructor({ label, description, icon, command }) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.tooltip = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = {
      command,
      title: label,
    };
  }
}

async function createOrOpenProject(options = {}) {
  try {
    const cfg = vscode.workspace.getConfiguration("simpleSftpMac");
    const target = resolveCreateProjectTarget(getActiveSharedServer(), cfg, options);
    const writeAgentsFile = cfg.get("writeAgentsFile");

    const selectedPath = options.apiMode
      ? remotePathText(options.remotePath, process.platform)
      : await pickRemoteDirectory({ remoteBase: target.remoteBase, sftp: target.sftp });
    const remotePath = remotePathText(selectedPath, process.platform);
    if (!remotePath) {
      const message = "缺少远端项目目录 remotePath。";
      if (options.apiMode) throw new Error(message);
      return;
    }

    const projectName = path.posix.basename(remotePath);
    const localPath = localPathText(options.localPath || path.join(target.localBase, projectName), process.platform);
    const selectedTarget = { ...target.sftp, remotePath };
    await withHostOperationLease("create-workspace", "创建 SFTP 工作区", localPath, async () => {
      await confirmTransferPath({
        localPath,
        sftp: selectedTarget,
        operation: "创建 SFTP 工作区",
        detail: "从远端目录同步到本地工作区",
        options,
      });
      await writeWorkspace({
        execHost: target.execHost,
        localPath,
        projectName,
        remotePath,
        sftp: target.sftp,
        serverLabel: target.label,
        userName: target.sftp.username,
        writeAgentsFile,
      });
    });

    if (options.apiMode) {
      return {
        ok: true,
        localPath,
        remotePath,
        host: selectedTarget.host,
        username: selectedTarget.username || "",
        port: normalizeSshPort(selectedTarget.port, 22),
      };
    }

    const action = await vscode.window.showInformationMessage(
      `已创建 SFTP 工作区：${localPath}`,
      "打开项目",
      "显示文件夹"
    );
    if (action === "显示文件夹") {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(localPath));
      return;
    }
    if (action === "打开项目" || action == null) {
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(localPath), false);
    }
  } catch (error) {
    if (options.apiMode) throw error;
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

function resolveCreateProjectTarget(server, cfg, options = {}) {
  const item = server && typeof server === "object" ? server : {};
  const fallback = options && typeof options === "object"
    ? { ...(options.server && typeof options.server === "object" ? options.server : {}), ...options }
    : {};
  const host = firstNonEmpty(item.sftpHost, item.sshHost, fallback.sftpHost, fallback.sshHost, item.host, fallback.host, item.sshConfigHost, item.sshConfigAlias, fallback.sshConfigHost, fallback.sshConfigAlias, cfg.get("sshHost"));
  const username = String(item.user || item.username || fallback.user || fallback.username || cfg.get("userName") || "").trim();
  const fallbackPort = normalizeSshPort(fallback.port || fallback.sshPort, normalizeSshPort(cfg.get("sshPort"), 22));
  const port = normalizeSshPort(item.sshPort || item.port, fallbackPort);
  const remoteBase = remotePathText(item.remotePath || fallback.remoteBase || fallback.remotePath || cfg.get("remoteBase"), process.platform);
  const localBase = localPathText(item.localBase || fallback.localBase || cfg.get("localBase"), process.platform);
  const execHost = String(item.host || item.sshConfigHost || fallback.execHost || fallback.host || fallback.sshConfigHost || cfg.get("execHost") || host).trim();
  const label = String(item.id || item.label || fallback.id || fallback.label || host || "simple-sftp-target").trim();
  assertCreateProjectTarget({ host, remoteBase, localBase });
  return {
    label,
    remoteBase,
    localBase,
    execHost,
    sftp: {
      name: label,
      host,
      port,
      username,
      remotePath: remoteBase,
    },
  };
}

function assertCreateProjectTarget({ host, remoteBase, localBase }) {
  const missing = [];
  if (!host) missing.push("SSH 主机");
  if (!remoteBase) missing.push("远端根目录");
  if (!localBase) missing.push("本地根目录");
  if (missing.length) throw new Error(`SFTP 项目目标配置缺失：${missing.join("、")}。`);
}

async function showCurrentTarget(options = {}) {
  const hasExplicitTarget = Boolean(
    options &&
    (options.server ||
      options.remotePath ||
      options.host ||
      options.sshHost ||
      options.sshConfigHost ||
      options.sshConfigAlias)
  );
  const workspaceFolder = getPrimaryWorkspaceFolder();
  if (!workspaceFolder && !options.localPath) {
    if (options.apiMode && hasExplicitTarget) {
      const localPath = localPathText(options.localPath || "", process.platform);
      const sftp = localPath ? resolveUploadSftp(localPath, options) : apiTransferSftp({ ...options, localPath });
      if (sftp && sftp.host && sftp.remotePath) {
        const summary = formatSftpTargetSummary(localPath, sftp);
        return {
          ok: true,
          localPath,
          host: sftp.host,
          username: sftp.username || "",
          port: normalizeSshPort(sftp.port, 22),
          remotePath: sftp.remotePath,
          ignoreCount: 0,
          summary,
        };
      }
    }
    if (!options.apiMode) vscode.window.showInformationMessage("当前未打开工作区。");
    return { ok: false, error: "当前未打开工作区。请传入 localPath。" };
  }
  const localPath = localPathText(options.localPath || getWorkspaceRoot(), process.platform);
  const sftp = hasExplicitTarget ? resolveUploadSftp(localPath, options) : readSftpConfig(localPath);
  if (!sftp || !sftp.remotePath || !sftp.host) {
    const message = hasExplicitTarget
      ? "未提供可用的 SFTP 目标。"
      : "当前工作区没有可用的 .vscode/sftp.json 目标。";
    if (!options.apiMode) vscode.window.showInformationMessage(message);
    return { ok: false, error: message };
  }
  const location = workspaceLocationForFolder(workspaceFolder);
  const summary = `${formatSftpTargetSummary(localPath, sftp)}${location && location.remote ? ` | 工作区 ${location.editorUri}` : ""}`;
  if (!options.apiMode) {
    const action = await vscode.window.showInformationMessage(summary, "打开 sftp.json");
    if (action === "打开 sftp.json") {
      await openWorkspaceRelativeFile(".vscode/sftp.json");
    }
  }
  return {
    ok: true,
    localPath,
    host: sftp.host,
    username: sftp.username || "",
    port: normalizeSshPort(sftp.port, 22),
    remotePath: sftp.remotePath,
    ignoreCount: Array.isArray(sftp.ignore) ? sftp.ignore.length : 0,
  };
}

function formatSftpTargetSummary(localPath, sftp) {
  const user = sftp.username ? `${sftp.username}@` : "";
  const port = normalizeSshPort(sftp.port, 22);
  return `SimpleSFTP 目标：${user}${sftp.host}:${port} ${sftp.remotePath} -> ${localPath}`;
}

async function updateWorkspaceTarget(options = {}) {
  const localPath = localPathText(options.localPath || getWorkspaceRoot(), process.platform);
  if (!localPath)
    throw new Error("target.update 缺少本地工作区 localPath。");
  return withHostOperationLease("update-target", "更新 SFTP 工作区目标", localPath, () =>
    updateWorkspaceTargetCore({ ...options, localPath })
  );
}

async function updateWorkspaceTargetCore(options = {}) {
  const localPath = localPathText(options.localPath || "", process.platform);
  if (!localPath)
    throw new Error("target.update 缺少本地工作区 localPath。");
  const patch = options.patch && typeof options.patch === "object" && !Array.isArray(options.patch)
    ? options.patch
    : {};
  const existing = readSftpConfig(localPath) || {};
  const host = String(patch.host || patch.hostname || existing.host || "").trim();
  const remotePath = remotePathText(patch.remotePath ?? existing.remotePath, process.platform);
  if (!host)
    throw new Error("target.update 缺少目标主机 host。");
  if (!remotePath)
    throw new Error("target.update 缺少远端路径 remotePath。");
  const port = normalizeSshPort(patch.port ?? patch.sshPort ?? existing.port, 22);
  const username = String(patch.username ?? patch.user ?? existing.username ?? existing.user ?? "").trim();
  const ignore = mergeIgnorePatterns(DEFAULT_IGNORES, FIXED_IGNORES);
  const sftp = {
    ...existing,
    ...patch,
    name: String(patch.name || existing.name || `${host}-simple-sftp-target`).trim(),
    host,
    protocol: "sftp",
    port,
    username,
    remotePath,
    uploadOnSave: typeof patch.uploadOnSave === "boolean" ? patch.uploadOnSave : Boolean(existing.uploadOnSave),
    downloadOnOpen: typeof patch.downloadOnOpen === "boolean" ? patch.downloadOnOpen : Boolean(existing.downloadOnOpen),
    useTempFile: typeof patch.useTempFile === "boolean" ? patch.useTempFile : Boolean(existing.useTempFile),
    openSsh: true,
    ignore,
  };
  const configPath = path.join(localPath, ".vscode", "sftp.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(sftp, null, 2)}\n`, "utf8");
  return {
    ok: true,
    localPath,
    host,
    username,
    port,
    remotePath,
    ignoreCount: ignore.length,
  };
}

async function maybePromptForHandoff() {
  const cfg = vscode.workspace.getConfiguration("simpleSftpMac");
  if (!cfg.get("handoffPrompt")) return;

  const workspaceFolder = getPrimaryWorkspaceFolder();
  if (!workspaceFolder) return;

  const localPath = getWorkspaceRoot();
  const workspaceKey = process.platform === "win32" ? localPath.toLowerCase() : localPath;
  if (promptedWorkspaces.has(workspaceKey)) return;
  promptedWorkspaces.add(workspaceKey);

  const sftp = readSftpConfig(localPath);
  if (!sftp || !sftp.remotePath || !sftp.host) return;

  const markerName = cfg.get("handoffMarkerName") || DEFAULT_HANDOFF_MARKER;
  let marker = null;
  try {
    marker = await readRemoteHandoffMarker(sftp, markerName);
  } catch (error) {
    const action = await vscode.window.showWarningMessage(
      `无法读取 SimpleSFTP 交接标记。是否在编辑前同步远端代码？${formatError(error)}`,
      "远端同步到本地",
      "跳过"
    );
    if (action === "远端同步到本地") {
      await syncFromRemote({ confirmMarker: false });
    }
    return;
  }

  const currentDevice = getDeviceName();
  const shouldPrompt = !marker || !marker.device || marker.device !== currentDevice;
  if (!shouldPrompt) return;

  const message = marker
    ? `SimpleSFTP 交接：${marker.device} 已在 ${formatTime(marker.markedAt)} 标记 ${sftp.remotePath} 可交接。是否在编辑前同步远端代码？`
    : `SimpleSFTP 交接：未找到 ${sftp.remotePath} 的远端交接标记。是否在编辑前同步远端代码？`;

  const action = await vscode.window.showInformationMessage(
    message,
    "远端同步到本地",
    "跳过"
  );
  if (action === "远端同步到本地") {
    await syncFromRemote({ confirmMarker: false });
  }
}

async function syncFromRemote(options = {}) {
  const localPath = resolveLocalWorkspacePath(options.localPath, "远端同步到本地");
  return withHostOperationLease("sync-from-remote", "远端同步到本地", localPath, () => syncFromRemoteCore({ ...options, localPath }));
}

function directSyncTarget(value, label) {
  const item = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const host = String(item.host || "").trim();
  const username = String(item.user || item.username || "").trim();
  const remotePath = remotePathText(item.remotePath, process.platform);
  const port = normalizeSshPort(item.port || item.sshPort, 22);
  if (!/^[A-Za-z0-9._-]+$/.test(host) || !/^[A-Za-z0-9._-]+$/.test(username)) throw new Error(`${label} SSH 主机或用户名无效。`);
  if (!remotePath.startsWith("/") || remotePath === "/" || remotePath.split("/").includes("..")) throw new Error(`${label} 项目根目录不安全。`);
  return { host, username, remotePath, port };
}

function directSyncRelativePath(value) {
  const relative = process.platform === "darwin" ? normalizeMacRelativePath(value, "Plan 产物相对路径")
    : String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (Buffer.byteLength(relative, "utf8") > 4096 || /[:\0\r\n]/.test(relative)) throw new Error("Plan 产物相对路径不安全。");
  if (!relative || relative.startsWith("/") || relative.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Plan 产物相对路径不安全。");
  if (relative.split("/").some((part) => part.startsWith(".simple-sftp-stage-") || part.includes(".simple-sftp-partial-"))) throw new Error("路径保留给 SimpleSFTP 传输暂存使用。");
  return relative;
}

function guardedRemoteDeleteCommand(target, relativePath) {
  if (!projectTreePathAllowed(relativePath) || relativePath === "simple_cluster") throw new Error("删除路径属于机器状态或包含机器状态。");
  const absolute = path.posix.join(target.remotePath, relativePath);
  const parent = path.posix.dirname(absolute);
  const leaf = `./${path.posix.basename(absolute)}`;
  return `root=$(realpath -e -- ${shellQuote(target.remotePath)}) || { echo PARENT_CD_FAILED >&2; exit 75; }; parent=$(realpath -e -- ${shellQuote(parent)}) || { echo PARENT_CD_FAILED >&2; exit 75; }; case "$parent" in "$root"|"$root"/*) ;; *) exit 72;; esac; cd -- "$parent" || { echo PARENT_CD_FAILED >&2; exit 75; }; test "$(pwd -P)" = "$parent" || { echo PARENT_CD_FAILED >&2; exit 75; }; test ! -L ${shellQuote(leaf)} || exit 72; if test -d ${shellQuote(leaf)}; then command -v rsync >/dev/null 2>&1 || { echo RSYNC_UNAVAILABLE >&2; exit 76; }; empty=$(mktemp -d -- './.simple-sftp-empty.XXXXXXXX') || exit 76; trap 'rmdir -- "$empty" >/dev/null 2>&1 || true' EXIT; rsync -r --delete -- "$empty/" ${shellQuote(`${leaf}/`)} && rmdir -- ${shellQuote(leaf)}; else rm -f -- ${shellQuote(leaf)}; fi && test ! -e ${shellQuote(leaf)}`;
}

function removeLocalStagingDirectory(tempDir, options = {}) {
  const safetyRoot = fs.realpathSync(os.tmpdir());
  const parent = fs.realpathSync(path.dirname(tempDir));
  const leaf = path.basename(tempDir);
  const info = fs.lstatSync(tempDir);
  if (parent !== safetyRoot || !/^simple-sftp-(?:files|code-sync-state)-[A-Za-z0-9]+$/.test(leaf) || !info.isDirectory() || info.isSymbolicLink())
    throw new Error("临时目录不在已验证的暂存根目录内；禁止清理。");
  if (options.confirm !== true || options.secondConfirmation !== true || options.confirmedAbsolutePath !== tempDir)
    throw confirmationRequired({ method: "local.cleanupStaging", absolutePath: tempDir, requires: ["confirm", "secondConfirmation", "confirmedAbsolutePath"] });
  const psQuote = (value) => `'${value.replace(/'/g, "''")}'`;
  const command = process.platform === "win32" ? "pwsh.exe" : "sh";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; Set-Location -LiteralPath ${psQuote(parent)}; if ((Get-Location).ProviderPath -ne ${psQuote(parent)}) { throw 'PARENT_CD_FAILED' }; Remove-Item -LiteralPath ${psQuote(`./${leaf}`)} -Recurse -Force -ErrorAction Stop`]
    : ["-c", 'cd -- "$1" || exit 75; test "$(pwd -P)" = "$2" || exit 75; rm -rf -- "./$3"', "sh", parent, safetyRoot, leaf];
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd: parent, windowsHide: true, timeout: 0 }, (error) => error ? reject(error) : resolve());
    const monitor = watchTransferProcess(child, reject, false);
    child.stdout?.on("data", monitor.receive);
  });
}

async function deleteProjectPath(options = {}) {
  const target = directSyncTarget(options.target, "删除目标");
  const relativePath = directSyncRelativePath(options.relativePath);
  const absolutePath = path.posix.join(target.remotePath, relativePath);
  if (options.confirmedAbsolutePath !== absolutePath || options.confirm !== true || options.pathConfirmed !== true || options.secondConfirmation !== true)
    throw confirmationRequired({ method: "sync.deletePath", operation: "永久删除单台 Worker 的项目路径", target, relativePath, absolutePath,
      requires: ["confirm", "pathConfirmed", "secondConfirmation", "confirmedAbsolutePath"] });
  const command = guardedRemoteDeleteCommand(target, relativePath);
  try {
    await withFileResourceLease("删除确认目标", target.remotePath, [relativePath], remoteResourceServer(target), () => runSsh(target, command, transferTimeoutMs(target, options)));
  } catch (error) {
    const message = formatError(error);
    if (message.includes("PARENT_CD_FAILED")) throw new Error(`PARENT_CD_FAILED：无法进入或验证父目录 ${path.posix.dirname(absolutePath)}；禁止删除。`);
    throw error;
  }
  return { ok: true, target: target.host, relativePath, absolutePath };
}

function directSyncCommand(source, destination, relativePath, directory, deleteOnly = false) {
  const sourcePath = path.posix.join(source.remotePath, relativePath);
  const destinationPath = path.posix.join(destination.remotePath, relativePath);
  const destinationHost = `${destination.username}@${destination.host}`;
  const sshOptions = `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 -p ${destination.port}`;
  const destinationGuard = `root=$(realpath -e -- ${shellQuote(destination.remotePath)}) && target=$(realpath -m -- ${shellQuote(destinationPath)}) && case "$target" in "$root"/*) ;; *) exit 72;; esac`;
  if (deleteOnly) return `${sshOptions} ${shellQuote(destinationHost)} ${shellQuote(guardedRemoteDeleteCommand(destination, relativePath))}`;
  const destinationParent = directory ? destinationPath : path.posix.dirname(destinationPath);
  const parentGuard = `root=$(realpath -e -- ${shellQuote(destination.remotePath)}) && parent=$(realpath -m -- ${shellQuote(destinationParent)}) && case "$parent" in "$root"|"$root"/*) ;; *) exit 72;; esac`;
  const prepare = `${sshOptions} ${shellQuote(destinationHost)} ${shellQuote(`${parentGuard} && mkdir -p -- ${shellQuote(destinationParent)} && ${destinationGuard}`)}`;
  const sourceArg = directory ? `${sourcePath}/` : sourcePath;
  const destinationParentForRsync = path.posix.dirname(destinationPath);
  const destinationLeaf = `./${path.posix.basename(destinationPath)}`;
  const guardedRsync = `root=$(realpath -e -- ${shellQuote(destination.remotePath)}) || exit 75; parent=$(realpath -e -- ${shellQuote(destinationParentForRsync)}) || exit 75; case "$parent" in "$root"|"$root"/*) ;; *) exit 72;; esac; cd -- "$parent" || exit 75; test "$(pwd -P)" = "$parent" || exit 75; test ! -L ${shellQuote(destinationLeaf)} || exit 72; rsync`;
  const destinationArg = `${destinationHost}:${directory ? `${destinationLeaf}/` : destinationLeaf}`;
  const rsyncArgs = `-a -c -s --delete-missing-args ${directory ? "--delete " : ""}--rsync-path=${shellQuote(guardedRsync)} -e ${shellQuote(sshOptions)} -- ${shellQuote(sourceArg)} ${shellQuote(destinationArg)}`;
  const sync = `rsync ${rsyncArgs}`;
  const verify = `remaining=$(rsync -n -i ${rsyncArgs}) || exit 74; if [ -n "$remaining" ]; then printf '内容校验不一致: %s\\n' "$remaining"; exit 73; fi`;
  const sourceGuard = `root=$(realpath -e -- ${shellQuote(source.remotePath)}) && target=$(realpath -m -- ${shellQuote(sourcePath)}) && case "$target" in "$root"/*) ;; *) exit 72;; esac`;
  return `${sourceGuard} && ${prepare} && ${sync} && ${verify}`;
}

async function syncServerToServer(options = {}) {
  const source = directSyncTarget(options.source, "来源");
  const destination = directSyncTarget(options.destination, "目标");
  const relativePath = directSyncRelativePath(options.relativePath);
  if (options.directory === true && relativePath.split("/").length < 2 && options.manualRetain !== true) throw new Error("目录同步必须限定到 Plan 独立子目录，禁止清理项目顶层目录。");
  if (options.manualRetain === true && (!projectTreePathAllowed(relativePath) || options.directory === true && relativePath === "simple_cluster")) throw new Error("手动保留版本路径属于机器状态或包含机器状态。");
  if (source.host === destination.host && source.port === destination.port && source.remotePath === destination.remotePath) throw new Error("来源与目标相同。" );
  if (options.confirm !== true || options.pathConfirmed !== true) throw confirmationRequired({
    method: "sync.serverToServer", operation: "Worker 间直接同步 Plan 产物",
    requires: ["confirm", "pathConfirmed"],
    source, destination, relativePath, directory: options.directory === true, deleteOnly: options.deleteOnly === true, deleteStale: true,
  });
  if (options.deleteOnly === true) {
    await withFileResourceLease("删除确认目标", destination.remotePath, [relativePath], remoteResourceServer(destination), () => runSsh(destination, guardedRemoteDeleteCommand(destination, relativePath), transferTimeoutMs(destination, options)));
    return { ok: true, source, destination, relativePath, directory: options.directory === true, deletedStale: true };
  }
  const packed = await syncServerToServerFpsync({ ...options, source, destination,
    ...(options.directory === true ? { relativePath, directory: true } : { relativePaths: [relativePath], directory: false }),
    confirm: true, pathConfirmed: true });
  return { ...packed, source, destination, relativePath, directory: options.directory === true, deletedStale: false };
}

const BATCH_HASH_QUIET_SECONDS = 15;
const BATCH_HASH_POLL_SECONDS = 0.25;

async function inspectRemoteScope(target, relativePath, directory, timeoutMs, required = false) {
  const script = scopeInventoryScript();
  const stdout = await runSsh(target, `python3 -c ${shellQuote(script)} ${shellQuote(target.remotePath)} ${shellQuote(relativePath)} ${directory ? "1" : "0"} ${required ? "1" : "0"} ${BATCH_HASH_QUIET_SECONDS} ${BATCH_HASH_POLL_SECONDS}`, timeoutMs);
  return scopeHashPayload(JSON.parse(stdout));
}

function relayTarFiles(source, destination, paths, timeoutMs, options = {}) {
  if (!paths.length) return Promise.resolve();
  return withFileResourceLease("Worker 流传输", destination.remotePath, paths, remoteResourceServer(destination),
    () => relayTarFilesCore(source, destination, paths, timeoutMs, options));
}
function relayTarFilesCore(source, destination, paths, timeoutMs, options = {}) {
  if (!paths.length) return Promise.resolve();
  const compression = transferCompression(options);
  const sourceCommand = options.sourceCommand || `bash -o pipefail -c ${shellQuote(`root=$(realpath -e -- ${shellQuote(source.remotePath)}) && test "$root" = ${shellQuote(source.remotePath)} && cd -- "$root" && test "$(pwd -P)" = "$root" && ${tarPackingCommand(compression)}`)}`;
  const destinationCommand = options.destinationCommand || `bash -o pipefail -c ${shellQuote(stagedTarUnpackingCommand(destination, compression, options.transferId, options.expectedFiles, paths) )}`;
  return new Promise((resolve, reject) => {
    getSshArgs(source, sourceCommand); getSshArgs(destination, destinationCommand);
    let reader, writer;
    let sourceCode;
    let destinationCode;
    const sourceErrors = transferErrorLog(paths), destinationErrors = transferErrorLog(paths);
    const children = [], closed = new Set(), monitors = [];
    let starting = true, settled = false, failureError;
    let wireBytes = 0;
    const finish = (error) => {
      if (settled) return;
      if (error && !failureError) {
        failureError = error;
        reader?.stdout?.unpipe(writer?.stdin);
        for (const monitor of monitors) monitor.dispose();
        for (const child of children) if (!closed.has(child)) { try { child.kill(); } catch { /* Close proof is still required. */ } }
      }
      // Keep the resource lease until every launched SSH process has closed,
      // including a reader whose peer failed synchronously during launch.
      if (starting || closed.size !== children.length) return;
      settled = true;
      if (failureError) reject(failureError);
      else { try { options.onWireBytes?.(wireBytes); resolve(); } catch (error) { reject(error); } }
    };
    const failure = () => new Error(`内存转发失败（来源退出码 ${sourceCode} / 目标退出码 ${destinationCode}）：${[sourceErrors.text(), destinationErrors.text()].filter(Boolean).join("\n") || "SSH 不可用"}`);
    const launch = (target, command, isDestination) => {
      const child = spawnSsh(target, command, { windowsHide: true, stdio: ["pipe", isDestination ? "ignore" : "pipe", "pipe"] });
      children.push(child);
      child.on("error", finish);
      child.stdin.on("error", finish);
      child.on("close", (code, signal) => {
        closed.add(child);
        if (isDestination) destinationCode = code; else sourceCode = code;
        finish(code === 0 && !signal ? undefined : failure());
      });
      child.stderr.on("data", chunk => (isDestination ? destinationErrors : sourceErrors).receive(chunk));
      const monitor = watchTransferProcess(child, finish, true, paths, isDestination,
        { wireScope: `relay-${children[0].pid}`, filenamePhase: isDestination ? "unpacking" : "packing" });
      monitors.push(monitor);
      return child;
    };
    try {
      reader = launch(source, sourceCommand, false);
      if (!failureError) writer = launch(destination, destinationCommand, true);
      if (!failureError) {
        reader.stdout.on("error", finish);
        reader.stdout.on("data", chunk => { wireBytes += chunk.length; for (const monitor of monitors) monitor.receive(chunk); });
        // pipe applies backpressure; archives/chunks never accumulate as a local file.
        reader.stdout.pipe(writer.stdin);
        reader.stdin.end(Buffer.from(paths.map(name => `${name}\0`).join(""), "utf8"));
      }
    } catch (error) { finish(error); }
    starting = false;
    finish();
  });
}

async function removeStaleRemoteFiles(destination, scope, paths, timeoutMs) {
  // Preserve the legacy entry as a preview. Removal uses the explicit double-confirmed API.
  throw confirmationRequired({ method: "sync.deletePath", target: destination, relativePath: scope,
    absolutePaths: paths.map(name => path.posix.join(destination.remotePath, directSyncRelativePath(name))),
    requires: ["confirm", "pathConfirmed", "secondConfirmation", "confirmedAbsolutePath"] });
}

async function relayServerToServer(source, destination, relativePath, directory, timeoutMs) {
  const sourceFiles = (await inspectRemoteScope(source, relativePath, directory, timeoutMs, directory)).files;
  const destinationFiles = (await inspectRemoteScope(destination, relativePath, directory, timeoutMs)).files;
  if (directory) {
    const target = path.posix.join(destination.remotePath, relativePath);
    const guard = `root=$(realpath -e -- ${shellQuote(destination.remotePath)}) && target=$(realpath -m -- ${shellQuote(target)}) && case "$target" in "$root"/*) ;; *) exit 72;; esac`;
    await runSsh(destination, `${guard} && mkdir -p -- ${shellQuote(target)}`, timeoutMs);
  }
  const changed = Object.keys(sourceFiles).filter((name) => sourceFiles[name].sha256 !== destinationFiles[name]?.sha256).sort();
  const stale = Object.keys(destinationFiles).filter((name) => !sourceFiles[name]).sort();
  if (stale.length) await removeStaleRemoteFiles(destination, relativePath, stale, timeoutMs);
  await relayTarFiles(source, destination, changed, timeoutMs, { expectedFiles: sourceFiles });
  const verified = (await inspectRemoteScope(destination, relativePath, directory, timeoutMs)).files;
  if (JSON.stringify(Object.entries(sourceFiles).sort()) !== JSON.stringify(Object.entries(verified).sort()))
    throw new Error("本机内存转发后内容 SHA256 不一致；同步保持待处理。");
  return { ok: true, source, destination, relativePath, directory, deletedStale: stale.length > 0, transferredFiles: changed.length, verification: "sha256", transport: "memory-relay" };
}

async function listPlanLogPaths(options = {}) {
  const source = directSyncTarget(options.source, "来源");
  const statePath = directSyncRelativePath(options.statePath);
  if (!statePath.startsWith("simple_cluster/tmp/cluster_scheduler/") || !statePath.endsWith("_state.json"))
    throw new Error("Plan 状态文件路径不受支持。");
  const text = await runSsh(source, `cat -- ${shellQuote(path.posix.join(source.remotePath, statePath))}`, transferTimeoutMs(source, options));
  if (Buffer.byteLength(text, "utf8") > 20 * 1024 * 1024) throw new Error("Plan 状态文件过大。");
  return { ok: true, paths: planLogPathsFromState(JSON.parse(text), options.planFile) };
}

function planLogPathsFromState(state, planFile) {
  const expectedPlan = String(planFile || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const actualPlan = String(state.plan || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  if (!expectedPlan || actualPlan !== expectedPlan) throw new Error("Plan 状态文件与目标 Plan 不匹配。");
  const paths = new Set();
  const add = (raw) => {
    if (!raw) return;
    const relative = directSyncRelativePath(raw);
    if (!relative.startsWith("simple_cluster/tmp/cluster_scheduler/") && !relative.startsWith("simple_cluster/debug_runs/") && !relative.startsWith("tmp/tmux_logs/"))
      throw new Error(`Plan 日志路径超出允许范围：${relative}`);
    paths.add(relative);
  };
  add(state.scheduler_log);
  for (const key of ["completed_experiments", "failed_experiments", "stopped_experiments", "running_experiments", "testing_experiments"])
    for (const row of Array.isArray(state[key]) ? state[key] : []) add(row?.log_path);
  return [...paths].sort();
}

async function projectInventory(options = {}) {
  const source = directSyncTarget(options.source, "来源");
  const relativePath = options.relativePath === undefined ? "." : String(options.relativePath) === "." ? "." : directSyncRelativePath(options.relativePath);
  const recursive = options.recursive !== false;
  if (options.scopePaths !== undefined && !Array.isArray(options.scopePaths)) throw new Error("清单范围必须是路径数组。");
  const scopePaths = options.scopePaths === undefined ? null : options.scopePaths.map((item) => String(item) === "." ? "." : directSyncRelativePath(item));
  if (scopePaths && scopePaths.length > 5000) throw new Error("一次清单最多 5000 个范围路径。");
  if (scopePaths && Buffer.byteLength(JSON.stringify(scopePaths), "utf8") > 1048576) throw new Error("清单范围超过 1 MiB。");
  if (relativePath !== "." && !projectTreePathAllowed(relativePath)) throw new Error("清单目录属于机器状态。");
  const script = projectInventoryScript();
  const command = `python3 -c ${shellQuote(script)} ${shellQuote(source.remotePath)} ${shellQuote(relativePath)} ${recursive ? "1" : "0"} ${shellQuote(scopePaths ? "@stdin" : "null")}`;
  const output = scopePaths ? await runRemoteBatchSsh(source, command, scopePaths, transferTimeoutMs(source, options), { remoteMutation: false, stage: "产物清单校验" })
    : await runSsh(source, command, transferTimeoutMs(source, options));
  const result = JSON.parse(output);
  if (!result.files || typeof result.files !== "object" || Array.isArray(result.files)) throw new Error("远端项目清单无效。");
  return { ok: true, files: result.files, unverifiedFiles: result.unverifiedFiles || {}, hashedFiles: result.hashedFiles, reusedFiles: result.reusedFiles, cacheRows: result.cacheRows, cacheStatus: result.cacheStatus };
}

async function projectFileStats(options = {}) {
  const source = directSyncTarget(options.source, "来源");
  if (!Array.isArray(options.paths) || !options.paths.length) throw new Error("文件属性查询必须提供 paths，且不能扫描整个项目。");
  if (options.paths.length > 128) throw new Error("一次最多查询 128 个项目内文件属性。");
  const paths = [...new Map(options.paths.map((item) => {
    const relative = directSyncRelativePath(item);
    if (!projectTreePathAllowed(relative)) throw new Error(`文件属性路径属于插件或机器状态：${relative}`);
    return [relative.toLowerCase(), relative];
  })).values()];
  const script = [
    "import json,os,stat,sys",
    "root=os.path.realpath(sys.argv[1]); paths=json.loads(sys.argv[2]); files={}; missing=[]",
    "for rel in paths:",
    " parts=rel.split('/')",
    " if any(part in ('','.','..') for part in parts): raise ValueError('unsafe path')",
    " cursor=root",
    " for part in parts:",
    "  cursor=os.path.join(cursor,part)",
    "  if os.path.islink(cursor): raise ValueError('symlink path: '+rel)",
    " full=os.path.realpath(cursor)",
    " if os.path.commonpath((root,full))!=root: raise ValueError('path outside project: '+rel)",
    " try: st=os.stat(full,follow_symlinks=False)",
    " except FileNotFoundError: missing.append(rel); continue",
    " if not stat.S_ISREG(st.st_mode): raise ValueError('not a regular file: '+rel)",
    " files[rel]={'size':int(st.st_size),'modifiedAtMs':int(st.st_mtime_ns//1000000)}",
    "print(json.dumps({'files':files,'missing':missing},ensure_ascii=False,separators=(',',':')))"
  ].join("\n");
  const output = await runSsh(source, `python3 -c ${shellQuote(script)} ${shellQuote(source.remotePath)} ${shellQuote(JSON.stringify(paths))}`, transferTimeoutMs(source, options));
  const result = JSON.parse(output);
  if (!result.files || typeof result.files !== "object" || Array.isArray(result.files)) throw new Error("远端文件属性响应无效。");
  return { ok: true, files: result.files, missing: Array.isArray(result.missing) ? result.missing : [] };
}

function projectInventoryScript() {
  return [
    "import hashlib,json,os,sqlite3,stat as statmod,sys,time,threading",
    "SQLITE_INT64_SPAN=1<<64",
    "def sql_int(value):",
    " value=int(value)",
    " if value>=1<<63: value-=SQLITE_INT64_SPAN",
    " return value",
    "def content_identity(st): return (int(st.st_size),int(st.st_mtime_ns))",
    "def cache_identity(st): return (sql_int(st.st_dev),sql_int(st.st_ino),int(st.st_size),int(st.st_mtime_ns),sql_int(st.st_ctime_ns))",
    "from concurrent.futures import ThreadPoolExecutor,wait,FIRST_COMPLETED",
    "root=os.path.realpath(sys.argv[1]); relroot=sys.argv[2]; recursive=sys.argv[3]=='1'; found={}; unverified={}; updates=[]; hashed=0; reused=0",
    "if len(sys.argv)>4 and sys.argv[4]=='@stdin':",
    " raw=sys.stdin.buffer.read(1048577)",
    " if len(raw)>1048576: raise ValueError('inventory scopes exceed 1 MiB')",
    " scopes=[item.decode('utf-8') for item in raw.split(b'\\0') if item]",
    " if len(scopes)>5000: raise ValueError('inventory scopes exceed 5000 paths')",
    "else: scopes=json.loads(sys.argv[4]) if len(sys.argv)>4 else None",
    "if scopes is not None and any(scope!='.' and (scope.startswith('/') or any(part in ('','.','..') for part in scope.split('/'))) for scope in scopes): raise ValueError('unsafe inventory scope')",
    "scope_set=set(scopes or []); scope_ancestors=set()",
    "for scope in scope_set:",
    " parts=scope.split('/')",
    " for index in range(1,len(parts)): scope_ancestors.add('/'.join(parts[:index]))",
    "progress_lock=threading.Lock(); progress={'bytes':0,'files':0,'at':0}",
    "def report_progress(byte_count=0,file_count=0,force=False):",
    " with progress_lock:",
    "  progress['bytes']+=byte_count; progress['files']+=file_count; now=time.monotonic()",
    "  if force or now-progress['at']>=0.25:",
    "   sys.stderr.write('SIMPLE_PROGRESS '+json.dumps({'phase':'hashing','processedBytes':progress['bytes'],'processedFiles':progress['files'],'cacheHits':reused,'cacheRehash':hashed,'cacheStatus':cache_status})+chr(10)); sys.stderr.flush(); progress['at']=now",
    "blocked={'.git','.vscode','.codex','.agents','.coding-tools','.local-gpt','.runtime','clean_dir','zlk_cluster','.venv','venv','env','node_modules','__pycache__','.cache','.pytest_cache','.mypy_cache','.ruff_cache','.tox'}",
    "def allowed(rel,isdir=False):",
    " parts=rel.replace(os.sep,'/').lower().split('/')",
    " if parts[0]=='tmp' or any(p in blocked for p in parts): return False",
    " if any(p.startswith('.simple-sftp-stage-') or '.simple-sftp-partial-' in p for p in parts): return False",
    " if len(parts)>2 and parts[:2]==['experiments','results'] and parts[-1].endswith('.csv.lock'): return False",
    " if parts[0]=='work_dirs' and parts[-1]=='.tb_mean.lock': return False",
    " if parts[-1].startswith('.env') or parts[-1] in ('plan_sync_ledger.json','project_mirror_state.json'): return False",
    " if parts[0]!='simple_cluster': return True",
    " if len(parts)<2: return True",
    " if parts[1] in ('results','debug_runs'): return True",
    " if parts[1]=='tmp' and len(parts)==2: return isdir",
    " if parts[1]=='tmp' and len(parts)>2 and parts[2]=='tmux_logs': return True",
    " if parts[1]=='tmp' and len(parts)>2 and parts[2]=='cluster_scheduler': return (len(parts)==3 and isdir) or (len(parts)>3 and parts[3]=='logs') or (len(parts)==4 and parts[-1].endswith('.log'))",
    " return False",
    "def in_scope(rel,isdir=False):",
    " if scopes is None or '.' in scope_set: return True",
    " parts=rel.split('/')",
    " return (isdir and rel in scope_ancestors) or any('/'.join(parts[:index]) in scope_set for index in range(1,len(parts)+1))",
    "parts=[] if relroot=='.' else relroot.split('/')",
    "if any(p in ('','.','..') for p in parts): raise ValueError('unsafe inventory path')",
    "if any(os.path.islink(os.path.join(root,*parts[:i])) for i in range(1,len(parts)+1)): raise ValueError('symlink inventory path')",
    "target=os.path.join(root,*parts)",
    "if os.path.commonpath((root,os.path.realpath(target)))!=root: raise ValueError('inventory path outside project')",
    "if not os.path.isdir(target) and not os.path.isfile(target): print(json.dumps({'files':{}})); sys.exit(0)",
    "cache={}; db=None; cache_status='ready'; cache_at=time.monotonic(); update_bytes=0; cache_root=hashlib.sha256(root.encode('utf-8')).hexdigest()",
    "try:",
    " cache_dir=os.environ.get('SIMPLE_SFTP_HASH_CACHE_DIR') or os.path.join(os.path.expanduser('~'),'.cache','simple-sftp')",
    " os.makedirs(cache_dir,mode=0o700,exist_ok=True)",
    " db=sqlite3.connect(os.path.join(cache_dir,'project-inventory.sqlite3'),timeout=5)",
    " db.execute('CREATE TABLE IF NOT EXISTS hashes (root TEXT NOT NULL, path TEXT NOT NULL, dev INTEGER NOT NULL, ino INTEGER NOT NULL, size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, ctime_ns INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(root,path))')",
    "except (OSError,sqlite3.Error):",
    " if db is not None: db.close()",
    " db=None; cache={}; cache_status='unavailable'",
    "walk=((os.path.dirname(target),[],[os.path.basename(target)]),) if os.path.isfile(target) else os.walk(target,followlinks=False) if recursive else ((target,[],[name for name in os.listdir(target) if not os.path.isdir(os.path.join(target,name))]),)",
    "names=[]",
    "for current,dirs,files in walk:",
    " if recursive: dirs[:]=[d for d in dirs if not os.path.islink(os.path.join(current,d)) and allowed(os.path.relpath(os.path.join(current,d),root),True) and in_scope(os.path.relpath(os.path.join(current,d),root).replace(os.sep,'/'),True)]",
    " for name in files:",
    "  full=os.path.join(current,name); rel=os.path.relpath(full,root).replace(os.sep,'/')",
    "  if allowed(rel) and in_scope(rel): names.append((rel,full))",
    "if db is not None:",
    " try:",
    "  for offset in range(0,len(names),512):",
    "   wanted=[item[0] for item in names[offset:offset+512]]",
    "   for row in db.execute('SELECT path,dev,ino,size,mtime_ns,ctime_ns,sha256 FROM hashes WHERE root=? AND path IN ('+','.join('?' for _ in wanted)+')',(cache_root,*wanted)): cache[row[0]]=tuple(row[1:])",
    " except sqlite3.Error: cache={}; cache_status='read-failed'; db.close(); db=None",
    "def flush_inventory_cache(force=False):",
    " global update_bytes,cache_at,db,cache_status",
    " if db is None: updates.clear(); return",
    " if not updates or not (force or len(updates)>=32 or update_bytes>=67108864 or time.monotonic()-cache_at>=1): return",
    " try:",
    "  db.executemany('INSERT INTO hashes (root,path,dev,ino,size,mtime_ns,ctime_ns,sha256) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(root,path) DO UPDATE SET dev=excluded.dev,ino=excluded.ino,size=excluded.size,mtime_ns=excluded.mtime_ns,ctime_ns=excluded.ctime_ns,sha256=excluded.sha256',updates)",
    "  db.commit()",
    " except (OSError,sqlite3.Error): db.close(); db=None; cache_status='write-failed'",
    " updates.clear(); update_bytes=0; cache_at=time.monotonic()",
    "def inspect(item):",
    " rel,full=item",
    " try:",
    "  stat=os.lstat(full)",
    "  if statmod.S_ISLNK(stat.st_mode): return (rel,None,None,None)",
    "  if not statmod.S_ISREG(stat.st_mode): return (rel,None,None,'文件读取期间消失或不是普通文件')",
    "  identity=cache_identity(stat)",
    "  cached=cache.get(rel)",
    "  if cached is not None and cached[:5]==identity:",
    "   flags=os.O_RDONLY|getattr(os,'O_NOFOLLOW',0); descriptor=os.open(full,flags)",
    "   try: opened=os.fstat(descriptor)",
    "   finally: os.close(descriptor)",
    "   closed=os.lstat(full)",
    "   if statmod.S_ISREG(opened.st_mode) and not statmod.S_ISLNK(closed.st_mode) and identity[:4]==cache_identity(opened)[:4] and identity==cache_identity(closed): return (rel,{'sha256':cached[5],'size':stat.st_size,'modifiedAtMs':stat.st_mtime_ns//1000000},None,None)",
    "  with open(full,'rb') as stream:",
    "   before=os.fstat(stream.fileno()); h=hashlib.sha256()",
    "   for chunk in iter(lambda:stream.read(1048576),b''): h.update(chunk); report_progress(len(chunk))",
    "   after=os.fstat(stream.fileno())",
    "  closed=os.lstat(full)",
    "  if content_identity(stat)!=content_identity(before) or content_identity(before)!=content_identity(after) or content_identity(after)!=content_identity(closed) or cache_identity(stat)[:2]!=cache_identity(before)[:2] or cache_identity(before)[:2]!=cache_identity(after)[:2] or cache_identity(after)[:2]!=cache_identity(closed)[:2] or cache_identity(stat)!=cache_identity(closed):",
    "   return (rel,None,None,'文件校验期间发生变化')",
    "  digest=h.hexdigest()",
    "  return (rel,{'sha256':digest,'size':closed.st_size,'modifiedAtMs':closed.st_mtime_ns//1000000},(cache_root,rel,*cache_identity(closed),digest),None)",
    " except (FileNotFoundError,PermissionError,OSError) as exc:",
    "  return (rel,None,None,type(exc).__name__)",
    "with ThreadPoolExecutor(max_workers=8) as pool:",
    " remaining=iter(names); pending=set()",
    " def fill_pending():",
    "  while len(pending)<16:",
    "   item=next(remaining,None)",
    "   if item is None: break",
    "   pending.add(pool.submit(inspect,item))",
    " fill_pending()",
    " while pending:",
    "  done,pending=wait(pending,return_when=FIRST_COMPLETED)",
    "  for future in done:",
    "   rel,entry,update,error=future.result()",
    "   if error: unverified[rel]=error",
    "   elif entry:",
    "    found[rel]=entry",
    "    if update: hashed+=1; updates.append(update); update_bytes+=entry['size']",
    "    else: reused+=1",
    "   flush_inventory_cache(); report_progress(file_count=1)",
    "  fill_pending()",
    "flush_inventory_cache(True)",
    "if db is not None:",
    " try:",
    "  count=int(db.execute('SELECT COUNT(*) FROM hashes').fetchone()[0])",
    "  if count>250000:",
    "   db.execute('DELETE FROM hashes WHERE rowid IN (SELECT rowid FROM hashes ORDER BY rowid LIMIT ?)',(count-250000,))",
    "   db.commit()",
    " except (OSError,sqlite3.Error): pass",
    " finally: db.close()",
    "report_progress(force=True)",
    "print(json.dumps({'files':found,'unverifiedFiles':unverified,'hashedFiles':hashed,'reusedFiles':reused,'cacheRows':len(cache),'cacheStatus':cache_status},separators=(',',':')))",
  ].join("\n");
}

function projectTreePathAllowed(relative) {
  const parts = String(relative || "").toLowerCase().split("/");
  if (parts.some(part => part.startsWith(".simple-sftp-stage-") || part.includes(".simple-sftp-partial-"))) return false;
  if (parts[0] === "tmp" || parts.some((part) => [".git", ".vscode", ".codex", ".agents", ".coding-tools", ".local-gpt", ".runtime", "clean_dir", "zlk_cluster", ".venv", "venv", "env", "node_modules", "__pycache__", ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox"].includes(part))) return false;
  if (parts[0] === "experiments" && parts[1] === "results" && parts.at(-1).endsWith(".csv.lock")) return false;
  if (parts[0] === "work_dirs" && parts.at(-1) === ".tb_mean.lock") return false;
  if (parts.at(-1).startsWith(".env")) return false;
  if (["plan_sync_ledger.json", "project_mirror_state.json"].includes(parts.at(-1))) return false;
  if (parts[0] !== "simple_cluster" || parts.length < 2) return true;
  if (["results", "debug_runs"].includes(parts[1])) return true;
  if (parts[1] !== "tmp") return false;
  if (parts.length === 2 || parts[2] === "tmux_logs") return true;
  if (parts[2] === "cluster_scheduler") return parts.length === 3 || parts[3] === "logs" || parts.length === 4 && parts.at(-1).endsWith(".log");
  return false;
}

async function projectTree(options = {}) {
  const source = directSyncTarget(options.source, "来源");
  const relativePath = String(options.relativePath || ".") === "." ? "." : directSyncRelativePath(options.relativePath);
  if (relativePath !== "." && !projectTreePathAllowed(relativePath)) throw new Error("远端目录属于机器状态，不可纳入同步范围。");
  const script = [
    "import json,os,sys",
    "root=os.path.realpath(sys.argv[1]); rel=sys.argv[2]",
    "parts=[] if rel=='.' else rel.split('/')",
    "if any(p in ('','.','..') for p in parts): raise ValueError('unsafe tree path')",
    "if any(os.path.islink(os.path.join(root,*parts[:i])) for i in range(1,len(parts)+1)): raise ValueError('symlink tree path')",
    "target=os.path.join(root,*parts)",
    "if os.path.commonpath((root,os.path.realpath(target)))!=root: raise ValueError('tree directory outside project')",
    "if not os.path.exists(target): print('[]'); sys.exit(0)",
    "if not os.path.isdir(target): print('[]'); sys.exit(0)",
    "entries=[]",
    "for item in os.scandir(target):",
    " if item.is_symlink(): continue",
    " if not item.is_dir(follow_symlinks=False) and not item.is_file(follow_symlinks=False): continue",
    " name=item.name; child=name if rel=='.' else rel+'/'+name",
    " stat=item.stat(follow_symlinks=False)",
    " entries.append({'name':name,'path':child,'directory':item.is_dir(follow_symlinks=False),'size':stat.st_size if item.is_file(follow_symlinks=False) else None,'modifiedAtMs':stat.st_mtime_ns//1000000})",
    "print(json.dumps(entries,ensure_ascii=False,separators=(',',':')))",
  ].join("\n");
  const output = await runSsh(source, `python3 -c ${shellQuote(script)} ${shellQuote(source.remotePath)} ${shellQuote(relativePath)}`, transferTimeoutMs(source, options));
  const entries = JSON.parse(output);
  if (!Array.isArray(entries)) throw new Error("远端目录清单无效。");
  return { ok: true, relativePath, entries: entries.filter((entry) => projectTreePathAllowed(entry.path)).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) };
}

function remoteBatchStage(command) {
  const text = String(command || "");
  if (/tar --null -T - -cvf -/.test(text)) return /gzip|pigz|zstd/.test(text) ? "压缩打包传输" : "无压缩打包传输";
  if (/hashlib|sha256|inspect/.test(text) || /python3 -c/.test(text)) return "内容清单";
  return "远端命令";
}

let remoteBatchTransport = null;
function setRemoteBatchTransport(fn) {
  remoteBatchTransport = typeof fn === "function" ? fn : null;
}

function transferErrorLog(paths = []) {
  const decoder = new (require("node:string_decoder").StringDecoder)("utf8");
  const filenames = new Set(paths.flatMap(name => [name, `./${name}`]));
  let pending = "", errors = "";
  const append = line => {
    const text = line.trim();
    if (!text || filenames.has(text) || /^SIMPLE_(?:CHUNK_VERIFIED|COMPRESSION_WIRE) \d+$/.test(text)
      || /^SIMPLE_STAGE_COMMITTED \.simple-sftp-stage-[0-9a-f]{2}$/.test(text)) return;
    if (text.startsWith("SIMPLE_PROGRESS ")) {
      try {
        const row = JSON.parse(text.slice(16));
        if (["preparing", "hashing", "packing", "transferring", "unpacking", "verifying", "publishing", "distributing"].includes(row.phase)
          && ["processedFiles", "processedBytes"].every(key => row[key] === undefined || Number.isSafeInteger(row[key]) && row[key] >= 0)) return;
      } catch { /* Malformed protocol data remains diagnostic evidence. */ }
    }
    errors = (errors + (errors ? "\n" : "") + text).slice(-4096);
  };
  return {
    receive(chunk) {
      pending += decoder.write(chunk);
      let end;
      while ((end = pending.indexOf("\n")) >= 0) { append(pending.slice(0, end)); pending = pending.slice(end + 1); }
      if (pending.length > 8192) { append(pending.slice(0, 4096)); pending = pending.slice(-4096); }
    },
    text() { if (pending) { append(pending); pending = ""; } return errors; },
  };
}

function runRemoteBatchSsh(source, command, paths, timeoutMs, options = {}) {
  if (remoteBatchTransport) return Promise.resolve().then(() => remoteBatchTransport(source, command, paths, timeoutMs, options));
  const stage = options.stage || remoteBatchStage(command);
  return new Promise((resolve, reject) => {
    const child = spawnSsh(source, command, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }, spawn, ["-A", "-o", "BatchMode=yes"]);
    let stdout = "";
    const errors = transferErrorLog(paths);
    let wireBuffer = "", wireBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else { options.onWireBytes?.(wireBytes); resolve(value); }
    };
    const timer = null;
    const monitor = watchTransferProcess(child, finish, true, paths, options.remoteMutation,
      { stdoutBytesArePayload: false, filenamePhase: /内容清单|清单校验|分块检查点/.test(stage) ? "hashing" : "packing" });
    child.stdout.on("data", (chunk) => {
      monitor.receive(chunk);
      stdout += chunk.toString("utf8");
      if (stdout.length > 4 * 1024 * 1024) { child.kill(); finish(new Error("远端批量清单超过 4 MB。")); }
    });
    child.stderr.on("data", (chunk) => {
      errors.receive(chunk);
      wireBuffer += chunk.toString("utf8");
      let end;
      while ((end = wireBuffer.indexOf("\n")) >= 0) {
        const line = wireBuffer.slice(0, end); wireBuffer = wireBuffer.slice(end + 1);
        if (!line.startsWith("SIMPLE_COMPRESSION_WIRE ")) continue;
        const count = Number(line.slice(24).trim());
        if (Number.isSafeInteger(count) && count >= wireBytes) wireBytes = count;
      }
      wireBuffer = wireBuffer.slice(-1024);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) return finish(null, stdout.trim());
      const stderr = errors.text();
      finish(Object.assign(new Error(`跨 Worker ${stage}失败（退出码 ${code}）：${stderr || stdout.trim().slice(-4096) || "SSH 不可用"}`), { exitCode: code, stage, stderr }));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.from(paths.map((name) => `${name}\0`).join(""), "utf8"));
  });
}

function hashQuiescenceHelpers() {
  return [
    "SQLITE_INT64_SPAN=1<<64",
    "def sql_int(value):",
    " value=int(value)",
    " if value>=1<<63: value-=SQLITE_INT64_SPAN",
    " return value",
    "def content_identity(st): return (int(st.st_size),int(st.st_mtime_ns))",
    "def cache_identity(st): return (sql_int(st.st_dev),sql_int(st.st_ino),int(st.st_size),int(st.st_mtime_ns),sql_int(st.st_ctime_ns))",
    "def hash_progress(force=False):",
    " now=time.monotonic()",
    " if force or now-hash_stats.get('progressAt',0)>=0.25:",
    "  sys.stderr.write('SIMPLE_PROGRESS '+json.dumps({'phase':'hashing','processedBytes':hash_stats.get('processedBytes',0),'processedFiles':hash_stats.get('processedFiles',0),'cacheHits':cache_hits,'cacheRehash':cache_rehash,'cacheStatus':cache_status})+chr(10)); sys.stderr.flush(); hash_stats['progressAt']=now",
    "def hash_current(full):",
    " global hash_stats",
    " hash_stats['digestReads']+=1",
    " before=os.lstat(full)",
    " if statmod.S_ISLNK(before.st_mode) or not statmod.S_ISREG(before.st_mode): return None",
    " descriptor=open_nofollow(full)",
    " try:",
    "  opened=os.fstat(descriptor); h=hashlib.sha256()",
    "  if not statmod.S_ISREG(opened.st_mode) or content_identity(opened)!=content_identity(before) or cache_identity(opened)[:2]!=cache_identity(before)[:2]: return None",
    "  while True:",
    "   chunk=os.read(descriptor,1048576)",
    "   if not chunk: break",
    "   h.update(chunk)",
    "   hash_stats['processedBytes']=hash_stats.get('processedBytes',0)+len(chunk)",
    "   hash_progress()",
    "  closed=os.fstat(descriptor)",
    " finally:",
    "  os.close(descriptor)",
    " after=os.lstat(full)",
    " if content_identity(before)!=content_identity(opened) or content_identity(opened)!=content_identity(closed) or content_identity(closed)!=content_identity(after) or cache_identity(before)[:2]!=cache_identity(opened)[:2] or cache_identity(opened)[:2]!=cache_identity(closed)[:2] or cache_identity(closed)[:2]!=cache_identity(after)[:2] or cache_identity(before)!=cache_identity(after): return None",
    " return h.hexdigest(),after.st_size,cache_identity(after)",
    "def stable_digest(full,deadline,poll):",
    " delay=0",
    " while True:",
    "  hashed=hash_current(full)",
    "  if hashed is not None: return hashed",
    "  now=time.monotonic()",
    "  if now>=deadline: return None",
    "  delay=poll if delay==0 else min(delay*2,1)",
    "  time.sleep(min(delay,max(0,deadline-now)))",
  ];
}

function batchHashCacheHelpers() {
  return [
    "import sqlite3,stat as statmod",
    "cache_hits=0; cache_rehash=0; hash_stats={'digestReads':0}; cache_updates=[]; cache_queries=0",
    "cache_root=hashlib.sha256(root.encode('utf-8')).hexdigest(); db=None; cache_ready=False; cache_status='ready'; cache_at=time.monotonic(); cache_bytes=0",
    "try:",
    " cache_dir=os.environ.get('SIMPLE_SFTP_HASH_CACHE_DIR') or os.path.join(os.path.expanduser('~'),'.cache','simple-sftp')",
    " os.makedirs(cache_dir,mode=0o700,exist_ok=True)",
    " db=sqlite3.connect(os.path.join(cache_dir,'project-inventory.sqlite3'),timeout=5)",
    " db.execute('CREATE TABLE IF NOT EXISTS hashes (root TEXT NOT NULL, path TEXT NOT NULL, dev INTEGER NOT NULL, ino INTEGER NOT NULL, size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, ctime_ns INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(root,path))')",
    " cache_ready=True",
    "except (OSError,sqlite3.Error):",
    " if db is not None:",
    "  try: db.close()",
    "  except sqlite3.Error: pass",
    " db=None; cache_ready=False; cache_status='unavailable'",
    "def open_nofollow(full):",
    " flags=os.O_RDONLY",
    " if hasattr(os,'O_NOFOLLOW'): flags|=os.O_NOFOLLOW",
    " if hasattr(os,'O_BINARY'): flags|=os.O_BINARY",
    " return os.open(full,flags)",
    "def trim_hash_cache():",
    " if not cache_ready: return",
    " try:",
    "  count=int(db.execute('SELECT COUNT(*) FROM hashes').fetchone()[0])",
    "  if count>250000:",
    "   db.execute('DELETE FROM hashes WHERE rowid IN (SELECT rowid FROM hashes ORDER BY rowid LIMIT ?)',(count-250000,))",
    "   db.commit()",
    " except sqlite3.Error: pass",
    "def lookup_cached(rel,full,stat):",
    " global cache_hits,cache_queries,cache_status,cache_ready",
    " if not cache_ready or statmod.S_ISLNK(stat.st_mode) or not statmod.S_ISREG(stat.st_mode): return None",
    " cache_queries+=1",
    " try:",
    "  row=db.execute('SELECT dev,ino,size,mtime_ns,ctime_ns,sha256 FROM hashes WHERE root=? AND path=?',(cache_root,rel)).fetchone()",
    " except sqlite3.Error: cache_status='read-failed'; cache_ready=False; return None",
    " if row is None: return None",
    " current=cache_identity(stat)",
    " if tuple(int(part) for part in row[:5])!=current: return None",
    " try:",
    "  descriptor=open_nofollow(full)",
    " except OSError: return None",
    " try:",
    "  opened=os.fstat(descriptor)",
    "  if not statmod.S_ISREG(opened.st_mode) or content_identity(opened)!=content_identity(stat) or cache_identity(opened)[:2]!=current[:2]: return None",
    " finally:",
    "  os.close(descriptor)",
    " again=os.lstat(full)",
    " if statmod.S_ISLNK(again.st_mode) or not statmod.S_ISREG(again.st_mode) or cache_identity(again)!=current: return None",
    " cache_hits+=1",
    " return row[5],again.st_size",
    "def remember_hash(rel,file_identity,digest):",
    " global cache_rehash,cache_bytes",
    " cache_rehash+=1",
    " if cache_ready: cache_updates.append((cache_root,rel,*file_identity,digest)); cache_bytes+=file_identity[2]; flush_hash_cache(False)",
    "def flush_hash_cache(final=True):",
    " global cache_at,cache_bytes,cache_status,cache_ready,db",
    " if db is None: return",
    " if not final and len(cache_updates)<32 and cache_bytes<67108864 and time.monotonic()-cache_at<1: return",
    " try:",
    "  if cache_updates:",
    "   db.executemany('INSERT INTO hashes (root,path,dev,ino,size,mtime_ns,ctime_ns,sha256) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(root,path) DO UPDATE SET dev=excluded.dev,ino=excluded.ino,size=excluded.size,mtime_ns=excluded.mtime_ns,ctime_ns=excluded.ctime_ns,sha256=excluded.sha256',cache_updates)",
    "   db.commit()",
    "  cache_updates.clear(); cache_bytes=0; cache_at=time.monotonic()",
    "  if final: trim_hash_cache()",
    " except (OSError,sqlite3.Error): cache_status='write-failed'; cache_ready=False; final=True; cache_updates.clear()",
    " finally:",
    "  if final:",
    "   try: db.close()",
    "   except sqlite3.Error: pass",
    "   db=None",
  ];
}

function batchFileHashScript() {
  return [
    "import hashlib,json,os,sys,time",
    "root=os.path.realpath(sys.argv[1]); quiet_s=float(sys.argv[2]); poll_s=float(sys.argv[3]); found={}; unstable=[]",
    ...batchHashCacheHelpers(),
    ...hashQuiescenceHelpers(),
    "for raw in sys.stdin.buffer.read().split(b'\\0'):",
    " if not raw: continue",
    " rel=raw.decode('utf-8'); parts=rel.split('/')",
    " if any(p in ('','.','..') for p in parts): raise ValueError('unsafe batch path')",
    " if any(os.path.islink(os.path.join(root,*parts[:i])) for i in range(1,len(parts)+1)): raise ValueError('symlink batch path: '+rel)",
    " full=os.path.join(root,*parts)",
    " if os.path.commonpath((root,os.path.realpath(full)))!=root: raise ValueError('batch path outside project')",
    " if not os.path.lexists(full): found[rel]=None; continue",
    " if os.path.islink(full) or not os.path.isfile(full): raise ValueError('batch path is not a file: '+rel)",
    " stat=os.lstat(full)",
    " cached=lookup_cached(rel,full,stat)",
    " if cached is not None:",
    "  found[rel]={'sha256':cached[0],'size':cached[1]}",
    "  hash_stats['processedFiles']=len(found); hash_progress()",
    "  continue",
    " hashed=stable_digest(full,time.monotonic()+quiet_s,poll_s)",
    " if hashed is None: unstable.append(rel)",
    " else:",
    "  remember_hash(rel,hashed[2],hashed[0])",
    "  found[rel]={'sha256':hashed[0],'size':hashed[1]}",
    " hash_stats['processedFiles']=len(found); hash_progress()",
    "flush_hash_cache()",
    "hash_progress(True)",
    "if unstable: raise ValueError('file changed during batch sync: '+', '.join(unstable))",
    "print(json.dumps({'files':found,'cacheHits':cache_hits,'cacheRehash':cache_rehash,'cacheStatus':cache_status,'digestReads':hash_stats['digestReads'],'cacheQueries':cache_queries},separators=(',',':')))",
  ].join("\n");
}

function scopeInventoryScript() {
  return [
    "import hashlib,json,os,sys,time",
    "root=os.path.realpath(sys.argv[1]); rel=sys.argv[2]; directory=sys.argv[3]=='1'; required=sys.argv[4]=='1'; quiet_s=float(sys.argv[5]); poll_s=float(sys.argv[6])",
    "parts=rel.split('/'); target=os.path.join(root,*parts)",
    "if any(p in ('','.','..') for p in parts): raise ValueError('unsafe scope')",
    "if any(os.path.islink(os.path.join(root,*parts[:i])) for i in range(1,len(parts)+1)): raise ValueError('symlink scope')",
    "if os.path.commonpath((root,os.path.realpath(target)))!=root: raise ValueError('scope outside project')",
    "if directory and required and not os.path.isdir(target): raise ValueError('Plan directory missing: '+rel)",
    "paths=[]",
    "if directory and os.path.isdir(target):",
    " for current,dirs,files in os.walk(target,followlinks=False):",
    "  if any(os.path.islink(os.path.join(current,d)) for d in dirs): raise ValueError('symlink directory in Plan scope')",
    "  paths.extend(os.path.join(current,name) for name in files)",
    "elif os.path.isfile(target): paths=[target]",
    "found={}; unstable=[]",
    ...batchHashCacheHelpers(),
    ...hashQuiescenceHelpers(),
    "for full in paths:",
    " relpath=os.path.relpath(full,root).replace(os.sep,'/')",
    " if os.path.islink(full) or not os.path.isfile(full): raise ValueError('unsafe file in Plan scope')",
    " stat=os.lstat(full)",
    " cached=lookup_cached(relpath,full,stat)",
    " if cached is not None:",
    "  found[relpath]={'sha256':cached[0],'size':cached[1]}; hash_stats['processedFiles']=len(found); hash_progress(); continue",
    " hashed=stable_digest(full,time.monotonic()+quiet_s,poll_s)",
    " if hashed is None: unstable.append(relpath)",
    " else:",
    "  remember_hash(relpath,hashed[2],hashed[0])",
    "  found[relpath]={'sha256':hashed[0],'size':hashed[1]}",
    " hash_stats['processedFiles']=len(found); hash_progress()",
    "flush_hash_cache()",
    "hash_progress(True)",
    "if unstable: raise ValueError('file changed during Plan sync: '+', '.join(unstable))",
    "print(json.dumps({'files':found,'cacheHits':cache_hits,'cacheRehash':cache_rehash,'cacheStatus':cache_status,'digestReads':hash_stats['digestReads'],'cacheQueries':cache_queries},separators=(',',':')))",
  ].join("\n");
}

function batchHashPayload(parsed, expectedCount) {
  const files = parsed && parsed.files && typeof parsed.files === "object" && !Array.isArray(parsed.files) ? parsed.files : null;
  if (!files || Object.keys(files).length !== expectedCount) throw new Error("远端批量内容清单不完整。");
  return {
    files,
    cacheHits: Number(parsed.cacheHits) || 0,
    cacheRehash: Number(parsed.cacheRehash) || 0,
    digestReads: Number(parsed.digestReads) || 0,
    cacheQueries: Number(parsed.cacheQueries) || 0,
    cacheStatus: parsed.cacheStatus,
  };
}

function scopeHashPayload(parsed) {
  if (!parsed || !parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)) throw new Error("Plan 内容清单无效。");
  return {
    files: parsed.files,
    cacheHits: Number(parsed.cacheHits) || 0,
    cacheRehash: Number(parsed.cacheRehash) || 0,
    digestReads: Number(parsed.digestReads) || 0,
    cacheQueries: Number(parsed.cacheQueries) || 0,
    cacheStatus: parsed.cacheStatus,
  };
}

async function inspectRemoteBatchFiles(target, paths, timeoutMs) {
  const script = batchFileHashScript();
  const stdout = await runRemoteBatchSsh(target, `python3 -c ${shellQuote(script)} ${shellQuote(target.remotePath)} ${BATCH_HASH_QUIET_SECONDS} ${BATCH_HASH_POLL_SECONDS}`, paths, timeoutMs, { remoteMutation: false });
  return batchHashPayload(JSON.parse(stdout), paths.length);
}

function batchDestinationGuardCommand(destination) {
  const destinationHost = `${destination.username}@${destination.host}`;
  const destinationGuard = `root=$(realpath -e -- ${shellQuote(destination.remotePath)}) && test "$root" = ${shellQuote(destination.remotePath)}`;
  // The guard runs before rsync and must not consume its --files-from stdin.
  return `ssh -n -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p ${destination.port} ${shellQuote(destinationHost)} ${shellQuote(destinationGuard)}`;
}

async function syncServerToServerBatch(options = {}) {
  const source = directSyncTarget(options.source, "来源");
  const destination = directSyncTarget(options.destination, "目标");
  const paths = [...new Set((Array.isArray(options.relativePaths) ? options.relativePaths : []).map(directSyncRelativePath))].sort();
  if (!paths.length || paths.length > 5000) throw new Error("批量同步需要 1–5000 个项目内文件路径。");
  if (source.host === destination.host && source.port === destination.port && source.remotePath === destination.remotePath) throw new Error("来源与目标相同。");
  if (options.confirm !== true || options.pathConfirmed !== true) throw confirmationRequired({
    method: "sync.serverToServerBatch", operation: "Worker 间批量补齐项目文件", requires: ["confirm", "pathConfirmed"],
    source, destination, relativePaths: paths,
  });
  return syncServerToServerFpsync({ ...options, source, destination, relativePaths: paths, confirm: true, pathConfirmed: true });
}

// Streaming archives never buffer the batch; the byte limit bounds retry/staging cost.
const FPSYNC_MAX_BATCH_BYTES = 512 * 1024 * 1024;
const FPSYNC_PARALLEL_STREAMS = 2;

function partitionTransferPaths(paths, singleStreamFiles = 80, parallelSlots = 4, fileSizes, maxBytes = Infinity) {
  const list = Array.isArray(paths) ? paths : [];
  const cap = Math.max(1, Math.min(5000, singleStreamFiles));
  const slots = Math.max(1, parallelSlots);
  if (!list.length) return [];
  if (fileSizes && Number.isFinite(maxBytes) && maxBytes > 0) {
    const groups = [];
    let group = [];
    let groupBytes = 0;
    let manifestBytes = 0;
    for (const name of list) {
      const rawSize = typeof fileSizes[name] === "object" ? fileSizes[name]?.size : fileSizes[name];
      const size = Number.isFinite(Number(rawSize)) && Number(rawSize) > 0 ? Math.floor(Number(rawSize)) : 0;
      const entryBytes = Buffer.byteLength(name, "utf8") * 2 + 160;
      if (group.length && (group.length >= cap || groupBytes + size > maxBytes || manifestBytes + entryBytes > 32000)) {
        groups.push(group);
        group = [];
        groupBytes = 0;
        manifestBytes = 0;
      }
      group.push(name);
      manifestBytes += entryBytes;
      groupBytes += size;
      // An oversized file remains alone; callers can report it separately and avoid mixing it with other work.
      if (group.length === 1 && size > maxBytes) {
        groups.push(group);
        group = [];
        groupBytes = 0;
        manifestBytes = 0;
      }
    }
    if (group.length) groups.push(group);
    return groups;
  }
  if (list.length <= cap) return [list.slice()];
  const width = Math.min(slots, list.length);
  const span = Math.ceil(list.length / width);
  const groups = [];
  for (let offset = 0; offset < list.length; offset += span) groups.push(list.slice(offset, offset + span));
  return groups;
}

function transferCompression(options = {}) {
  const compression = options.compression === undefined ? "auto" : String(options.compression);
  if (!["auto", "gzip", "zstd", "none"].includes(compression)) throw new Error("compression 必须是 auto、gzip、zstd 或 none。");
  return compression === "auto" ? "gzip" : compression;
}

function requestedTransferCompression(options = {}) {
  const compression = options.compression === undefined ? "auto" : String(options.compression);
  if (!["auto", "gzip", "zstd", "none"].includes(compression)) throw new Error("compression 必须是 auto、gzip、zstd 或 none。");
  return compression;
}

async function negotiateTransferCompression(options, source, destination, timeoutMs) {
  return (await selectTransferCompression(options, source, destination, options.samplePaths || [], options.fileSizes || {})).compression;
}

function setCompressionProbeTransport(fn) { compressionProbeTransport = typeof fn === "function" ? fn : null; }

function runCompressionProbe(target, command) {
  if (compressionProbeTransport) return Promise.resolve().then(() => compressionProbeTransport(target, command));
  // Existing transport test doubles represent archive/hash channels only.
  if (remoteBatchTransport || mappedDownloadTransport) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const child = execSsh(target, command, { timeout: SAMPLE_TIMEOUT_MS, windowsHide: true, maxBuffer: 16384 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    const monitor = watchTransferProcess(child, reject, false, [], false);
    child.stdout?.on("data", monitor.receive);
  });
}

async function selectTransferCompression(options, source, destination, paths, sizes, gzipOnly = false) {
  const requested = requestedTransferCompression(options);
  if (requested === "none" || requested === "gzip") return { compression: requested, reason: "explicit", sampleBytes: 0 };
  const cancelled = () => options.token?.isCancellationRequested || transferContext.getStore()?.status === "cancelled";
  if (cancelled()) throw new Error("传输已取消");
  const probe = (target) => runCompressionProbe(target, "command -v zstd >/dev/null 2>&1 && printf supported || printf unavailable").then(value => String(value).trim() === "supported");
  if (requested === "zstd") {
    if (gzipOnly) throw new Error("映射下载支持 auto、gzip 或 none；此通道不支持 zstd。");
    const supported = await Promise.all([probe(source), probe(destination)]);
    if (cancelled()) throw new Error("传输已取消");
    if (!supported.every(Boolean)) throw new Error("来源和目标 Worker 必须都支持 zstd；未开始传输。");
    return { compression: "zstd", reason: "explicit-negotiated", sampleBytes: 0 };
  }
  const selected = chooseSampleFiles(paths, sizes);
  if (!selected.length) return { compression: "gzip", reason: "no-changed-files", sampleBytes: 0 };
  try {
    const request = JSON.stringify({ root: source.remotePath, paths: selected, zstd: !gzipOnly });
    const [text, supportsZstd] = await Promise.all([
      runCompressionProbe(source, `python3 -c ${shellQuote(compressionSampleScript)} ${shellQuote(request)}`),
      gzipOnly ? false : probe(destination),
    ]);
    if (cancelled()) throw new Error("传输已取消");
    const sample = JSON.parse(String(text));
    const history = compressionHistory.get(compressionHistory.key(source, destination));
    return chooseCompression(sample, supportsZstd ? ["gzip", "zstd"] : ["gzip"], history?.bytesPerSecond, !!history);
  } catch (error) {
    if (cancelled()) throw new Error("传输已取消");
    // Read-only sampling cannot change data authority; transfers still require complete hashes.
    return { compression: "gzip", reason: "sample-unavailable", sampleBytes: 0 };
  }
}

function tarPackingCommand(compression, telemetry = false) {
  return `tar --null -T - -cvf -${compressionStreamCommand(compression, telemetry)}`;
}

function compressionStreamCommand(compression, telemetry = false) {
  // Bound compressor CPU even when several transfers share the same Worker.
  const compressor = compression === "zstd" ? "zstd -T2 -6 -c" : "if command -v pigz >/dev/null 2>&1; then pigz -p 2 -6 -c; else gzip -6 -c; fi";
  const counter = "import sys,time; n=0; at=0\nwhile True:\n b=sys.stdin.buffer.read1(65536)\n if not b: break\n sys.stdout.buffer.write(b); sys.stdout.buffer.flush(); n+=len(b); now=time.monotonic()\n if now-at>=0.25:\n  sys.stderr.write('SIMPLE_COMPRESSION_WIRE '+str(n)+'\\n'); sys.stderr.flush(); at=now\nsys.stderr.write('SIMPLE_COMPRESSION_WIRE '+str(n)+'\\n'); sys.stderr.flush()";
  return `${compression === "none" ? "" : ` | (${compressor})`}${telemetry ? ` | python3 -c ${shellQuote(counter)}` : ""}`;
}

function tarUnpackingCommand(compression) {
  const decoder = compression === "zstd" ? "zstd -dc | " : compression === "none" ? "" : "gzip -dc | ";
  return `${decoder}tar -xvf - --index-file=/dev/stderr`;
}

function stagedTarUnpackingCommand(destination, compression, stageId, expectedFiles = {}, paths = Object.keys(expectedFiles)) {
  const entries = paths.map(name => {
    const item = expectedFiles[name];
    return { path: directSyncRelativePath(name), sha256: typeof item === "string" ? item : item?.sha256 || "", size: typeof item?.size === "number" ? item.size : null };
  });
  const identity = crypto.createHash("sha256").update(String(stageId || "") + JSON.stringify(entries)).digest("hex");
  const request = Buffer.from(JSON.stringify({ root: destination.remotePath, identity, entries }), "utf8");
  if (request.length > 65536) throw new Error("暂存 manifest 超过有界大小，必须拆分批次。");
  const payload = require("node:zlib").deflateRawSync(request).toString("base64");
  const decoder = compression === "zstd" ? "zstd -dc | " : compression === "none" ? "" : "gzip -dc | ";
  return decoder + stagedReceiverInvocation(payload);
}

function stagedReceiverInvocation(payload) {
  const source = fs.readFileSync(path.join(__dirname, "staged-tar-receive.py"), "utf8");
  const code = require("node:zlib").deflateSync(Buffer.from(source, "utf8")).toString("base64");
  const loader = "import base64,zlib,sys; code=zlib.decompress(base64.b64decode(sys.argv[1])); sys.argv=sys.argv[1:]; exec(compile(code,'simple_sftp_staged_receive','exec'))";
  return `python3 -c ${shellQuote(loader)} ${shellQuote(code)} ${shellQuote(payload)}`;
}

function directTarBatchCommand(source, destination, options = {}) {
  const compression = transferCompression(options);
  const destinationHost = `${destination.username}@${destination.host}`;
  const destinationScript = stagedTarUnpackingCommand(destination, compression, options.transferId, options.expectedFiles, options.groupPaths);
  const destinationCommand = `bash -o pipefail -c ${shellQuote(destinationScript)}`;
  const sshOptions = `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p ${destination.port}`;
  const sourceCommand = `root=$(realpath -e -- ${shellQuote(source.remotePath)}) && test "$root" = ${shellQuote(source.remotePath)} && cd -- "$root" && ${tarPackingCommand(compression, options.wireTelemetry === true)} | ${sshOptions} ${shellQuote(destinationHost)} ${shellQuote(destinationCommand)}`;
  return `bash -o pipefail -c ${shellQuote(sourceCommand)}`;
}

function chunkTransferCommand(target, request) {
  const payload = require("node:zlib").deflateRawSync(Buffer.from(JSON.stringify({ ...request, root: target.remotePath }), "utf8")).toString("base64");
  return stagedReceiverInvocation(payload);
}

function remoteTransferOutcomeUnknown() {
  const operationId = transferContext.getStore()?.operationId;
  return !!operationId && transferOperationLedger.get(operationId)?.outcomeUnknown === true;
}

async function transferChunkedServerFile(source, destination, name, timeoutMs, options) {
  try {
    const entry = options.expectedFiles?.[name];
    if (!entry || !Number.isSafeInteger(entry.size) || entry.size > 64 * 1024 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(entry.sha256 || "")) throw new Error("大文件分块需要完整 SHA256/size，单文件上限 64GiB。");
    const entries = [{ path: name, sha256: entry.sha256, size: entry.size }];
    const identity = crypto.createHash("sha256").update(JSON.stringify([destination.remotePath, entries])).digest("hex");
    const request = { identity, entries };
    // Checkpoint reconciliation can create/truncate an owned staging file and write its journal.
    // A disconnected status request therefore requires the same settlement protection as writes.
    const reply = await runRemoteBatchSsh(destination, chunkTransferCommand(destination, { ...request, mode: "chunkStatus" }), [], timeoutMs, { remoteMutation: true, stage: "核验分块检查点" });
    const status = JSON.parse(reply);
    const chunkBytes = 8 * 1024 * 1024;
    if (!Number.isSafeInteger(status.offset) || status.offset < 0 || status.offset >= entry.size || status.offset % chunkBytes || status.chunkBytes !== chunkBytes) throw new Error("大文件恢复检查点无效。");
    if (options.token?.isCancellationRequested || remoteTransferOutcomeUnknown()) throw new Error("旧传输未确认退出，未重发大文件分块。");
    const offset = status.offset;
    const read = chunkTransferCommand(source, { ...request, mode: "readChunks", offset }) + compressionStreamCommand(options.compression, options.wireTelemetry === true);
    const decode = options.compression === "zstd" ? "zstd -dc | " : options.compression === "none" ? "" : "gzip -dc | ";
    const receive = decode + chunkTransferCommand(destination, { ...request, mode: "receiveChunks", offset });
    const sourceCommand = `bash -o pipefail -c ${shellQuote(read)}`;
    const destinationCommand = `bash -o pipefail -c ${shellQuote(receive)}`;
    if (process.platform === "darwin") {
      await relayTarFilesCore(source, destination, [name], timeoutMs, { ...options, sourceCommand, destinationCommand });
      return;
    }
    const direct = `bash -o pipefail -c ${shellQuote(`${read} | ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p ${destination.port} ${shellQuote(`${destination.username}@${destination.host}`)} ${shellQuote(destinationCommand)}`)}`;
    try { await runRemoteBatchSsh(source, direct, [], timeoutMs, { ...options, stage: options.compression === "none" ? "分块传输" : "压缩分块传输" }); }
    catch (error) {
      if (remoteTransferOutcomeUnknown() || !/host key verification failed|no .* host key|permission denied|connect to host|network is unreachable|could not resolve hostname|connection refused/i.test(formatError(error))) throw error;
      await relayTarFilesCore(source, destination, [name], timeoutMs, { ...options, sourceCommand, destinationCommand });
    }
  } catch (error) {
    if (error instanceof Error) error.message = `大文件 ${name}（${source.host} → ${destination.host}）同步失败：${error.message}`;
    throw error;
  }
}

async function transferPartitionedTar(source, destination, paths, timeoutMs, onPartition, options = {}) {
  if (!paths.length) return transferPartitionedTarCore(source, destination, paths, timeoutMs, onPartition, options);
  return withFileResourceLease("Worker 批量同步", destination.remotePath, paths, remoteResourceServer(destination),
    () => transferPartitionedTarCore(source, destination, paths, timeoutMs, onPartition, options));
}
async function transferPartitionedTarCore(source, destination, paths, timeoutMs, onPartition, options = {}) {
  // Explicit grouped archives stay in one stream; other large batches use at most two.
  const groups = partitionTransferPaths(paths, options.singleStream === true ? Math.max(paths.length, 1) : 80,
    FPSYNC_PARALLEL_STREAMS, options.fileSizes, FPSYNC_MAX_BATCH_BYTES);
  let next = 0;
  let completed = 0;
  let completedFiles = 0;
  let failed = false;
  let failure = null;
  const report = (phase, index, group) => {
    if (failed || !onPartition) return;
    onPartition({ phase, index, groupFiles: group.length, completed, total: groups.length, completedFiles, totalFiles: paths.length });
  };
  const noteFailure = (error) => {
    failed = true;
    if (!failure) failure = error;
  };
  const workers = Array.from({ length: Math.min(FPSYNC_PARALLEL_STREAMS, groups.length) }, async () => {
    try {
      while (next < groups.length) {
        if (failed) return;
        const index = next;
        const group = groups[next++];
        if (!group || failed) return;
        report("start", index + 1, group);
        await Promise.resolve();
        if (failed) return;
        const transferId = require("crypto").createHash("sha256").update(group.join("\0")).digest("hex").slice(0, 32);
        if (group.length === 1 && Number(options.fileSizes?.[group[0]]) > FPSYNC_MAX_BATCH_BYTES) {
          await transferChunkedServerFile(source, destination, group[0], timeoutMs, options);
          if (failed) return;
          completed += 1;
          completedFiles += 1;
          report("done", index + 1, group);
          continue;
        }
        if (process.platform === "darwin") {
          await relayTarFilesCore(source, destination, group, timeoutMs, { ...options, transferId });
          if (failed) return;
          completed += 1;
          completedFiles += group.length;
          report("done", index + 1, group);
          continue;
        }
        const directCommand = directTarBatchCommand(source, destination, { ...options, transferId, groupPaths: group });
        try {
          await runRemoteBatchSsh(source, directCommand, group, timeoutMs, options);
        } catch (error) {
          const retryable = /host key verification failed|no .* host key|permission denied|connection timed out|connect to host|network is unreachable|could not resolve hostname|connection refused/i.test(formatError(error));
          if (!retryable || remoteTransferOutcomeUnknown()) {
            noteFailure(error);
            return;
          }
          try {
            await relayTarFiles(source, destination, group, timeoutMs, { ...options, transferId });
          } catch (relayError) {
            noteFailure(relayError);
            return;
          }
        }
        if (failed) return;
        completed += 1;
        completedFiles += group.length;
        report("done", index + 1, group);
      }
    } catch (error) {
      noteFailure(error);
      throw error;
    }
  });
  const settled = await Promise.allSettled(workers);
  const rejected = settled.find((item) => item.status === "rejected");
  if (failure) throw failure;
  if (rejected) throw rejected.reason;
  return groups.length;
}

function fpsyncProgressTitle(options = {}) {
  const raw = String(options.taskLabel || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const safe = raw
    .replace(/(password|passwd|token|secret|privateKey|private_key|agentToken)\s*[:=]\s*\S+/gi, "$1=<已遮蔽>")
    .replace(/Bearer\s+\S+/gi, "Bearer <已遮蔽>");
  if (safe) return `Worker 同步 · ${safe.slice(0, 180)}`;
  const source = String(options.source?.id || options.source?.host || "来源 Worker").slice(0, 40);
  const destination = String(options.destination?.id || options.destination?.host || "目标 Worker").slice(0, 40);
  const relative = options.directory ? String(options.relativePath || "")
    : Array.isArray(options.relativePaths) ? `${options.relativePaths.length} 个文件${options.relativePaths.length === 1 ? ` · ${options.relativePaths[0]}` : ""}` : "文件";
  return `Worker 同步 · ${source} → ${destination} · ${String(relative).slice(0, 80)}`;
}

async function syncServerToServerFpsync(options = {}) {
  const execute = (progress) => withTransferCapacity(options, () => syncServerToServerFpsyncCore(options, progress));
  if (options.apiMode) return execute({ report() {} });
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: fpsyncProgressTitle(options),
    cancellable: false,
  }, execute);
}

async function syncServerToServerFpsyncCore(options = {}, progress) {
  const notifyStartedAt = Date.now();
  const phaseLabels = { preparing: "准备清单", hashing: "SHA256 校验", packing: "流处理（打包、传输与解包）", transferring: "流处理（打包、传输与解包）",
    unpacking: "流处理（打包、传输与解包）", verifying: "内容复核", publishing: "发布文件", distributing: "本地分发" };
  const notification = options.apiMode ? undefined : transferContext.getStore()?.onProgress?.((snapshot) => {
    const label = phaseLabels[snapshot.phase] || "处理文件";
    const committed = snapshot.completedFiles !== undefined;
    const wire = committed || snapshot.phase === "transferring";
    const bytes = Number(wire ? snapshot.transferredBytes : snapshot.processedBytes) || 0;
    const files = committed ? `已完成 ${snapshot.completedFiles}/${snapshot.totalFiles} 个文件`
      : snapshot.processedFiles ? `阶段已处理 ${snapshot.processedFiles} 个文件` : "文件流处理中";
    const groups = snapshot.totalGroups ? ` · 分组 ${snapshot.completedGroups || 0}/${snapshot.totalGroups}` : "";
    progress.report({ message: `${label} · ${files}${groups} · ${Math.round(bytes / 1024)} KiB${wire ? " 实际流字节" : " 已处理"} · 已耗时 ${Math.floor((Date.now() - notifyStartedAt) / 1000)} 秒` });
  });
  try {
  const requestedCompression = requestedTransferCompression(options);
  const source = directSyncTarget(options.source, "来源");
  const destination = directSyncTarget(options.destination, "目标");
  if (source.host === destination.host && source.port === destination.port && source.remotePath === destination.remotePath) throw new Error("来源与目标相同。");
  const directory = options.directory === true;
  const relativePath = directory ? directSyncRelativePath(options.relativePath) : "";
  if (directory && relativePath.split("/").length < 2 && options.manualRetain !== true) throw new Error("目录同步必须限定到 Plan 独立子目录。");
  const requested = directory ? [] : [...new Set((Array.isArray(options.relativePaths) ? options.relativePaths : []).map(directSyncRelativePath))].sort();
  if (!directory && (!requested.length || requested.length > 5000)) throw new Error("批量同步需要 1–5000 个项目内文件路径。");
  if (options.confirm !== true || options.pathConfirmed !== true) throw confirmationRequired({
    method: "sync.serverToServerFpsync", operation: "Worker 间分批打包同步", requires: ["confirm", "pathConfirmed"],
    source, destination, relativePath, relativePaths: requested, directory,
  });
  const timeoutMs = transferTimeoutMs(source, options);
  let reportedPercent = 0;
  const advance = (percent, message) => {
    const next = Math.max(reportedPercent, Math.min(100, percent));
    progress.report({ increment: next - reportedPercent, message });
    reportedPercent = next;
  };
  progress.report({ message: directory ? `清单：比对目录 ${relativePath} 的来源和目标哈希…` : `清单：比对 ${requested.length} 个文件的来源和目标哈希…` });
  const inventoryStartedAt = Date.now();
  let sourcePayload;
  let destinationPayload;
  if (directory) {
    [sourcePayload, destinationPayload] = await Promise.all([
      inspectRemoteScope(source, relativePath, true, timeoutMs, true),
      inspectRemoteScope(destination, relativePath, true, timeoutMs),
    ]);
    const stale = Object.keys(destinationPayload.files).filter((name) => !sourcePayload.files[name]);
    if (stale.length) throw new Error(`目标目录有 ${stale.length} 个旧文件，需要先通过双重确认清理：${stale.slice(0, 3).join("、")}`);
  } else {
    [sourcePayload, destinationPayload] = await Promise.all([
      inspectRemoteBatchFiles(source, requested, timeoutMs),
      inspectRemoteBatchFiles(destination, requested, timeoutMs),
    ]);
    if (requested.some((name) => !sourcePayload.files[name])) throw new Error("来源 Worker 缺少批量同步文件；同步保持待处理。");
  }
  const sourceHashes = sourcePayload.files;
  const destinationHashes = destinationPayload.files;
  const inventoryMs = Math.max(0, Date.now() - inventoryStartedAt);
  const paths = directory ? Object.keys(sourceHashes).sort() : requested;
  const digest = (entry) => typeof entry === "string" ? entry : entry && entry.sha256;
  const fileSizes = Object.fromEntries(paths.map((name) => [name, Number(sourceHashes[name]?.size) || 0]));
  const changed = paths.filter((name) => digest(sourceHashes[name]) !== digest(destinationHashes[name]));
  const missingFiles = changed.filter(name => !digest(destinationHashes[name])).length;
  const differentFiles = changed.length - missingFiles;
  const unchangedFiles = paths.length - changed.length;
  const transferController = transferContext.getStore();
  if (transferController) {
    transferController.totalBytes = changed.reduce((sum, name) => sum + fileSizes[name], 0);
    transferController.comparedFiles = paths.length;
    transferController.changedFiles = changed.length;
    Object.assign(transferController, { missingFiles, differentFiles, unchangedFiles });
    transferController.updateProgress({ phase: "preparing", scope: transferController.id, processedFiles: 0,
      completedFiles: 0, totalFiles: changed.length, completedGroups: 0 });
  }
  const compressionDecision = changed.length
    ? await selectTransferCompression({ ...options, compression: requestedCompression }, source, destination, changed, fileSizes)
    : { compression: requestedCompression === "none" ? "none" : requestedCompression === "zstd" ? "zstd" : "gzip", reason: "no-changed-files", sampleBytes: 0 };
  const compression = compressionDecision.compression;
  let wireBytes = 0;
  const effectiveOptions = { ...options, compression, expectedFiles: sourceHashes, wireTelemetry: true, onWireBytes: (count) => { wireBytes += count; } };
  const planned = partitionTransferPaths(changed, options.singleStream === true ? Math.max(changed.length, 1) : 80,
    FPSYNC_PARALLEL_STREAMS, fileSizes, FPSYNC_MAX_BATCH_BYTES);
  progress.report({ message: changed.length
    ? "清单完成（" + inventoryMs + " ms）；跳过相同 " + unchangedFiles + "，目标缺失 " + missingFiles + "，内容不同 " + differentFiles + "；采用" + (compression === "none" ? "无压缩" : compression === "zstd" ? "zstd 压缩" : "gzip 压缩") + "流处理 " + changed.length + "/" + paths.length + " 个文件，共 " + planned.length + " 组"
    : `清单完成（${inventoryMs} ms）；${paths.length} 个文件均无需传输，准备校验…` });
  const streamStartedAt = Date.now();
  const partitions = await transferPartitionedTar(source, destination, changed, timeoutMs, (event) => {
    // Only a successfully exited, hash-verified receiver commits a whole group.
    // Child-local packing/unpacking counters must never overwrite this total.
    transferController?.updateProgress({ phase: "transferring", scope: `groups:${transferController.id}`,
      processedFiles: event.completedFiles, completedFiles: event.completedFiles, totalFiles: event.totalFiles,
      completedGroups: event.completed, totalGroups: event.total });
    if (event.phase === "start") {
      progress.report({ message: `正在流处理（打包、传输与解包）第 ${event.index}/${event.total} 组（${event.groupFiles} 个文件）· 已完成 ${event.completed}/${event.total} 组` });
      return;
    }
    const percent = event.totalFiles ? Math.floor(event.completedFiles * 90 / event.totalFiles) : 90;
    advance(percent, `第 ${event.index}/${event.total} 组流处理结束 · 已完成 ${event.completedFiles}/${event.totalFiles} 个文件`);
  }, { ...effectiveOptions, fileSizes });
  const streamMs = Math.max(0, Date.now() - streamStartedAt);
  compressionHistory.record(compressionHistory.key(source, destination), wireBytes, streamMs);
  advance(95, `流处理结束（${streamMs} ms，含打包、传输与解包）；正在校验目标 Worker 的 ${paths.length} 个文件…`);
  const verifyStartedAt = Date.now();
  const verifiedPayload = directory
    ? await inspectRemoteScope(destination, relativePath, true, timeoutMs)
    : await inspectRemoteBatchFiles(destination, requested, timeoutMs);
  const verified = verifiedPayload.files;
  const verifyMs = Math.max(0, Date.now() - verifyStartedAt);
  if (paths.some((name) => digest(sourceHashes[name]) !== digest(verified[name]))) throw new Error("分批打包同步后 SHA256 不一致；同步保持待处理。");
  const hashCache = {
    hits: sourcePayload.cacheHits + destinationPayload.cacheHits + verifiedPayload.cacheHits,
    rehash: sourcePayload.cacheRehash + destinationPayload.cacheRehash + verifiedPayload.cacheRehash,
    digestReads: sourcePayload.digestReads + destinationPayload.digestReads + verifiedPayload.digestReads,
    cacheQueries: sourcePayload.cacheQueries + destinationPayload.cacheQueries + verifiedPayload.cacheQueries,
  };
  const timing = {
    inventoryMs,
    streamMs,
    verifyMs,
    totalMs: Math.max(0, Date.now() - inventoryStartedAt),
    streamPhase: "pack+network+unpack",
    hashCache,
  };
  advance(100, `完成：传输 ${changed.length}/${paths.length} 个文件，SHA256 校验通过 · 清单 ${timing.inventoryMs} ms · 流处理 ${timing.streamMs} ms · 校验 ${timing.verifyMs} ms`);
  return { ok: true, paths: paths.length, transferredFiles: changed.length, partitions,
    verification: "sha256", transport: "partitioned-tar", compression, singleStream: options.singleStream === true,
    directory, relativePath, timing, hashCache, compressionDecision, wireBytes, missingFiles, differentFiles, unchangedFiles };
  } finally { notification?.dispose?.(); }
}

async function syncFromRemoteCore(options = {}) {
  try {
    const workspaceFolder = getPrimaryWorkspaceFolder();
    if (!workspaceFolder && !options.localPath) {
      const message = "请先打开 SimpleSFTP 工作区，或传入 localPath。";
      if (options.apiMode) throw new Error(message);
      vscode.window.showErrorMessage(message);
      return { ok: false, error: message };
    }

    const localPath = localPathText(options.localPath || getWorkspaceRoot(), process.platform);
    const hasTargetOptions = Boolean(options.server || options.remotePath || options.host);
    const sftp = hasTargetOptions ? resolveUploadSftp(localPath, options) : readSftpConfig(localPath);
    if (!sftp) {
      const message = hasTargetOptions ? "未提供可用的远端来源。" : "当前工作区未找到 .vscode/sftp.json。";
      if (options.apiMode) throw new Error(message);
      vscode.window.showErrorMessage(message);
      return { ok: false, error: message };
    }

    await confirmTransferPath({ localPath, sftp, operation: "远端同步到本地", detail: "远端项目文件覆盖到当前工作区", options });

    const cfg = vscode.workspace.getConfiguration("simpleSftpMac");
    const markerName = cfg.get("handoffMarkerName") || DEFAULT_HANDOFF_MARKER;
    const marker = await readRemoteHandoffMarker(sftp, markerName).catch(() => null);
    if (!options.apiMode && options.confirmMarker !== false && marker) {
      const action = await vscode.window.showInformationMessage(
        `上次交接上传：${marker.device || "未知设备"}，时间 ${formatTime(marker.markedAt)}。是否继续从远端同步到本地？`,
        "继续",
        "取消"
      );
      if (action !== "继续") return;
    }

    const syncStartedAt = new Date();
    const scopedPaths = Array.isArray(options.paths) ? options.paths : null;
    const downloadScope = scopedPaths ? explicitDownloadScope(options) : readTargetDownloadScope(localPath, options, sftp);
    if (scopedPaths) assertSafeScopedLocalPaths(localPath, downloadScope.paths);
    await downloadRemoteToLocal({ localPath, sftp, downloadScope });
    if (!scopedPaths) {
      writeLocalSessionRecord(localPath, {
        action: "remoteToLocal",
        device: getDeviceName(),
        remotePath: sftp.remotePath,
        at: new Date().toISOString(),
      });
      writeUploadState(localPath, {
        lastUploadedAt: syncStartedAt.toISOString(),
        mode: "remoteToLocal",
        remotePath: sftp.remotePath,
      });
    }
    if (options.apiMode) {
      return {
        ok: true,
        localPath,
        remotePath: sftp.remotePath,
        downloadedAt: syncStartedAt.toISOString(),
        ...(scopedPaths ? { paths: downloadScope.paths } : {}),
      };
    }
    vscode.window.showInformationMessage("SimpleSFTP 已完成远端到本地同步。");
  } catch (error) {
    if (options.apiMode) throw error;
    vscode.window.showErrorMessage(`启动远端到本地同步失败：${formatError(error)}`);
  }
}

async function markHandoffReady(options = {}) {
  const localPath = resolveLocalWorkspacePath(options.localPath, "上传并标记交接");
  return withHostOperationLease("mark-handoff-ready", "上传并标记交接", localPath, () => markHandoffReadyCore({ ...options, localPath }));
}

async function markHandoffReadyCore(options = {}) {
  try {
    const workspaceFolder = getPrimaryWorkspaceFolder();
    const localPath = localPathText(options.localPath || getWorkspaceRoot() || "", process.platform);
    if (!workspaceFolder && !localPath) {
      const message = "请先打开 SimpleSFTP 工作区，或由调用方传入 localPath。";
      if (options.apiMode) throw new Error(message);
      vscode.window.showErrorMessage(message);
      return { ok: false, error: message };
    }
    const sftp = readSftpConfig(localPath);
    if (!sftp || !sftp.remotePath || !sftp.host) {
      const message = "当前工作区没有可用的 .vscode/sftp.json。";
      if (options.apiMode) throw new Error(message);
      vscode.window.showErrorMessage(message);
      return { ok: false, error: message };
    }

    await confirmTransferPath({ localPath, sftp, operation: "写入交接标记", detail: "远端项目交接标记；若选择上传则包含全部本地文件", options });

    let uploadRequested = false;
    if (options.apiMode) {
      uploadRequested = options.upload === true;
    } else {
      const action = await vscode.window.showInformationMessage(
        "是否先上传全部本地代码，再把该项目标记为可交接到下一台设备？",
        "上传全部并标记",
        "仅标记",
        "取消"
      );
      if (!action || action === "取消") return { ok: false, cancelled: true };
      uploadRequested = action === "上传全部并标记";
    }

    if (uploadRequested) {
      await uploadAllLocalToRemote({ localPath, sftp, pathConfirmed: true });
    }

    const marker = {
      version: 1,
      project: path.posix.basename(String(sftp.remotePath).replace(/\/+$/, "")),
      remotePath: sftp.remotePath,
      localPath,
      device: getDeviceName(),
      user: os.userInfo().username,
      markedAt: new Date().toISOString(),
      uploadRequested,
      uploadMode: uploadRequested ? "all" : "none",
    };

    const cfg = vscode.workspace.getConfiguration("simpleSftpMac");
    const markerName = cfg.get("handoffMarkerName") || DEFAULT_HANDOFF_MARKER;
    await writeRemoteHandoffMarker(sftp, markerName, marker);
    writeLocalSessionRecord(localPath, {
      action: "handoffReady",
      ...marker,
    });

    if (options.apiMode) {
      return {
        ok: true,
        localPath,
        remotePath: sftp.remotePath,
        markedAt: marker.markedAt,
        uploadRequested,
      };
    }
    vscode.window.showInformationMessage(`SimpleSFTP 已由 ${marker.device} 写入交接标记。`);
  } catch (error) {
    if (options.apiMode) throw error;
    vscode.window.showErrorMessage(`写入交接标记失败：${formatError(error)}`);
  }
}

async function uploadWorkspace(options = {}) {
  const localPath = resolveLocalWorkspacePath(options.localPath, "上传工作区");
  return withHostOperationLease("upload-workspace", "上传工作区", localPath, () => uploadWorkspaceCore(options));
}

async function uploadWorkspaceCore(options = {}) {
  try {
    const localPath = resolveLocalWorkspacePath(options.localPath, "上传工作区");
    if (!localPath) throw new Error("请先打开工作区，或传入 localPath。");
    const sftp = resolveUploadSftp(localPath, options);
    if (options.expectedTransferTarget) assertTransferTargetUnchanged(options.expectedTransferTarget, sftp);
    if (!sftp || !sftp.remotePath || !sftp.host) {
      throw new Error("未提供可用的 SFTP 目标。");
    }
    const remoteRoot = String(sftp.remotePath || "").replace(/\/+$/, "");
    await confirmTransferPath({ localPath, sftp, operation: "上传工作区", detail: options.manifest ? "manifest 指定代码文件" : "当前工作区内未被忽略的文件", options });
    migrateLegacyCodeSyncState(localPath);
    const state = createCodeSyncState(sftp, options);
    const manifest = getManagedManifest(options.manifest);
    const previousState = manifest && options.pruneManagedFiles !== false && options.transientManifest !== true
      ? await readRemoteCodeManifest(sftp).catch(() => null)
      : null;
    const previousManifest = previousState && typeof previousState === "object" ? previousState.manifest : null;
    const legacyManagedDir = previousState && typeof previousState === "object" ? previousState.legacyManagedDir : "";
    let uploadStats;
    if (manifest) {
      const before = options.preComparedManifest === true
        ? { mismatches: Object.keys(manifest) }
        : await inspectRemoteManagedFiles(sftp, manifest, transferTimeoutMs(sftp, options));
      uploadStats = await uploadManifestLocalFilesToRemote({
        localPath,
        sftp,
        manifest,
        changedPaths: before.mismatches,
        uploadOptions: options,
      });
      const after = await inspectRemoteManagedFiles(sftp, manifest, transferTimeoutMs(sftp, options));
      if (after.mismatches.length) throw new Error(`远端代码内容校验失败：${after.mismatches.slice(0, 12).join("、")}`);
      uploadStats.verification = { method: "remote-sha256", checkedFiles: Object.keys(manifest).length, changedFiles: before.mismatches.length };
    } else {
      uploadStats = await uploadAllLocalToRemote({ localPath, sftp, writeState: options.stateFileMode !== "virtual", pathConfirmed: true, options });
    }
    const missingManagedFiles = manifest && options.pruneManagedFiles !== false && options.transientManifest !== true
      ? getMissingManagedFiles(previousManifest, manifest, sftp.ignore)
      : [];
    const prune = await pruneRemoteMissingManagedFiles(sftp, missingManagedFiles);
    if (options.transientManifest !== true) await writeRemoteCodeSyncState(sftp, state, options.manifest);
    if (options.stateFileMode !== "virtual") {
      writeLocalCodeSyncState(localPath, state);
    }
    const legacyLocalManagedDir = path.join(localPath, "zlk_cluster");
    const hasLegacyLocalManagedDir = fs.existsSync(legacyLocalManagedDir);
    if (hasLegacyLocalManagedDir) {
      void vscode.window.showWarningMessage(`检测到本地旧版托管目录 ${legacyLocalManagedDir}。新状态已写入 simple_cluster；请人工核对后手动删除。`);
    }
    if (legacyManagedDir && !options.apiMode) {
      void vscode.window.showWarningMessage(`检测到旧版托管目录 ${remoteRoot}/${legacyManagedDir}。新上传已改用 ${remoteRoot}/simple_cluster；请人工核对其中的自有文件后手动删除该目录。`);
    }
    return {
      ok: true,
      targetId: options.targetId || options.id || sftp.name || sftp.host,
      remotePath: sftp.remotePath,
      fingerprint: state.fingerprint,
      uploadedAt: state.updatedAt,
      deletedRemoteFiles: prune.deleted,
      stats: uploadStats,
      legacyManagedPath: legacyManagedDir ? `${remoteRoot}/${legacyManagedDir}` : "",
      cleanupRequired: Boolean(legacyManagedDir || hasLegacyLocalManagedDir),
    };
  } catch (error) {
    if (options.apiMode) throw error;
    const message = `上传工作区失败：${formatError(error)}`;
    vscode.window.showErrorMessage(message);
    return { ok: false, error: message };
  }
}

async function uploadManifestLocalFilesToRemote({ localPath, sftp, manifest, changedPaths, uploadOptions = {} }) {
  const uploadPlan = createManifestUploadPlan({ localPath, sftp, manifest, changedPaths });
  if (uploadPlan.fileCount > 0) {
    return await runUploadWithProgress(uploadOptions, `上传受管理代码文件 -> ${sftp.remotePath}`, (token, progress) => runLocalTarUpload({
        localPath,
        sftp,
        uploadPlan,
        operation: "上传受管理代码文件",
        timeoutMs: transferTimeoutMs(sftp, uploadOptions),
        token,
        transferId: uploadOptions.transferId,
        progress,
      }));
  }
  return {
    fileCount: 0,
    byteCount: 0,
    excludedRuleHits: 0,
    excludedNestedGitRepos: 0,
    nestedGitRoots: [],
    durationMs: 0,
    verification: { method: "manifest-empty" },
  };
}

async function uploadFiles(options = {}) {
  const localPath = resolveLocalWorkspacePath(options.localBase || options.localPath, "上传指定文件");
  const operationId = String(transferContext.getStore()?.operationId || options.transferId || nextTransferId("upload-files"));
  activeUploadOperations.set(operationId, { id: operationId, stage: "acquiring-lease", startedAt: new Date().toISOString() });
  try {
    return await withHostOperationLease("upload-files", "上传指定文件", localPath, () => {
      setUploadOperationStage(operationId, "preparing-files");
      return uploadFilesCore({ ...options, transferId: operationId });
    });
  } finally {
    activeUploadOperations.delete(operationId);
  }
}

function setUploadOperationStage(operationId, stage) {
  const operation = activeUploadOperations.get(operationId);
  if (operation) operation.stage = stage;
}

async function uploadFilesCore(options = {}) {
  try {
    const localBase = resolveLocalWorkspacePath(options.localBase || options.localPath, "上传指定文件");
    if (!localBase) throw new Error("请先打开工作区，或传入 localBase。");
    const sftp = resolveUploadSftp(localBase, options);
    if (options.expectedTransferTarget) assertTransferTargetUnchanged(options.expectedTransferTarget, sftp);
    if (!sftp || !sftp.remotePath || !sftp.host) throw new Error("没有可用的 SFTP 上传目标。");
    const files = Array.isArray(options.files) ? options.files : [];
    if (!files.length && !options.manifest) throw new Error("没有要上传的文件。");
    setUploadOperationStage(options.transferId, "confirming-path");
    await confirmTransferPath({ localPath: localBase, sftp, operation: "上传指定文件", detail: filesSummary(options.files), options });
    setUploadOperationStage(options.transferId, "preparing-files");
    const relativePaths = [];
    const uploadPlanFiles = [];
    for (const item of files) {
      const rawLocalPath = typeof item === "string" ? item : String(item && (item.localPath || item.path) || "");
      const localPath = resolveUploadFilePath(rawLocalPath);
      if (!localPath || !fs.existsSync(localPath) || !fs.lstatSync(localPath).isFile()) {
        throw new Error(`本地文件不存在：${localPath || "-"}`);
      }
      const remoteName = sanitizeRelativeUploadPath(typeof item === "string" ? path.basename(localPath) : (item.remoteName || item.relativePath || path.basename(localPath)));
      relativePaths.push(toPosixPath(remoteName));
      uploadPlanFiles.push({ relativePath: toPosixPath(remoteName), fullPath: localPath, size: fs.statSync(localPath).size });
    }
    if (options.manifest) {
      const content = Buffer.from(`${JSON.stringify(options.manifest, null, 2)}\n`, "utf8");
      if (content.length > 2 * 1024 * 1024) throw new Error("运行清单超过 2MiB 上限。");
      relativePaths.push("runtime_manifest.json");
      uploadPlanFiles.push({ relativePath: "runtime_manifest.json", content, size: content.length });
    }
    setUploadOperationStage(options.transferId, "transferring");
    const stats = await runUploadWithProgress(options, `上传指定文件 -> ${sftp.remotePath}`, (token, progress) => runLocalTarUpload({
        localPath: localBase,
        sftp,
        uploadPlan: { files: uploadPlanFiles, fileCount: uploadPlanFiles.length, byteCount: uploadPlanFiles.reduce((total, file) => total + file.size, 0), excludedRuleHits: 0, excludedNestedGitRepos: 0, nestedGitRoots: [] },
        operation: "上传指定文件",
        timeoutMs: transferTimeoutMs(sftp, options),
        token,
        transferId: options.transferId,
        progress,
      }));
    setUploadOperationStage(options.transferId, "transfer-complete");
    return {
      ok: true,
      targetId: options.targetId || options.id || sftp.name || sftp.host,
      remotePath: sftp.remotePath,
      files: relativePaths,
      stats: stats,
      uploadedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (options.apiMode) throw error;
    const message = `上传指定文件失败：${formatError(error)}`;
    vscode.window.showErrorMessage(message);
    return { ok: false, error: message };
  }
}

function resolveUploadSftp(localPath, options) {
  const incomingServer = options && typeof options.server === "object" ? options.server : {};
  const sharedServer = sharedServerForOptions(options, incomingServer);
  const existing = readSftpConfig(localPath) || {};
  const server = { ...sharedServer, ...incomingServer };
  const host = firstNonEmpty(
    incomingServer.transferHost,
    incomingServer.resolvedHost,
    incomingServer.sftpHost,
    incomingServer.sshHost,
    incomingServer.host,
    incomingServer.sshConfigHost,
    incomingServer.sshConfigAlias,
    options.sftpHost,
    options.sshHost,
    options.host,
    options.sshConfigHost,
    options.sshConfigAlias,
    sharedServer.transferHost,
    sharedServer.resolvedHost,
    sharedServer.sftpHost,
    sharedServer.sshHost,
    sharedServer.host,
    existing.host
  );
  const user = String(server.user || server.username || options.user || options.username || existing.username || "").trim();
  const remotePath = remotePathText(requestedRemotePath(options) || sharedServer.remotePath || sharedServer.remoteBase || existing.remotePath, process.platform);
  const port = normalizeSshPort(server.sshPort || server.port || options.sshPort || options.port || existing.port, 22);
  const ignore = mergeIgnorePatterns(DEFAULT_IGNORES, FIXED_IGNORES);
  return {
    ...existing,
    name: String(options.targetId || server.id || server.label || existing.name || host || "simple-sftp-target"),
    host,
    protocol: "sftp",
    port,
    username: user,
    remotePath,
    uploadOnSave: false,
    downloadOnOpen: false,
    useTempFile: false,
    openSsh: true,
    connectTimeoutSeconds: resolvedConnectTimeoutSeconds(server.connectTimeoutSeconds),
    ignore,
  };
}

function requestedRemotePath(options = {}) {
  const server = options.server && typeof options.server === "object" ? options.server : {};
  const top = remotePathText(options.remotePath ?? options.remoteBase, process.platform, true);
  const nested = remotePathText(server.remotePath ?? server.remoteBase, process.platform, true);
  if (top && nested && top !== nested) {
    throw new Error(`远端目标冲突：请求 ${top}，服务器对象 ${nested}。已阻止传输。`);
  }
  return top || nested;
}

function assertTransferTargetUnchanged(expected, actual) {
  const fields = ["host", "port", "username", "remotePath"];
  if (fields.some((field) => String(expected?.[field] || "") !== String(actual?.[field] || ""))) {
    throw new Error("上传目标在确认后发生变化，已阻止传输。");
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function sharedServerForOptions(options, server) {
  const candidates = sharedServerCandidateKeys(options, server);
  if (!candidates.length) return {};
  const data = readSharedServers();
  const found = data.servers.find((item) => {
    if (!item) return false;
    const keys = sharedServerCandidateKeys(item, item);
    return keys.some((key) => candidates.some((candidate) => candidate.toLowerCase() === key.toLowerCase()));
  });
  if (!found && typeof options?.server === "string" && options.server.trim()) {
    throw new Error(`未找到指定的 SFTP 服务器：${options.server.trim()}`);
  }
  return found || {};
}

function sharedServerCandidateKeys(options, server) {
  const raw = [
    options && options.targetId,
    options && options.id,
    options && typeof options.server === "string" ? options.server : "",
    server && server.targetId,
    server && server.id,
    server && server.label,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  const out = [];
  for (const key of raw) {
    out.push(key);
    out.push(key.replace(/-(agent-runtime|runtime|code-sync|workspace|files)$/i, ""));
  }
  return [...new Set(out.filter(Boolean))];
}

function createCodeSyncState(sftp, options) {
  return {
    version: 1,
    targetId: options.targetId || options.id || sftp.name || sftp.host,
    targetRole: options.targetRole || "",
    remotePath: sftp.remotePath,
    fingerprint: options.fingerprint || "",
    manifest: options.manifest || null,
    source: "local",
    transport: "simple-sftp",
    updatedAt: new Date().toISOString(),
  };
}

function writeLocalCodeSyncState(localPath, state) {
  const dir = path.join(localPath, "simple_cluster");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "code_sync_state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function atomicWriteJsonIfMissing(targetPath, value) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (fs.existsSync(targetPath)) return false;
  const temp = `${targetPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, targetPath);
  return true;
}

function migrateLegacyCodeSyncState(localPath) {
  const newPath = path.join(localPath, "simple_cluster", "code_sync_state.json");
  const legacyPath = path.join(localPath, "zlk_cluster", "code_sync_state.json");
  if (fs.existsSync(newPath) || !fs.existsSync(legacyPath)) return false;
  try {
    const legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
    if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
      return false;
    }
    return atomicWriteJsonIfMissing(newPath, {
      ...legacy,
      migration: {
        source: "zlk_cluster/code_sync_state.json",
        migratedAt: new Date().toISOString(),
        mode: "copy_read_only_source",
      },
    });
  } catch {
    return false;
  }
}

async function pruneRemoteMissingManagedFiles(sftp, missing) {
  if (!missing.length) return { deleted: 0 };
  let deleted = 0;
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const script = [
      "import json, os",
      `root=${JSON.stringify(String(sftp.remotePath).replace(/\/+$/, ""))}`,
      `paths=json.loads(${JSON.stringify(JSON.stringify(chunk))})`,
      "deleted=0",
      "for rel in paths:",
      "    rel=rel.replace('\\\\','/').lstrip('/')",
      "    if not rel or rel.startswith('../') or '/../' in rel or rel.startswith('simple_cluster/') or rel.startswith('zlk_cluster/'):",
      "        continue",
      "    target=os.path.abspath(os.path.join(root, rel))",
      "    base=os.path.abspath(root)",
      "    if not (target == base or target.startswith(base + os.sep)):",
      "        continue",
      "    parent=os.path.realpath(os.path.dirname(target))",
      "    if os.path.commonpath((os.path.realpath(base),parent))!=os.path.realpath(base): continue",
      "    if os.path.isfile(target) and not os.path.islink(target):",
      "        try: os.chdir(parent)",
      "        except OSError as error: raise RuntimeError('PARENT_CD_FAILED: '+str(error))",
      "        if os.path.realpath(os.getcwd())!=parent: raise RuntimeError('PARENT_CD_FAILED')",
      "        os.remove('./'+os.path.basename(target)); deleted += 1",
      "print(deleted)",
    ].join("\n");
    const stdout = await runSsh(sftp, `python3 - <<'PY'\n${script}\nPY`, 60000);
    deleted += Number(String(stdout).trim() || 0) || 0;
  }
  return { deleted };
}

function getManagedManifest(manifest) {
  return manifest && typeof manifest === "object" && !Array.isArray(manifest) ? manifest : null;
}

function getManifestUploadRelativePaths({ localPath, manifest }) {
  const managedManifest = getManagedManifest(manifest);
  if (!managedManifest) return [];
  const paths = [];
  let legacyManagedPathWarned = false;
  for (const key of Object.keys(managedManifest).sort((a, b) => a.localeCompare(b))) {
    const relativePath = sanitizeRelativeUploadPath(key);
    if (relativePath.replace(/\\/g, "/").toLowerCase().startsWith("zlk_cluster/")) {
      if (!legacyManagedPathWarned) {
        void vscode.window.showWarningMessage(`检测到旧版托管路径 ${relativePath}；新版本不会上传它。请人工核对后删除本地/远端旧版 zlk_cluster 目录。`);
        legacyManagedPathWarned = true;
      }
      continue;
    }
    if (!isSafeRemoteManagedPath(relativePath)) {
      throw new Error(`不安全的受管理代码路径：${relativePath}`);
    }
    const fullPath = path.join(localPath, relativePath);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      throw new Error(`manifest 文件缺失：${relativePath}`);
    }
    paths.push(relativePath);
  }
  return paths;
}

function getMissingManagedFiles(previous, manifest, ignorePatterns) {
  const managedManifest = getManagedManifest(manifest);
  const previousFiles = previous && typeof previous.files === "object" && previous.files && !Array.isArray(previous.files)
    ? Object.keys(previous.files)
    : [];
  if (!managedManifest || !previousFiles.length) return [];
  const nextFiles = new Set(Object.keys(managedManifest));
  return previousFiles
    .filter((relativePath) => !nextFiles.has(relativePath))
    .filter(isSafeRemoteManagedPath)
    .filter((relativePath) => !isIgnoredLocalPath(relativePath, ignorePatterns))
    .sort((a, b) => a.localeCompare(b));
}

async function readRemoteCodeManifest(sftp) {
  const remoteRoot = `${String(sftp.remotePath).replace(/\/+$/, "")}`;
  const managedDirs = [
    { dir: "simple_cluster", legacy: false },
    { dir: "zlk_cluster", legacy: true },
  ];
  for (const managedDir of managedDirs) {
    const manifestPath = `${remoteRoot}/${managedDir.dir}/code_sync_manifest.json`;
    const stdout = await runSsh(sftp, `if [ -f ${shellQuote(manifestPath)} ]; then cat ${shellQuote(manifestPath)}; fi`, 20000);
    const text = String(stdout || "").trim();
    if (text) {
      return {
        manifest: JSON.parse(text),
        legacyManagedDir: managedDir.legacy ? managedDir.dir : "",
      };
    }
  }
  return null;
}

function inspectRemoteManagedFiles(sftp, manifest, timeoutMs) {
  const files = getManagedManifest(manifest);
  if (!files) throw new Error("代码 manifest 格式无效。");
  for (const [relativePath, item] of Object.entries(files)) {
    if (!isSafeRemoteManagedPath(relativePath) || !/^[a-f0-9]{64}$/i.test(String(item?.sha256 || "")))
      throw new Error(`代码 manifest 路径或 SHA256 无效：${relativePath}`);
  }
  const script = [
    "import hashlib,json,os,sys,time",
    "root=os.path.realpath(sys.argv[1]); files=json.load(sys.stdin); bad=[]; processed=0; progress_at=0",
    "for rel,item in files.items():",
    " parts=rel.split('/')",
    " if not rel or any(p in ('','.','..') for p in parts): raise ValueError('unsafe path')",
    " target=os.path.join(root,*parts)",
    " if any(os.path.islink(os.path.join(root,*parts[:i])) for i in range(1,len(parts)+1)): raise ValueError('symlink path: '+rel)",
    " if os.path.commonpath((root,os.path.realpath(target)))!=root: raise ValueError('path outside project')",
    " if not os.path.isfile(target): bad.append(rel); continue",
    " h=hashlib.sha256()",
    " with open(target,'rb') as stream:",
    "  for chunk in iter(lambda:stream.read(1048576),b''):",
    "   h.update(chunk); processed+=len(chunk)",
    "   now=time.monotonic()",
    "   if now-progress_at>=0.25:",
    "    print('SIMPLE_PROGRESS '+json.dumps({'phase':'verifying','processedBytes':processed}),file=sys.stderr,flush=True); progress_at=now",
    " if h.hexdigest()!=str(item.get('sha256','')).lower(): bad.append(rel)",
    "print('SIMPLE_PROGRESS '+json.dumps({'phase':'verifying','processedBytes':processed}),file=sys.stderr,flush=True)",
    "print(json.dumps({'mismatches':bad}))",
  ].join("\n");
  const command = `python3 -c ${shellQuote(script)} ${shellQuote(String(sftp.remotePath).replace(/\/+$/, ""))}`;
  return new Promise((resolve, reject) => {
    const child = spawnSsh(sftp, command, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = null;
    const monitor = watchTransferProcess(child, finish);
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString("utf8")).slice(-20 * 1024 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-16384); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) return finish(new Error(`远端代码 SHA256 校验失败：${stderr.trim() || `SSH 退出码 ${code}`}`));
      try {
        const result = JSON.parse(stdout);
        if (!Array.isArray(result.mismatches) || result.mismatches.some((name) => !Object.hasOwn(files, name))) throw new Error("校验结果无效");
        finish(null, result);
      } catch (error) { finish(new Error(`远端代码 SHA256 校验响应无效：${formatError(error)}`)); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(files));
  });
}

async function writeRemoteCodeSyncState(sftp, state, manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return;
  const files = [
    ["simple_cluster/code_sync_state.json", state],
    ["simple_cluster/code_sync_manifest.json", { version: 1, files: manifest, updatedAt: new Date().toISOString() }],
  ].map(([relativePath, value]) => {
    const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (content.length > 2 * 1024 * 1024) throw new Error("代码同步清单超过 2MiB 上限。");
    return { relativePath, content, size: content.length };
  });
  await runLocalTarUpload({
      localPath: sftp.remotePath,
      sftp,
      uploadPlan: {
        files,
        fileCount: 2,
        byteCount: files.reduce((sum, file) => sum + file.size, 0),
        excludedRuleHits: 0,
        excludedNestedGitRepos: 0,
        nestedGitRoots: [],
      },
      operation: "上传代码同步 manifest",
  });
}

function isSafeRemoteManagedPath(relativePath) {
  if (process.platform === "darwin") {
    try { relativePath = normalizeMacRelativePath(relativePath); } catch { return false; }
  }
  const normalized = toPosixPath(relativePath).replace(/^\/+/, "");
  if (!normalized || (process.platform !== "darwin" && normalized.includes("..")) || path.posix.isAbsolute(normalized)) return false;
  if (/[\\]|\0/.test(normalized)) return false;
  const segments = normalized.toLowerCase().split("/");
  const top = segments[0];
  // The manifest producer owns file-type and size policy. Reapplying a
  // directory/name allowlist here rejects files the user explicitly selected.
  // Keep only transport-level confinement and plugin-state protections.
  if ([".git", ".vscode", ".codex", "zlk_cluster"].includes(top)) return false;
  if (top === "simple_cluster") return true;
  return true;
}

function sanitizeRelativeUploadPath(value) {
  if (process.platform === "darwin") return normalizeMacRelativePath(value, "非法远端相对路径：");
  const normalized = toPosixPath(String(value || "").replace(/^\/+/, ""));
  if (!normalized || normalized.includes("..") || path.posix.isAbsolute(normalized)) {
    throw new Error(`非法远端相对路径：${value}`);
  }
  return normalized;
}

function targetScopeKey(options, sftp) {
  const server = options && typeof options.server === "object" ? options.server : {};
  return String(options.targetId || options.id || server.id || server.label || sftp.name || `${sftp.host}:${sftp.remotePath}`).trim();
}

function targetDownloadScopeStatePath(localPath) {
  return path.join(localPath, "simple_cluster", TARGET_DOWNLOAD_SCOPE_STATE);
}

function normalizeDownloadExtensions(values) {
  const extensions = [...new Set((Array.isArray(values) ? values : DEFAULT_DOWNLOAD_EXTENSIONS)
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .map((value) => value === "*" ? value : value.startsWith(".") ? value : `.${value}`))];
  if (!extensions.length) throw new Error("至少保留一种下载文件类型，或填写 *。");
  if (extensions.some((value) => value !== "*" && !/^\.[a-z0-9][a-z0-9._+-]*$/.test(value))) {
    throw new Error("文件类型格式无效；请使用 .py、.yaml 这类扩展名，或填写 *。");
  }
  return extensions.sort((a, b) => a.localeCompare(b));
}

function normalizeDownloadMaxFileSizeMB(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0.1 || size > 1048576) {
    throw new Error("单文件大小上限必须在 0.1–1048576 MB 之间。");
  }
  return Math.round(size * 100) / 100;
}

function normalizeDownloadScopePath(value) {
  const normalized = process.platform === "darwin" ? normalizeMacRelativePath(value, "下载范围相对路径", true)
    : toPosixPath(String(value || "").trim()).replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized === ".") return ".";
  if (path.posix.isAbsolute(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`下载范围必须是远端项目内相对路径：${value}`);
  }
  if (downloadScopeBlockedPath(normalized)) {
    throw new Error(`下载范围包含插件或版本控制状态目录：${value}`);
  }
  return normalized;
}

function downloadScopeBlockedPath(relative) {
  const parts = String(relative || "").toLowerCase().split("/");
  if (parts.some((part) => [".git", ".vscode", ".codex", "zlk_cluster"].includes(part))) return true;
  if (parts[0] !== "simple_cluster") return false;
  if (parts.length === 1) return false;
  if (parts[1] === "results" || parts[1] === "debug_runs") return false;
  if (parts[1] === "tmp" && parts.length === 2) return false;
  if (parts[1] === "tmp" && parts[2] === "cluster_scheduler")
    return parts.length > 3 && parts[3] !== "logs" && !parts.at(-1).endsWith(".log");
  if (parts[1] === "tmp" && parts[2] === "tmux_logs") return false;
  return true;
}

function normalizeDownloadScope(value = {}) {
  return {
    paths: [...new Set((Array.isArray(value.paths) ? value.paths : []).map(normalizeDownloadScopePath))].sort((a, b) => a.localeCompare(b)),
    extensions: normalizeDownloadExtensions(value.extensions),
    maxFileSizeMB: value.noSizeLimit === true ? null : normalizeDownloadMaxFileSizeMB(value.maxFileSizeMB ?? DEFAULT_DOWNLOAD_MAX_FILE_SIZE_MB),
    ...(value.noSizeLimit === true ? { noSizeLimit: true } : {}),
  };
}

function explicitDownloadScope(options = {}) {
  if (!Array.isArray(options.paths) || !options.paths.length)
    throw new Error("显式下载路径必须是一个或多个项目内文件或目录，禁止选择整个项目根目录。");
  const scope = normalizeDownloadScope({ paths: options.paths, extensions: ["*"], noSizeLimit: true });
  if (scope.paths.includes(".")) throw new Error("显式下载路径必须是一个或多个项目内文件或目录，禁止选择整个项目根目录。");
  return scope;
}

const MAPPED_DOWNLOAD_DEFAULT_MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAPPED_DOWNLOAD_DEFAULT_MAX_BATCH_BYTES = 128 * 1024 * 1024;
const MAPPED_DOWNLOAD_MAX_ENTRIES = 256;
const METRIC_DOWNLOAD_EXTENSIONS = new Set([".csv", ".json", ".md", ".txt", ".log"]);
const WEIGHT_DOWNLOAD_EXTENSIONS = new Set([".pt", ".pth", ".ckpt", ".safetensors", ".bin", ".onnx", ".pkl", ".pickle"]);

function normalizeMappedRelativePath(value, label) {
  if (process.platform === "darwin") return normalizeMacRelativePath(value, label);
  const raw = toPosixPath(String(value || "").trim());
  if (!raw || raw === "." || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || path.win32.isAbsolute(String(value || "").trim())) {
    throw new Error(`${label}必须是项目内相对文件路径：${value}`);
  }
  const normalized = raw.replace(/^\.\//, "").replace(/\/+$/g, "");
  if (normalized.length > 4096 || normalized.includes(":")) throw new Error(`${label}包含不安全路径段：${value}`);
  if (!normalized || normalized === "." || path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`${label}必须是项目内相对文件路径：${value}`);
  }
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label}包含越界或空路径段：${value}`);
  }
  if (/[\0\r\n]/.test(normalized)) throw new Error(`${label}包含非法字符：${value}`);
  return normalized;
}

function mappedDownloadMaxFileBytes(value) {
  if (value == null || value === "") return MAPPED_DOWNLOAD_DEFAULT_MAX_FILE_BYTES;
  const size = Number(value);
  if (!Number.isFinite(size) || size < 1 || size > 1024 * 1024 * 1024) {
    throw new Error("映射下载单文件上限必须在 1 字节到 1 GiB 之间。");
  }
  return Math.floor(size);
}

function mappedDownloadMaxBatchBytes(value) {
  if (value == null || value === "") return MAPPED_DOWNLOAD_DEFAULT_MAX_BATCH_BYTES;
  const size = Number(value);
  if (!Number.isFinite(size) || size < 1 || size > MAPPED_DOWNLOAD_DEFAULT_MAX_BATCH_BYTES) {
    throw new Error(`映射下载单批未压缩上限必须在 1 字节到 ${MAPPED_DOWNLOAD_DEFAULT_MAX_BATCH_BYTES} 字节之间。`);
  }
  return Math.floor(size);
}

function rejectMappedDownloadKind(remotePath, options) {
  const lower = remotePath.toLowerCase();
  const extension = path.posix.extname(lower);
  const base = path.posix.basename(lower);
  const metricsOnly = options.metricsOnly === true || options.kind === "metrics";
  if (metricsOnly) {
    if (WEIGHT_DOWNLOAD_EXTENSIONS.has(extension) || /(^|\/)(weights?|checkpoints?)(\/|$)/.test(lower)) {
      throw new Error(`映射下载拒绝权重或检查点文件：${remotePath}`);
    }
    const wrapper = options.wrapperResults === true && options.memoryOnly === true;
    if (wrapper && (!extension || /\.(pt|pth|ckpt|safetensors|onnx|bin|py|pyc|js|ts|sh|exe|dll|lock|pid)$/i.test(extension)
      || /(^|\/)(code_backup|\.runtime|__pycache__|clean_dir)(\/|$)/i.test(lower)))
      throw new Error(`wrapper 内存下载拒绝代码、状态或权重：${remotePath}`);
    if (!wrapper && !METRIC_DOWNLOAD_EXTENSIONS.has(extension)) {
      throw new Error(`指标批量下载只接受 csv/json/md/txt/log：${remotePath}`);
    }
    if (base.endsWith(".csv.lock") || base === ".tb_mean.lock") {
      throw new Error(`映射下载拒绝锁文件：${remotePath}`);
    }
  }
  if (downloadScopeBlockedPath(remotePath)) {
    throw new Error(`映射下载路径包含插件或版本控制状态目录：${remotePath}`);
  }
}

function normalizeMappedDownloadEntries(options = {}) {
  const raw = Array.isArray(options.entries) ? options.entries : null;
  if (!raw || !raw.length) throw new Error("映射下载必须提供 entries，且不能扫描整个项目。");
  if (raw.length > MAPPED_DOWNLOAD_MAX_ENTRIES) {
    throw new Error(`映射下载一次最多 ${MAPPED_DOWNLOAD_MAX_ENTRIES} 个文件，当前 ${raw.length} 个。`);
  }
  const memoryOnly = options.memoryOnly === true;
  if (memoryOnly && options.metricsOnly !== true) throw new Error("内存下载只允许明确的指标文件。");
  const maxFileBytes = Math.min(mappedDownloadMaxFileBytes(options.maxFileBytes), memoryOnly ? 4 * 1024 * 1024 : Infinity);
  const maxBatchBytes = Math.min(mappedDownloadMaxBatchBytes(options.maxBatchBytes), memoryOnly ? 4 * 1024 * 1024 : Infinity);
  const overwrite = options.overwrite === true;
  const seenRemote = new Map();
  const seenLocal = new Map();
  const entries = raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`映射下载第 ${index + 1} 项必须是对象。`);
    }
    const remotePath = normalizeMappedRelativePath(item.remotePath, "远端路径");
    const localRelativePath = normalizeMappedRelativePath(item.localRelativePath, "本机相对路径");
    rejectMappedDownloadKind(remotePath, options);
    const remoteKey = remotePath;
    const localKey = localRelativePath.toLowerCase();
    if (seenRemote.has(remoteKey)) throw new Error(`映射下载远端路径重复：${remotePath}`);
    if (seenLocal.has(localKey)) throw new Error(`映射下载本机路径重复：${localRelativePath}`);
    seenRemote.set(remoteKey, remotePath);
    seenLocal.set(localKey, localRelativePath);
    const declared = item.bytes == null || item.bytes === "" ? null : Number(item.bytes);
    if (declared != null && (!Number.isFinite(declared) || declared < 0 || declared > maxFileBytes)) {
      throw new Error(`映射下载条目超过单文件上限 ${maxFileBytes} 字节：${remotePath}`);
    }
    if (declared != null && declared > maxBatchBytes) {
      throw new Error(`映射下载条目超过单批上限 ${maxBatchBytes} 字节：${remotePath}`);
    }
    const sha256 = String(item.sha256 || "").trim().toLowerCase();
    if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`映射下载条目 SHA256 无效：${remotePath}`);
    if (memoryOnly && (!sha256 || declared == null || !Number.isSafeInteger(declared))) throw new Error(`内存指标下载必须提供大小和 SHA256：${remotePath}`);
    return { remotePath, localRelativePath, bytes: declared == null ? null : Math.floor(declared), sha256, index };
  });
  const byteCount = entries.reduce((total, entry) => total + (entry.bytes || 0), 0);
  if (byteCount > maxBatchBytes) throw new Error(`映射下载批次超过未压缩上限 ${maxBatchBytes} 字节。`);
  return {
    entries,
    maxFileBytes,
    maxBatchBytes,
    overwrite,
    memoryOnly,
    requestedCompression: requestedTransferCompression(options),
    compression: transferCompression({ compression: options.compression === undefined ? "auto" : options.compression }),
    byteCount,
  };
}

function assertMappedLocalDestinations(localPath, plan) {
  const root = path.resolve(localPath);
  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`本机项目目录不存在：${root}`);
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`本机项目目录必须是真实目录：${root}`);
  let rootReal;
  try { rootReal = fs.realpathSync(root); }
  catch { throw new Error(`无法解析本机项目目录：${root}`); }
  for (const entry of plan.entries) {
    const full = path.resolve(root, ...entry.localRelativePath.split("/"));
    const within = path.relative(root, full);
    if (!within || within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
      throw new Error(`本机映射路径超出项目根目录：${entry.localRelativePath}`);
    }
    let cursor = root;
    const parts = entry.localRelativePath.split("/");
    for (const [index, part] of parts.entries()) {
      cursor = path.join(cursor, part);
      let stat;
      try { stat = fs.lstatSync(cursor); }
      catch (error) {
        if (error.code === "ENOENT") break;
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error(`本机映射路径包含符号链接：${cursor}`);
      const last = index === parts.length - 1;
      if (!last && !stat.isDirectory()) throw new Error(`本机映射路径的父级不是目录：${cursor}`);
      if (last && stat.isDirectory()) throw new Error(`本机映射目标是目录，不能当作文件：${cursor}`);
      if (last && !stat.isFile()) throw new Error(`本机映射目标不是普通文件：${cursor}`);
      if (last && stat.isFile()) {
        let real;
        try { real = fs.realpathSync(cursor); }
        catch { throw new Error(`无法解析已有本机文件：${cursor}`); }
        const realWithin = path.relative(rootReal, real);
        if (realWithin === ".." || realWithin.startsWith(`..${path.sep}`) || path.isAbsolute(realWithin)) {
          throw new Error(`已有本机文件解析后超出项目根目录：${entry.localRelativePath}`);
        }
        if (!plan.overwrite) throw new Error(`本机文件已存在，未确认覆盖：${entry.localRelativePath}`);
      }
    }
    entry.localFullPath = full;
  }
}

function assertSafeScopedLocalPaths(localPath, paths) {
  const root = path.resolve(localPath);
  try { if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`本机项目目录是符号链接：${root}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const relative of paths) {
    const full = path.resolve(root, ...relative.split("/"));
    const within = path.relative(root, full);
    if (!within || within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within))
      throw new Error(`本机下载路径超出项目根目录：${relative}`);
    let cursor = root;
    const parts = relative.split("/");
    for (const [index, part] of parts.entries()) {
      cursor = path.join(cursor, part);
      let stat;
      try { stat = fs.lstatSync(cursor); }
      catch (error) { if (error.code === "ENOENT") break; throw error; }
      if (stat.isSymbolicLink() || index < parts.length - 1 && !stat.isDirectory())
        throw new Error(`本机下载路径包含符号链接或非目录：${cursor}`);
    }
  }
}

function readTargetDownloadScope(localPath, options, sftp) {
  const file = targetDownloadScopeStatePath(localPath);
  if (!fs.existsSync(file)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    const item = state && typeof state === "object" ? state[targetScopeKey(options || {}, sftp || {})] : null;
    if (!item || !Array.isArray(item.paths) || !item.paths.length) return null;
    return normalizeDownloadScope(item);
  } catch {
    return null;
  }
}

function writeTargetDownloadScope(localPath, options, sftp, scope) {
  const file = targetDownloadScopeStatePath(localPath);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) state = {};
  } catch {
    state = {};
  }
  const normalized = normalizeDownloadScope(scope);
  const key = targetScopeKey(options || {}, sftp || {});
  state[key] = {
    targetId: key,
    host: sftp.host,
    username: sftp.username,
    port: sftp.port,
    remotePath: sftp.remotePath,
    ...normalized,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state[key];
}

function relativeRemoteScopePath(remoteRoot, selectedPath) {
  const base = process.platform === "darwin" ? remotePathText(remoteRoot, "darwin") : path.posix.normalize(String(remoteRoot || "").replace(/\/+$/, ""));
  const selected = process.platform === "darwin" ? remotePathText(selectedPath, "darwin") : path.posix.normalize(String(selectedPath || "").replace(/\/+$/, ""));
  if (!base || !selected || (selected !== base && !selected.startsWith(`${base}/`))) {
    throw new Error(`所选远端路径超出项目根目录：${selectedPath}`);
  }
  return normalizeDownloadScopePath(selected === base ? "." : selected.slice(base.length + 1));
}

async function configureDownloadScope(options = {}) {
  const localPath = resolveLocalWorkspacePath(options.localPath, "设置下载文件范围");
  return withHostOperationLease("configure-download-scope", "设置下载文件范围", localPath, () => configureDownloadScopeCore({ ...options, localPath }));
}

async function configureDownloadScopeCore(options = {}) {
  try {
    const localPath = resolveLocalWorkspacePath(options.localPath, "设置下载文件范围");
    const hasTargetOptions = Boolean(options && (options.server || options.remotePath || options.host));
    const sftp = hasTargetOptions ? resolveUploadSftp(localPath, options) : readSftpConfig(localPath);
    if (!sftp || !sftp.remotePath || !sftp.host) throw new Error("未提供可用的 SFTP 目标。");
    await confirmTransferPath({ localPath, sftp, operation: "设置下载文件范围", detail: "浏览远端项目目录并保存允许下载的范围", options });

    const current = readTargetDownloadScope(localPath, options, sftp) || normalizeDownloadScope({ paths: [] });
    if (options.apiMode) {
      const saved = writeTargetDownloadScope(localPath, options, sftp, {
        paths: Array.isArray(options.paths) ? options.paths : current.paths,
        extensions: Array.isArray(options.extensions) ? options.extensions : current.extensions,
        maxFileSizeMB: options.maxFileSizeMB ?? current.maxFileSizeMB,
      });
      return { ok: true, targetId: targetScopeKey(options, sftp), remotePath: sftp.remotePath, scope: saved };
    }

    const action = await vscode.window.showQuickPick([
      { label: "$(folder-opened) 添加远端文件夹", description: "浏览远端项目；选中后立即保存", id: "folder" },
      { label: "$(file-add) 添加远端文件", description: "先进入所在目录，再多选文件", id: "file" },
      { label: "$(symbol-file) 设置允许的文件类型", description: current.extensions.join("、"), id: "extensions" },
      { label: "$(file-binary) 设置单文件大小上限", description: `${current.maxFileSizeMB} MB`, id: "max-size" },
      { label: "$(list-selection) 查看已选远端路径", description: `${current.paths.length} 条`, id: "preview" },
      { label: "$(trash) 移除已选远端路径", description: current.paths.join("、") || "暂无", id: "remove" },
    ], { title: "设置下载文件范围", placeHolder: "只下载明确选择的远端文件或文件夹", ignoreFocusOut: true });
    if (!action) return { ok: false, cancelled: true };

    let next = { ...current, paths: [...current.paths] };
    if (action.id === "extensions") {
      const value = await vscode.window.showInputBox({
        title: "允许下载的文件类型",
        prompt: "用英文逗号分隔，例如 .py,.yaml,.json；填写 * 表示任意类型。",
        value: current.extensions.join(","),
        ignoreFocusOut: true,
        validateInput: (input) => { try { normalizeDownloadExtensions(input.split(",")); return undefined; } catch (error) { return formatError(error); } },
      });
      if (value === undefined) return { ok: false, cancelled: true };
      next.extensions = normalizeDownloadExtensions(value.split(","));
    } else if (action.id === "max-size") {
      const value = await vscode.window.showInputBox({
        title: "下载单文件大小上限",
        prompt: "单位 MB，允许 0.1–1048576。",
        value: String(current.maxFileSizeMB),
        ignoreFocusOut: true,
        validateInput: (input) => { try { normalizeDownloadMaxFileSizeMB(Number(input)); return undefined; } catch (error) { return formatError(error); } },
      });
      if (value === undefined) return { ok: false, cancelled: true };
      next.maxFileSizeMB = normalizeDownloadMaxFileSizeMB(Number(value));
    } else if (action.id === "preview") {
      if (!current.paths.length) {
        void vscode.window.showInformationMessage("尚未设置下载文件范围；远端到本地同步会沿用原有整项目规则。");
        return { ok: true, scope: current };
      }
      await vscode.window.showQuickPick(current.paths.map((relative) => ({ label: relative, description: `${sftp.remotePath.replace(/\/+$/, "")}/${relative === "." ? "" : relative}` })), { title: "已选远端下载路径", placeHolder: "只读预览", ignoreFocusOut: true });
      return { ok: true, scope: current };
    } else if (action.id === "remove") {
      if (!current.paths.length) return { ok: true, scope: current };
      const picked = await vscode.window.showQuickPick(current.paths.map((relative) => ({ label: relative, picked: true })), { title: "移除远端下载路径", canPickMany: true, ignoreFocusOut: true });
      if (!picked?.length) return { ok: false, cancelled: true };
      const removed = new Set(picked.map((item) => item.label));
      next.paths = current.paths.filter((relative) => !removed.has(relative));
    } else if (action.id === "folder") {
      const selected = await pickRemoteDirectory({ remoteBase: sftp.remotePath, sftp, title: "选择允许下载的远端文件夹", showHiddenTopLevel: true, confineToBase: true });
      if (!selected) return { ok: false, cancelled: true };
      next.paths = [...new Set([...current.paths, relativeRemoteScopePath(sftp.remotePath, selected)])].sort((a, b) => a.localeCompare(b));
    } else if (action.id === "file") {
      const selectedDir = await pickRemoteDirectory({ remoteBase: sftp.remotePath, sftp, title: "进入远端文件所在目录", showHiddenTopLevel: true, confineToBase: true });
      if (!selectedDir) return { ok: false, cancelled: true };
      relativeRemoteScopePath(sftp.remotePath, selectedDir);
      const files = await listRemoteFiles(sftp, selectedDir);
      const picked = await vscode.window.showQuickPick(files.map((file) => ({ label: file.name, description: formatBytes(file.sizeBytes), file })), { title: `选择远端文件：${selectedDir}`, canPickMany: true, ignoreFocusOut: true });
      if (!picked?.length) return { ok: false, cancelled: true };
      const selectedPaths = picked.map((item) => relativeRemoteScopePath(sftp.remotePath, `${selectedDir}/${item.file.name}`));
      next.paths = [...new Set([...current.paths, ...selectedPaths])].sort((a, b) => a.localeCompare(b));
    }

    const saved = writeTargetDownloadScope(localPath, options, sftp, next);
    void vscode.window.showInformationMessage(`下载范围已保存：${saved.paths.length} 条路径，${saved.extensions.join("、")}，单文件不超过 ${saved.maxFileSizeMB} MB。`);
    return { ok: true, targetId: targetScopeKey(options, sftp), remotePath: sftp.remotePath, scope: saved };
  } catch (error) {
    if (options.apiMode) throw error;
    const message = `设置下载文件范围失败：${formatError(error)}`;
    vscode.window.showErrorMessage(message);
    return { ok: false, error: message };
  }
}

function mergeIgnorePatterns(...groups) {
  const out = new Set();
  for (const group of groups) {
    for (const item of Array.isArray(group) ? group : []) {
      const value = String(item || "").trim();
      if (value) out.add(value);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

async function pickRemoteDirectory({ remoteBase, sftp, title = "选择远端项目根目录", showHiddenTopLevel = false, confineToBase = false }) {
  if (process.platform === "darwin") remoteBase = remotePathText(remoteBase, "darwin", true);
  let current = remoteBase === "/" ? "/" : remoteBase.replace(/\/+$/, "");
  const initial = current;
  for (;;) {
    if (confineToBase) relativeRemoteScopePath(remoteBase, current);
    const dirs = await listRemoteDirs(sftp, current);
    const items = [
      {
        label: "$(check) 使用当前目录",
        description: current,
        kind: "use",
      },
      {
        label: "$(edit) 手动输入路径",
        description: "粘贴远端项目根目录",
        kind: "manual",
      },
    ];

    if (current !== initial) {
      items.push({
        label: "$(arrow-up) 返回上一级",
        description: path.posix.dirname(current),
        kind: "up",
      });
    }

    for (const dir of dirs) {
      if (!showHiddenTopLevel && current === initial && HIDDEN_TOP_LEVEL.has(dir)) {
        continue;
      }
      items.push({
        label: `$(folder) ${dir}`,
        description: path.posix.join(current, dir),
        kind: "dir",
        name: dir,
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: current,
      matchOnDescription: true,
    });
    if (!picked) return null;
    if (picked.kind === "use") return current;
    if (picked.kind === "up") {
      current = path.posix.dirname(current);
      continue;
    }
    if (picked.kind === "manual") {
      const manual = await vscode.window.showInputBox({
        title: "远端项目根目录",
        prompt: "输入远端项目根目录路径。",
        value: current,
      });
      if (!manual) return null;
      const selected = remotePathText(manual, process.platform);
      if (confineToBase) relativeRemoteScopePath(remoteBase, selected);
      return selected;
    }
    if (picked.kind === "dir") {
      current = path.posix.join(current, picked.name);
    }
  }
}

function listRemoteFiles(sftp, remotePath) {
  if (process.platform === "darwin") remotePath = remotePathText(remotePath, "darwin", true);
  const command = process.platform === "darwin"
    ? `find ${shellQuote(remotePath)} -mindepth 1 -maxdepth 1 -type f -printf '%f\\0%s\\0'`
    : `find ${shellQuote(remotePath)} -mindepth 1 -maxdepth 1 -type f -printf '%f\\t%s\\n' 2>/dev/null | sort`;
  return new Promise((resolve, reject) => {
    const child = execSsh(sftp, command, { timeout: 0, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`列出远端文件失败：${stderr || error.message}`));
        return;
      }
      if (process.platform === "darwin") {
        try {
          if (!stdout) { resolve([]); return; }
          const fields = stdout.split("\0");
          if (fields.pop() !== "" || fields.length % 2) throw new Error("远端文件列表不完整。");
          const files = [], seen = new Set();
          for (let index = 0; index < fields.length; index += 2) {
            const name = normalizeMacRelativePath(fields[index], "远端文件名");
            const sizeText = fields[index + 1], sizeBytes = Number(sizeText);
            if (name !== fields[index] || name.includes("/") || seen.has(name) || !/^\d+$/.test(sizeText) || !Number.isSafeInteger(sizeBytes)) throw new Error("远端文件列表包含无效条目。");
            seen.add(name); files.push({ name, sizeBytes });
          }
          resolve(files.sort((a, b) => a.name.localeCompare(b.name)));
        } catch (error) { reject(error); }
      } else resolve(stdout.split(/\r?\n/).map((line) => {
        const [name, sizeText] = line.split("\t");
        return { name: String(name || "").trim(), sizeBytes: Number(sizeText) || 0 };
      }).filter((item) => item.name));
    });
    const monitor = watchTransferProcess(child, reject, false);
    child.stdout?.on("data", monitor.receive);
  });
}

function listRemoteDirs(sftp, remotePath) {
  const args = createListRemoteDirsSshArgs(sftp, remotePath);
  return new Promise((resolve, reject) => {
    const child = execSsh(sftp, args.at(-1), { timeout: 0, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`列出远端目录失败：${stderr || error.message}`));
        return;
      }
      if (process.platform === "darwin") {
        const names = stdout.split("\0").filter(Boolean);
        try {
          for (const name of names) {
            if (name.includes("/")) throw new Error("远端目录列表包含无效的文件夹名称。");
            remotePathText("/" + name, process.platform);
          }
          resolve(names);
        } catch (error) { reject(error); }
      } else resolve(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    });
    const monitor = watchTransferProcess(child, reject, false);
    child.stdout?.on("data", monitor.receive);
  });
}

function createListRemoteDirsSshArgs(sftp, remotePath) {
  const command = process.platform === "darwin"
    ? `find ${shellQuote(remotePath)} -mindepth 1 -maxdepth 1 -type d -printf '%f\\0' 2>/dev/null | sort -z`
    : `find ${shellQuote(remotePath)} -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' 2>/dev/null | sort`;
  return getSshArgs(sftp, command);
}

async function writeWorkspace({
  execHost,
  localPath,
  projectName,
  remotePath,
  sftp: remoteSftp,
  serverLabel,
  userName,
  writeAgentsFile,
}) {
  const vscodeDir = path.join(localPath, ".vscode");
  fs.mkdirSync(vscodeDir, { recursive: true });

  const workspaceSftp = {
    name: createWorkspaceTargetName(serverLabel || remoteSftp.name || remoteSftp.host, projectName),
    host: remoteSftp.host,
    protocol: "sftp",
    port: normalizeSshPort(remoteSftp.port, 22),
    username: remoteSftp.username || userName || "",
    remotePath,
    uploadOnSave: false,
    downloadOnOpen: false,
    useTempFile: false,
    openSsh: true,
    ignore: DEFAULT_IGNORES,
  };

  fs.writeFileSync(
    path.join(vscodeDir, "sftp.json"),
    `${JSON.stringify(workspaceSftp, null, 2)}\n`,
    "utf8"
  );

  if (writeAgentsFile !== false) {
    upsertAgentsFile({ execHost, localPath, remotePath, userName: workspaceSftp.username, port: workspaceSftp.port });
    addGitInfoExclude(localPath, "AGENTS.md");
  }
}

function createWorkspaceTargetName(serverLabel, projectName) {
  const base = String(serverLabel || "simple-sftp-target").trim() || "simple-sftp-target";
  const project = String(projectName || "project").trim() || "project";
  return `${base}-${project}`.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function getPrimaryWorkspaceFolder() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0] : null;
}

function workspaceMappingConfig() {
  const cfg = vscode.workspace.getConfiguration("simpleSftpMac");
  return {
    hostRoot: cfg.get("workspaceHostRoot") || "",
    containerRoot: cfg.get("workspaceContainerRoot") || "",
    remoteScheme: "vscode-remote",
    platform: process.platform,
  };
}

function workspaceLocationForFolder(folder) {
  if (!folder || !folder.uri) return null;
  const uri = folder.uri;
  const location = resolveWorkspaceLocation({
    scheme: uri.scheme,
    path: uri.path,
    fsPath: uri.fsPath,
    external: typeof uri.toString === "function" ? uri.toString(true) : "",
  }, workspaceMappingConfig());
  if (location.remote && process.platform !== "win32") {
    throw new Error("远程工作区必须由 Windows UI Extension Host 执行。请确认 SimpleSFTP 未运行于 Linux workspace host。");
  }
  return location;
}

function getWorkspaceRoot(folder = getPrimaryWorkspaceFolder()) {
  const location = workspaceLocationForFolder(folder);
  return location ? location.hostPath : "";
}

async function withFileResourceLease(operation, project, paths, server, work) {
  if (!transferContext.getStore()) require("./mac-update-gate").assertBusinessAllowed();
  if (process.platform !== "win32" && !(process.platform === "darwin" && process.arch === "arm64")) throw new Error("SimpleSFTP 文件副作用必须由受支持的本地 UI Extension Host 执行。");
  const targetProject = server === "local" ? path.resolve(project) : String(project).replace(/\/+$/, "");
  const resources = (paths.length ? paths : [targetProject]).map(target => ({
    server, project: targetProject, target: server === "local" ? path.resolve(targetProject, target) : (target.startsWith("/") ? target : targetProject + "/" + target),
  }));
  return hostOperationLease.run({ pluginId: "simple-local.simple-sftp-mac", workspaceUri: "file://" + targetProject,
    hostProjectPath: targetProject, actionType: operation, actionLabel: operation, resources }, work);
}
function remoteResourceServer(sftp) { return String(sftp.host).toLowerCase() + ":" + normalizeSshPort(sftp.port, 22); }

async function withHostOperationLease(actionType, actionLabel, localPath, operation) {
  if (!transferContext.getStore()) require("./mac-update-gate").assertBusinessAllowed();
  if (process.platform !== "win32" && !(process.platform === "darwin" && process.arch === "arm64")) {
    throw new Error("SimpleSFTP 文件副作用必须由受支持的本地 UI Extension Host 执行。");
  }
  if (/^(upload-|download-|sync-from-remote|mark-handoff-ready)/.test(actionType)) return operation();
  const folders = Array.isArray(vscode.workspace.workspaceFolders) ? vscode.workspace.workspaceFolders : [];
  const folder = getWorkspaceFolderForFile(localPath) || (folders.length === 1 ? folders[0] : null);
  const location = folder ? workspaceLocationForFolder(folder) : null;
  const hostProjectPath = String(location && location.hostPath || localPath || "(未打开工作区)");
  const workspaceUri = String(location && location.editorUri || folder && folder.uri && folder.uri.toString?.(true) || "untitled://simple-sftp/no-workspace");
  try {
    return await hostOperationLease.run({
      pluginId: "simple-local.simple-sftp-mac",
      workspaceUri,
      hostProjectPath,
      actionType,
      actionLabel,
    }, operation);
  } catch (error) {
    if (error instanceof HostOperationLeaseConflictError) {
      await vscode.window.showErrorMessage(error.message, { modal: true }, "知道了");
    }
    throw error;
  }
}

function workspaceHostPathForUri(uri) {
  if (!uri) throw new Error("缺少工作区文件 URI。");
  const location = resolveWorkspaceLocation({
    scheme: uri.scheme,
    path: uri.path,
    fsPath: uri.fsPath,
    external: typeof uri.toString === "function" ? uri.toString(true) : "",
  }, workspaceMappingConfig());
  if (location.remote && process.platform !== "win32") {
    throw new Error("远程工作区文件必须由 Windows UI Extension Host 处理。");
  }
  return location.hostPath;
}

function resolveLocalWorkspacePath(value, operation) {
  const input = localPathText(value, process.platform);
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) return input;
  const location = workspaceLocationForFolder(folder);
  if (!input) return location.hostPath;
  if (!location.remote) return input;

  let resolved = input;
  if (input.startsWith("/") && !input.startsWith("//")) {
    resolved = resolveWorkspaceLocation({
      scheme: "vscode-remote",
      path: input,
      fsPath: input,
      external: input,
    }, workspaceMappingConfig()).hostPath;
  } else {
    resolved = path.win32.normalize(input);
  }
  const relative = path.win32.relative(location.hostPath, resolved);
  if (relative === ".." || relative.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(relative)) {
    throw new Error(`${operation || "当前操作"}的本地路径不在当前宿主工作区内：${input}`);
  }
  return resolved;
}

function resolveUploadFilePath(value) {
  const input = localPathText(value, process.platform);
  const folder = getPrimaryWorkspaceFolder();
  if (!input || !folder) return input;
  const location = workspaceLocationForFolder(folder);
  if (!location.remote || !input.startsWith("/") || input.startsWith("//")) return input;
  return resolveWorkspaceLocation({
    scheme: "vscode-remote",
    path: input,
    fsPath: input,
    external: input,
  }, workspaceMappingConfig()).hostPath;
}

function workspaceEditorUriForRelative(relativePath) {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) throw new Error("请先打开工作区。");
  const normalized = path.posix.normalize(String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, ""));
  if (!normalized || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`只能打开当前工作区内文件：${relativePath}`);
  }
  const location = workspaceLocationForFolder(folder);
  if (location.remote) return vscode.Uri.joinPath(folder.uri, ...normalized.split("/"));
  return vscode.Uri.file(path.join(location.hostPath, ...normalized.split("/")));
}

async function openWorkspaceRelativeFile(relativePath) {
  const document = await vscode.workspace.openTextDocument(workspaceEditorUriForRelative(relativePath));
  await vscode.window.showTextDocument(document, { preview: false });
}

function transferPathConfirmationKey(localPath, sftp) {
  const local = process.platform === "win32" ? path.win32.normalize(String(localPath || "")).toLowerCase() : path.posix.normalize(String(localPath || ""));
  const remote = String(sftp && sftp.remotePath || "").replace(/\/+$/, "");
  const host = String(sftp && sftp.host || "").trim().toLowerCase();
  const port = normalizeSshPort(sftp && sftp.port, 22);
  return `${local}|${host}:${port}|${remote}`;
}

function refreshConnectTimeoutFromConfig() {
  const value = Number(vscode.workspace.getConfiguration("simpleSftpMac").get("connectTimeoutSeconds", 15));
  defaultConnectTimeoutSeconds = Number.isFinite(value) && value >= 0
    ? Math.min(Math.max(0, Math.floor(value)), 3600)
    : 15;
}

function resolvedConnectTimeoutSeconds(value) { return 30; }

function nextTransferId(operation) {
  transferSequence += 1;
  return `transfer-${Date.now()}-${transferSequence}-${String(operation || "").replace(/[^\w.-]+/g, "-")}`;
}

function createTransferController({ id, operation, localPath, remotePath, host }) {
  const listeners = new Set();
  const progressListeners = new Set();
  let cancelled = false;
  let cancelReason = "";
  let disposed = false;
  const controller = {
    id,
    operation,
    localPath,
    remotePath,
    host,
    operationId: transferContext.getStore()?.operationId || id,
    phase: "preparing",
    processedFiles: 0,
    processedBytes: 0,
    progressScope: id,
    lastProgressAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    status: "running",
    totalBytes: 0,
    transferredBytes: 0,
    onCancel(listener) {
      if (disposed) return;
      if (cancelled) {
        queueMicrotask(() => listener(cancelReason));
        return;
      }
      listeners.add(listener);
      return { dispose() { listeners.delete(listener); } };
    },
    onProgress(listener) { progressListeners.add(listener); return { dispose() { progressListeners.delete(listener); } }; },
    cancel(reason) {
      if (disposed || cancelled) return false;
      cancelled = true;
      cancelReason = String(reason || "传输已取消");
      controller.status = "cancelled";
      idle.dispose();
      localApiServer?.publish({ type: "transfer_cancelled", data: { id, operationId: controller.operationId, reason: cancelReason, status: "cancelled" } });
      for (const listener of [...listeners]) {
        try { listener(cancelReason); } catch {}
      }
      return true;
    },
    pause() { idle.pause(); parentController?.pause(); },
    resume() { idle.resume(); parentController?.resume(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      idle.dispose();
      parentCancellation?.dispose?.();
      listeners.clear();
      progressListeners.clear();
      activeTransfers.delete(controller.id);
      void maybeSettleTransferOperation(controller.operationId);
    },
  };
  const idle = new ProgressInactivity(120000, () => controller.cancel(`文件步骤（${controller.phase}）120 秒无真实进展，已取消。请检查该阶段日志和目标状态后重试。`));
  let transferredBytes = 0;
  const wireScopes = new Map();
  let lastEventAt = 0;
  Object.defineProperty(controller, "transferredBytes", { enumerable: true, get: () => transferredBytes, set: (value) => { if (disposed || cancelled) return; transferredBytes = Math.max(transferredBytes, Number(value) || 0); controller.updateProgress({ processedBytes: transferredBytes, phase: "transferring" }); } });
  controller.updateProgress = (evidence) => {
    if (disposed || cancelled || !idle.update(evidence)) return false;
    const phaseChanged = Boolean(evidence.phase && evidence.phase !== controller.phase);
    if (evidence.metric === "wire") {
      const scope = String(evidence.scope || id), count = Math.max(0, Number(evidence.processedBytes) || 0);
      const previous = wireScopes.get(scope) || 0;
      transferredBytes += Math.max(0, count - previous);
      wireScopes.set(scope, Math.max(previous, count));
      while (wireScopes.size > 128) wireScopes.delete(wireScopes.keys().next().value);
    }
    if (evidence.phase) controller.phase = evidence.phase;
    controller.progressScope = evidence.scope || id;
    if (evidence.processedBytes !== undefined) controller.processedBytes = evidence.processedBytes;
    if (evidence.processedFiles !== undefined) controller.processedFiles = evidence.processedFiles;
    for (const key of ["cacheHits", "cacheRehash"]) controller[key] = Number.isSafeInteger(evidence[key]) && evidence[key] >= 0 ? evidence[key] : undefined;
    controller.cacheStatus = ["ready", "unavailable", "read-failed", "write-failed"].includes(evidence.cacheStatus) ? evidence.cacheStatus : undefined;
    for (const key of ["completedFiles", "totalFiles", "completedGroups", "totalGroups"]) {
      if (Number.isSafeInteger(evidence[key]) && evidence[key] >= 0)
        controller[key] = Math.max(controller[key] || 0, evidence[key]);
    }
    controller.lastProgressAt = new Date(idle.lastProgressAt).toISOString();
    if (phaseChanged || Date.now() - lastEventAt >= 200 || evidence.status) {
      lastEventAt = Date.now();
      const snapshot = { id, operationId: controller.operationId, phase: controller.phase, processedBytes: controller.processedBytes,
        transferredBytes, totalBytes: controller.totalBytes, comparedFiles: controller.comparedFiles, changedFiles: controller.changedFiles,
        missingFiles: controller.missingFiles, differentFiles: controller.differentFiles, unchangedFiles: controller.unchangedFiles,
        cacheHits: controller.cacheHits, cacheRehash: controller.cacheRehash, cacheStatus: controller.cacheStatus,
        progressScope: controller.progressScope, processedFiles: controller.processedFiles,
        completedFiles: controller.completedFiles, totalFiles: controller.totalFiles,
        completedGroups: controller.completedGroups, totalGroups: controller.totalGroups,
        lastProgressAt: controller.lastProgressAt, status: controller.status };
      localApiServer?.publish({ type: "transfer_progress", data: snapshot });
      for (const listener of progressListeners) { try { listener(snapshot); } catch {} }
    }
    if (parentController && parentController !== controller) parentController.updateProgress(evidence);
    return true;
  };
  const parentController = transferContext.getStore();
  const parentCancellation = parentController?.onCancel((reason) => controller.cancel(reason));
  activeTransfers.set(controller.id, controller);
  if (parentController?.status === "cancelled") controller.cancel("上层操作已取消");
  return controller;
}

function listActiveTransfers() {
  return [...activeTransfers.values()].map(({ id, operation, localPath, remotePath, host, startedAt, status, totalBytes, transferredBytes, operationId, phase, processedFiles, processedBytes, progressScope, lastProgressAt, comparedFiles, changedFiles, completedFiles, totalFiles, completedGroups, totalGroups, missingFiles, differentFiles, unchangedFiles, cacheHits, cacheRehash, cacheStatus }) => ({
    id,
    operation,
    localPath,
    remotePath,
    host,
    startedAt,
    status,
    totalBytes,
    transferredBytes,
    operationId, phase, processedFiles, lastProgressAt,
    processedBytes, progressScope, comparedFiles, changedFiles,
    completedFiles, totalFiles, completedGroups, totalGroups,
    missingFiles, differentFiles, unchangedFiles, cacheHits, cacheRehash, cacheStatus,
  }));
}

function currentTransferApiInstanceId() {
  return localApiServer && typeof localApiServer.instanceId === "function" && localApiServer.instanceId()
    ? localApiServer.instanceId()
    : `${process.pid}:simple-sftp-unavailable`;
}

function loadTransferOperationLedger() {
  if (transferLedgerLoaded) return;
  transferLedgerLoaded = true;
  const saved = extensionContext?.globalState?.get(TRANSFER_OPERATION_STATE, []);
  if (!Array.isArray(saved)) return;
  for (const row of saved.slice(-MAX_TRANSFER_OPERATIONS)) {
    if (!row || typeof row.operationId !== "string" || typeof row.operationInstanceId !== "string") continue;
    const normalized = {
      operationId: row.operationId,
      operationInstanceId: row.operationInstanceId,
      status: row.status === "settled" ? "settled" : "outcomeUnknown",
      startedAt: String(row.startedAt || ""),
      settledAt: row.status === "settled" ? String(row.settledAt || "") : "",
      cancelRequestedAt: String(row.cancelRequestedAt || ""),
      reason: String(row.reason || ""),
      remoteMutation: row.remoteMutation === true,
      requestKey: String(row.requestKey || ""),
      recoveryContext: row.recoveryContext,
      recovery: row.recovery,
      requestDone: false,
      outcomeUnknown: row.status !== "settled",
      persisted: row.status === "settled",
      settling: false,
    };
    if (normalized.status !== "settled" || Date.now() - Date.parse(normalized.settledAt || "") < SETTLED_TRANSFER_TTL_MS)
      transferOperationLedger.set(normalized.operationId, normalized);
  }
}

function pruneTransferOperationLedger() {
  const now = Date.now();
  for (const [id, row] of transferOperationLedger) {
    if (row.status === "settled" && row.persisted && now - Date.parse(row.settledAt || "") >= SETTLED_TRANSFER_TTL_MS)
      transferOperationLedger.delete(id);
  }
  while (transferOperationLedger.size >= MAX_TRANSFER_OPERATIONS) {
    const settledId = [...transferOperationLedger].find(([, row]) => row.status === "settled" && row.persisted)?.[0];
    if (!settledId) throw new Error("SimpleSFTP 有过多尚未确认退出的传输，未启动新传输。");
    transferOperationLedger.delete(settledId);
  }
}

function persistTransferOperationLedger() {
  const context = extensionContext;
  const rows = [...transferOperationLedger.values()].slice(-MAX_TRANSFER_OPERATIONS).map(({ requestDone, outcomeUnknown, persisted, settling, ...row }) => row);
  transferLedgerWrite = transferLedgerWriter.enqueue({ context, rows });
  return transferLedgerWrite;
}

function transferRequestKey(method, params) {
  const localPath = localPathText(params.localPath || params.localBase || params.workspacePath, process.platform).replace(/[\\/]+/g, "/");
  const identity = {
    method,
    localPath: process.platform === "win32" ? localPath.toLowerCase() : localPath,
    remotePath: remotePathText(params.remotePath, process.platform, true),
    targetId: params.targetId || params.serverId || "",
    host: params.host || "",
    server: params.server && { id: params.server.id, name: params.server.name, host: params.server.host, remotePath: params.server.remotePath, port: params.server.port, username: params.server.username },
    source: params.source && { id: params.source.id, host: params.source.host, remotePath: params.source.remotePath, port: params.source.port, username: params.source.username },
    destination: params.destination && { id: params.destination.id, host: params.destination.host, remotePath: params.destination.remotePath, port: params.destination.port, username: params.destination.username },
    target: params.target && { id: params.target.id, host: params.target.host, remotePath: params.target.remotePath, port: params.target.port, username: params.target.username },
  };
  return crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

async function beginTransferOperation(operationId, requestedInstanceId, remoteMutation, requestKey, recoveryContext) {
  if (extensionDeactivating) throw new Error("SimpleSFTP 正在停用，未启动新传输。");
  loadTransferOperationLedger();
  pruneTransferOperationLedger();
  const id = String(operationId || "").trim();
  const instanceId = currentTransferApiInstanceId();
  if (!id || !instanceId) throw new Error("SimpleSFTP 传输身份尚未就绪，未启动传输。");
  if (requestedInstanceId && requestedInstanceId !== instanceId)
    throw new Error("SimpleSFTP 实例已变化，未启动旧身份传输。");
  if (transferOperationLedger.has(id)) throw new Error("SimpleSFTP 请求身份已使用，未重复启动传输。");
  const targetKey = /^[a-f0-9]{64}$/i.test(String(requestKey || "")) ? String(requestKey).toLowerCase() : transferRequestKey("unknown", {});
  const blocker = [...transferOperationLedger.values()].find((row) => (row.status !== "settled" || !row.persisted) && row.requestKey === targetKey);
  if (blocker) {
    const error = new Error("相同传输目标仍有未确认的旧请求，未启动并发传输。");
    error.apiData = { blockedOperationId: blocker.operationId, operationInstanceId: blocker.operationInstanceId, notStarted: true };
    throw error;
  }
  const row = { operationId: id, operationInstanceId: instanceId, requestKey: targetKey, recoveryContext, status: "running", startedAt: new Date().toISOString(), settledAt: "", cancelRequestedAt: "", reason: "", remoteMutation: remoteMutation === true, requestDone: false, outcomeUnknown: false, persisted: false, settling: false };
  transferOperationLedger.set(id, row);
  try { await persistTransferOperationLedger(); row.persisted = true; }
  catch (error) {
    // The business method has not been dispatched. Retain the failed receipt,
    // but do not misclassify this as an unfinished local request forever.
    row.status = "outcomeUnknown"; row.outcomeUnknown = true; row.requestDone = true;
    row.reason = "could not persist transfer start receipt";
    if (error && typeof error === "object") error.apiData = { notStarted: true };
    throw error;
  }
}

function transferOperationResourceCount(operationId) {
  return activeTransferResources.get(operationId)?.size || 0;
}

async function settleTransferOperation(row) {
  if (!row || !row.requestDone || row.status === "settled" || row.outcomeUnknown || row.settling || transferOperationResourceCount(row.operationId) > 0) return;
  const hasLiveController = [...activeTransfers.values()].some((transfer) => transfer.operationId === row.operationId);
  const hasLiveUpload = activeUploadOperations.has(row.operationId);
  if (hasLiveController || hasLiveUpload) return;
  row.settling = true;
  row.status = "settled";
  row.settledAt = new Date().toISOString();
  row.persisted = false;
  try {
    await persistTransferOperationLedger();
    row.persisted = true;
  } catch (error) {
    row.status = "outcomeUnknown";
    row.settledAt = "";
    row.reason = "settlement receipt persistence failed";
    row.outcomeUnknown = true;
    await persistTransferOperationLedger().catch(() => undefined);
    throw error;
  } finally { row.settling = false; }
}

async function finishTransferOperation(operationId) {
  const row = transferOperationLedger.get(operationId);
  if (!row || row.status === "settled") return;
  row.requestDone = true;
  if (row.status !== "cancelling" && !row.outcomeUnknown && transferOperationResourceCount(operationId) > 0) row.status = "draining";
  await persistTransferOperationLedger();
  row.persisted = true;
  await settleTransferOperation(row);
}

function markTransferOperationUnknown(operationId, reason) {
  const row = transferOperationLedger.get(operationId);
  if (!row || row.status === "settled") return;
  row.outcomeUnknown = true;
  row.status = "outcomeUnknown";
  row.reason = String(reason || "transfer process exit could not confirm remote settlement");
  void persistTransferOperationLedger().catch(() => undefined);
}

function trackTransferResource(resource, operationId = transferContext.getStore()?.operationId, remoteMutation) {
  const id = String(operationId || "").trim();
  if (!id || !resource || typeof resource.once !== "function") return;
  let resources = activeTransferResources.get(id);
  if (!resources) activeTransferResources.set(id, resources = new Set());
  if (resources.has(resource)) return;
  resources.add(resource);
  resource.once("close", (code, signal) => {
    resources.delete(resource);
    if (!resources.size) activeTransferResources.delete(id);
    const row = transferOperationLedger.get(id);
    if ((remoteMutation ?? row?.remoteMutation) && (code === null || code === undefined || signal || code === 255))
      markTransferOperationUnknown(id, `process closed without authoritative remote exit status (${signal || code})`);
    void maybeSettleTransferOperation(id);
  });
}

async function maybeSettleTransferOperation(operationId) {
  const row = transferOperationLedger.get(operationId);
  if (!row) return;
  try { await settleTransferOperation(row); } catch { /* Keep outcome unknown and fail closed. */ }
}

async function listTransferOperationState() {
  loadTransferOperationLedger();
  await transferLedgerWrite.catch(() => undefined);
  const rows = [...transferOperationLedger.values()].slice(-MAX_TRANSFER_OPERATIONS).map((row) => ({
    operationId: row.operationId, operationInstanceId: row.operationInstanceId, status: row.status,
    startedAt: row.startedAt, settledAt: row.settledAt || undefined, reason: row.reason || undefined,
    recovery: row.recovery,
    childCount: transferOperationResourceCount(row.operationId),
  }));
  return {
    instanceId: currentTransferApiInstanceId(),
    operations: [...activeUploadOperations.values(), ...rows.filter((row) => row.status !== "settled").map((row) => ({ id: row.operationId, ...row }))],
    settledOperations: rows.filter((row) => row.status === "settled" && row.settledAt && transferOperationLedger.get(row.operationId)?.persisted),
  };
}

async function reconcileTransferOperation(params = {}) {
  loadTransferOperationLedger();
  const operationId = String(params.operationId || "");
  const existing = transferRecoveries.get(operationId);
  if (existing) return existing;
  if (transferRecoveries.size >= 8) throw new Error("TRANSFER_RECONCILIATION_BUSY");
  const work = reconcileTransferOperationCore(params);
  transferRecoveries.set(operationId, work);
  try { return await work; } finally { if (transferRecoveries.get(operationId) === work) transferRecoveries.delete(operationId); }
}

async function reconcileTransferOperationCore(params) {
  await transferLedgerWrite.catch(() => undefined);
  const operationId = String(params.operationId || ""), row = transferOperationLedger.get(operationId);
  let blocker;
  const receipt = (status, reason) => ({ ok: true, operationId, operationInstanceId: row?.operationInstanceId || "",
    instanceId: currentTransferApiInstanceId(), status, settled: status === "settled", reason, ...(blocker ? { blocker } : {}) });
  if (!row) return receipt("notFound", "缺少原始传输身份");
  if (!params.operationInstanceId || params.operationInstanceId !== row.operationInstanceId) return receipt("identityMismatch", "旧传输实例不匹配");
  if (row.status === "settled" && row.persisted) return receipt("settled");
  const hasLocalWork = () => transferOperationResourceCount(operationId) > 0 || activeUploadOperations.has(operationId)
    || [...activeTransfers.values()].some(transfer => transfer.operationId === operationId)
    || (row.operationInstanceId === currentTransferApiInstanceId() && !row.requestDone);
  if (hasLocalWork()) return receipt("outcomeUnknown", "旧传输本地请求/进程尚未退出");
  const method = String(params.retryMethod || "");
  if (method !== "sync.serverToServerFpsync" && !READ_ONLY_SETTLEMENT_METHODS.includes(method)) return receipt("outcomeUnknown", "该传输协议尚不支持自动核实退出");
  let identity, source, destination;
  try {
    identity = retryIdentity(params.retryParams || {});
    if (params.requestKey !== row.requestKey || ![clientRequestKey(method, identity), transferRequestKey(method, identity)].includes(row.requestKey))
      return receipt("identityMismatch", "重试目标与旧传输身份不匹配");
    if (row.recoveryContext && JSON.stringify(row.recoveryContext) !== JSON.stringify({ method, params: identity }))
      return receipt("identityMismatch", "持久化传输目标不匹配");
    if (method === "sync.serverToServerFpsync") {
      source = directSyncTarget(identity.source, "旧传输来源");
      destination = directSyncTarget(identity.destination, "旧传输目标");
    }
  } catch { return receipt("identityMismatch", "无法证明旧传输的来源和目标"); }
  const commitExitProof = async (kind, proofs) => {
    if (hasLocalWork() || transferOperationLedger.get(operationId) !== row) throw new Error("TRANSFER_IDENTITY_CHANGED");
    row.status = "settled"; row.settledAt = new Date().toISOString(); row.persisted = false;
    row.recovery = { kind, verifiedAt: row.settledAt, originalOutcome: "outcomeUnknown", proofs };
    try {
      await persistTransferOperationLedger();
      row.persisted = true;
      row.outcomeUnknown = false;
      return receipt("settled");
    } catch {
      row.status = "outcomeUnknown"; row.settledAt = ""; row.persisted = false; row.outcomeUnknown = true; row.recovery = undefined;
      await persistTransferOperationLedger().catch(() => undefined);
      throw new Error("EXIT_RECEIPT_PERSISTENCE_FAILED");
    }
  };
  if (READ_ONLY_SETTLEMENT_METHODS.includes(method)) {
    if (row.remoteMutation !== false) return receipt("outcomeUnknown", "旧请求无法确认为只读下载，保留退出保护");
    // This protocol only reads remote files. After the old local owner and all
    // transports have exited, there is no remote writer or local file handle to unlock.
    const signal = currentApiRequestContext()?.signal;
    try {
      signal?.throwIfAborted();
      const localProof = transferRecoveryTestHooks?.localProof || localTransferExitProof;
      await localProof(row.operationInstanceId, row.operationInstanceId === currentTransferApiInstanceId());
      await localProof(row.operationInstanceId, row.operationInstanceId === currentTransferApiInstanceId());
      signal?.throwIfAborted();
      return await commitExitProof("verified-read-transfer-exit", []);
    } catch (error) { return receipt("outcomeUnknown", String(error?.message || error).slice(0, 200)); }
  }
  const resources = [source, destination].map(target => ({ server: remoteResourceServer(target), project: target.remotePath, target: target.remotePath }));
  let handle;
  const signal = currentApiRequestContext()?.signal;
  try {
    signal?.throwIfAborted();
    handle = transferRecoveryTestHooks?.acquire
      ? await transferRecoveryTestHooks.acquire(resources)
      : await hostOperationLease.acquire({ pluginId: "simple-local.simple-sftp-mac", workspaceUri: "file://" + destination.remotePath,
        hostProjectPath: destination.remotePath, actionType: "transfer-reconcile", actionLabel: "核实旧传输退出", resources });
    await handle.assertHeld();
    const localProof = transferRecoveryTestHooks?.localProof || localTransferExitProof;
    await localProof(row.operationInstanceId, row.operationInstanceId === currentTransferApiInstanceId());
    const proofs = [];
    for (const target of [source, destination]) {
      signal?.throwIfAborted();
      const text = await runRemoteBatchSsh(target, settlementProbeCommand(target.remotePath, shellQuote), [], 20000,
        { remoteMutation: false, stage: "旧传输退出核实" });
      if (String(text).length > 4096) throw new Error("INVALID_REMOTE_EXIT_PROOF");
      const proof = JSON.parse(text);
      if (proof.idle === false && proof.reason === "REMOTE_TRANSFER_STILL_ACTIVE") {
        const detail = proof.blocker;
        const role = target === source ? "source" : "destination";
        if (Number.isSafeInteger(detail?.pid) && detail.pid > 0 && detail.pid <= 2147483647
            && typeof detail.name === "string" && /^[A-Za-z0-9_.-]{1,32}$/.test(detail.name)
            && typeof detail.state === "string" && /^[RSDTtKWPI]$/.test(detail.state)
            && ["target-root", "unscoped"].includes(detail.scope))
          blocker = { role, pid: detail.pid, name: detail.name, state: detail.state, scope: detail.scope };
        const description = blocker ? ` pid=${blocker.pid} ${blocker.name} state=${blocker.state} scope=${blocker.scope}` : "";
        throw new Error(`REMOTE_TRANSFER_STILL_ACTIVE ${role}:${target.host}${description}`);
      }
      if (proof.idle !== true || proof.root !== target.remotePath || !Number.isSafeInteger(proof.inspectedProcesses)
          || proof.inspectedProcesses < 0 || proof.inspectedProcesses > 8192 || !Number.isSafeInteger(proof.inspectedLocks)
          || proof.inspectedLocks < 0 || proof.inspectedLocks > 32) throw new Error(proof.reason || "INVALID_REMOTE_EXIT_PROOF");
      const external = proof.unobservedExternalSessions;
      if (external !== undefined && (!Array.isArray(external) || external.length > 32 || external.some(item =>
          !Number.isSafeInteger(item?.pid) || item.pid <= 0 || item.pid > 2147483647 || item.name !== "sftp-server"
          || item.scope !== "external-session-uninspectable") || (external.length && proof.protocol !== "staged-tar-v1")))
        throw new Error("INVALID_REMOTE_EXIT_PROOF");
      proofs.push({ inspectedProcesses: proof.inspectedProcesses, inspectedLocks: proof.inspectedLocks,
        ...(external?.length ? { protocol: proof.protocol, unobservedExternalSessions: external.map(({ pid, name, scope }) => ({ pid, name, scope })) } : {}) });
    }
    // The probes themselves use SSH. Check again only after both have closed.
    await localProof(row.operationInstanceId, row.operationInstanceId === currentTransferApiInstanceId());
    await handle.assertHeld();
    signal?.throwIfAborted();
    return await commitExitProof("verified-writer-exit", proofs);
  } catch (error) {
    return receipt("outcomeUnknown", String(error?.message || error).slice(0, 200));
  } finally { await handle?.release().catch(() => undefined); }
}

function transferTimeoutMs(sftp, options = {}) { return 120000; }

function uploadProgressCancellable(options = {}) {
  if (options && typeof options.cancellable === "boolean") return options.cancellable;
  return vscode.workspace.getConfiguration("simpleSftpMac").get("uploadCancellable", true) !== false;
}

function runUploadWithProgress(options, title, operation) {
  if (!transferContext.getStore()) require("./mac-update-gate").assertBusinessAllowed();
  const execute = async (progress, token) => {
    const controller = createTransferController({ id: nextTransferId(title), operation: title, localPath: options.localPath || "", remotePath: options.sftp?.remotePath || "", host: options.sftp?.host || "" });
    controller.operationId = options._operationId || transferContext.getStore()?.operationId || controller.id;
    const cancellation = token?.onCancellationRequested?.(() => controller.cancel("用户取消"));
    try {
      if (controller.status === "cancelled") throw new Error("传输已取消");
      const result = await transferContext.run(controller, () => operation(token, progress));
      if (controller.status === "cancelled") throw new Error("传输已取消，执行结果待确认"); return result;
    } finally { cancellation?.dispose(); controller.dispose(); }
  };
  if (options.apiMode) return execute({ report() {} }, undefined);
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: uploadProgressCancellable(options) }, execute);
}

async function confirmTransferPath({ localPath, sftp, operation, detail, options = {} }) {
  const key = transferPathConfirmationKey(localPath, sftp);
  const remembered = extensionContext && extensionContext.globalState
    ? extensionContext.globalState.get(PATH_CONFIRMATIONS_STATE, [])
    : [];
  if (Array.isArray(remembered) && remembered.includes(key)) return true;
  const preview = createTransferPreview({ localPath, sftp, operation, detail });

  if (options && options.apiMode) {
    const requires = [];
    if (options.confirm !== true) requires.push("confirm");
    if (options.pathConfirmed !== true) requires.push("pathConfirmed");
    if (requires.length) throw confirmationRequired({ ...preview, requires });
    return true;
  }

  const currentLocation = (() => {
    try { return workspaceLocationForFolder(getPrimaryWorkspaceFolder()); } catch { return null; }
  })();
  const currentUriMatches = currentLocation && currentLocation.remote && (() => {
    const relative = path.win32.relative(currentLocation.hostPath, path.win32.normalize(String(localPath || "")));
    return relative === "" || (!relative.startsWith(`..${path.win32.sep}`) && relative !== ".." && !path.win32.isAbsolute(relative));
  })();
  const waiting = transferContext.getStore();
  waiting?.pause();
  let answer;
  try { answer = await vscode.window.showWarningMessage(
    [
      "【SimpleSFTP 文件位置确认】",
      "",
      `操作：${preview.operation}`,
      `本地宿主位置：${preview.localPath}`,
      `远端预期位置：${preview.remotePath}`,
      `服务器：${preview.username}${preview.username ? "@" : ""}${preview.host}:${preview.port}`,
      currentUriMatches ? `远程工作区 URI：${currentLocation.editorUri}` : "",
      preview.detail ? `文件范围：${preview.detail}` : "",
      "",
      "请确认本地宿主位置和远端预期位置均正确后再继续。",
    ].filter(Boolean).join("\n"), { modal: true }, "仅本次继续", "此后该路径不再提醒", "取消"); } finally { waiting?.resume(); }
  if (answer === "此后该路径不再提醒") {
    if (extensionContext && extensionContext.globalState) {
      const next = [...new Set([...(Array.isArray(remembered) ? remembered : []), key])].slice(-100);
      await extensionContext.globalState.update(PATH_CONFIRMATIONS_STATE, next);
    }
    return true;
  }
  if (answer === "仅本次继续") return true;
  throw new Error("用户取消了 SimpleSFTP 文件位置确认。");
}

function createTransferPreview({ localPath, sftp, operation, detail }) {
  return {
    operation: operation || "文件传输",
    detail: detail || "",
    localPath: String(localPath || ""),
    remotePath: String(sftp && sftp.remotePath || ""),
    host: String(sftp && sftp.host || ""),
    port: normalizeSshPort(sftp && sftp.port, 22),
    username: String(sftp && sftp.username || ""),
  };
}

function createLocalApiMethods() {
  const methods = {
    status: async () => {
      const active = getActiveSharedServer();
      return {
        ok: true,
        plugin: "SimpleSFTP",
        version: String(PACKAGE_JSON.version || "0.2.0"),
        activeServer: active ? publicServerRecord(active) : null,
        api: localApiServer
          ? { port: localApiServer.port, pid: localApiServer.startedAt ? process.pid : 0, startedAt: localApiServer.startedAt }
          : null,
      };
    },
    "config.list": async () => {
      const config = vscode.workspace.getConfiguration(API_CONFIG_NAMESPACE);
      const schema = simpleSftpConfigSchema();
      return {
        namespace: API_CONFIG_NAMESPACE,
        keys: Object.entries(schema)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => ({
            key,
            type: item.type || "",
            scope: item.scope || "",
            default: item.default,
            value: simpleSftpConfigValue(config, key),
          })),
      };
    },
    "config.get": async (params = {}) => {
      const key = String(params.key || "").trim();
      const schema = simpleSftpConfigSchema()[key];
      if (!schema)
        throw new Error(`未知 SimpleSFTP 配置：${key}`);
      const config = vscode.workspace.getConfiguration(API_CONFIG_NAMESPACE);
      return {
        key,
        type: schema.type || "",
        scope: schema.scope || "",
        default: schema.default,
        value: simpleSftpConfigValue(config, key),
      };
    },
    "config.set": async (params = {}) => {
      const key = String(params.key || "").trim();
      if (!SIMPLE_SFTP_CONFIG_KEYS.has(key))
        throw new Error(`未知 SimpleSFTP 配置：${key}`);
      requireApiConfirmation(params, {
        method: "config.set",
        operation: `修改 SimpleSFTP 配置 ${key}`,
        sftp: null,
        localPath: "",
        pathRequired: false,
      });
      validateSimpleSftpConfigValue(key, params.value);
      const config = vscode.workspace.getConfiguration(API_CONFIG_NAMESPACE);
      await config.update(simpleSftpConfigSuffix(key), params.value, vscode.ConfigurationTarget.Global);
      publishLocalApiEvent("config.set", { key, value: simpleSftpConfigValue(config, key) });
      return { ok: true, key, value: simpleSftpConfigValue(config, key) };
    },
    "config.reset": async (params = {}) => {
      const key = String(params.key || "").trim();
      if (!SIMPLE_SFTP_CONFIG_KEYS.has(key))
        throw new Error(`未知 SimpleSFTP 配置：${key}`);
      requireApiConfirmation(params, {
        method: "config.reset",
        operation: `重置 SimpleSFTP 配置 ${key}`,
        sftp: null,
        localPath: "",
        pathRequired: false,
      });
      const config = vscode.workspace.getConfiguration(API_CONFIG_NAMESPACE);
      await config.update(simpleSftpConfigSuffix(key), undefined, vscode.ConfigurationTarget.Global);
      publishLocalApiEvent("config.reset", { key });
      return { ok: true, key, reset: true };
    },
    "servers.list": async () => {
      const data = readSharedServers();
      return {
        ok: true,
        activeServerId: data.activeServerId,
        servers: data.servers.map(publicServerRecord),
      };
    },
    "servers.save": async (params = {}) => {
      const incoming = params.server && typeof params.server === "object" && !Array.isArray(params.server)
        ? params.server
        : params;
      const data = readSharedServers();
      const incomingId = String(incoming.id || "").trim();
      const existing = data.servers.find((item) =>
        incomingId ? item.id === incomingId : Boolean(incoming.label && item.label === incoming.label)
      );
      const server = sanitizeServerProfile(
        incomingId || !existing ? incoming : { ...incoming, id: existing.id },
        existing || {}
      );
      requireApiConfirmation(params, {
        method: "servers.save",
        operation: existing ? "更新 SimpleSFTP 服务器配置" : "新增 SimpleSFTP 服务器配置",
        sftp: server,
        localPath: "",
        pathRequired: false,
      });
      const servers = existing
        ? data.servers.map((item) => item.id === server.id ? server : item)
        : [...data.servers, server];
      const activeServerId = params.setActive === true || (data.activeServerId === server.id) || (!data.activeServerId && !existing)
        ? server.id
        : data.activeServerId;
      writeSharedServers({ ...data, servers, activeServerId });
      updateServerStatusButton();
      publishLocalApiEvent("servers.save", { id: server.id, activeServerId });
      return { ok: true, server: publicServerRecord(server), activeServerId };
    },
    "servers.delete": async (params = {}) => {
      const id = String(params.id || params.serverId || "").trim();
      const data = readSharedServers();
      const server = data.servers.find((item) => item.id === id);
      if (!server)
        throw new Error("未找到指定服务器：" + (id || "-"));
      requireApiConfirmation(params, {
        method: "servers.delete",
        operation: "删除 SimpleSFTP 服务器配置",
        sftp: server,
        localPath: "",
        pathRequired: false,
      });
      const servers = data.servers.filter((item) => item.id !== id);
      const activeServerId = data.activeServerId === id ? (servers[0]?.id || "") : data.activeServerId;
      writeSharedServers({ ...data, servers, activeServerId });
      updateServerStatusButton();
      publishLocalApiEvent("servers.delete", { id, activeServerId });
      return { ok: true, deletedId: id, activeServerId };
    },
    "servers.setActive": async (params = {}) => {
      const id = String(params.id || params.serverId || "").trim();
      const data = readSharedServers();
      const server = data.servers.find((item) => item && item.id === id);
      if (!server) throw new Error("未找到指定服务器：" + (id || "-"));
      requireApiConfirmation(params, {
        method: "servers.setActive",
        operation: "切换 SimpleSFTP 活动服务器",
        sftp: server,
        localPath: "",
        pathRequired: false,
      });
      writeSharedServers({ ...data, activeServerId: id });
      updateServerStatusButton();
      publishLocalApiEvent("servers.setActive", { activeServerId: id });
      return { ok: true, activeServerId: id, server: publicServerRecord(server) };
    },
    "servers.importSshConfig": async (params = {}) => {
      requireApiConfirmation(params, {
        method: "servers.importSshConfig",
        operation: "导入并行 SSH 配置",
        sftp: null,
        localPath: "",
        pathRequired: false,
      });
      const result = importSharedSshConfigCore();
      updateServerStatusButton();
      publishLocalApiEvent("servers.importSshConfig", result);
      return result;
    },
    "remote.listDirs": async (params = {}) => {
      const remotePath = remotePathText(params.remotePath, process.platform, true);
      if (!remotePath) throw new Error("缺少远端目录 remotePath。");
      const sftp = apiTransferSftp(params);
      sftp.remotePath = remotePath;
      requireApiConfirmation(params, {
        method: "remote.listDirs",
        operation: "列出远端目录",
        sftp,
        localPath: String(params.localPath || ""),
        pathRequired: true,
      });
      const dirs = await listRemoteDirs(sftp, remotePath);
      publishLocalApiEvent("remote.listDirs", { remotePath, count: dirs.length });
      return { ok: true, remotePath, dirs };
    },
    "target.show": async (params = {}) => {
      return showCurrentTarget({ ...params, apiMode: true });
    },
    "target.update": async (params = {}) => {
      const localPath = localPathText(params.localPath || getWorkspaceRoot() || "", process.platform);
      if (!localPath)
        throw new Error("target.update 缺少本地工作区 localPath。");
      const patch = params.patch && typeof params.patch === "object" && !Array.isArray(params.patch)
        ? params.patch
        : {};
      const sftp = apiTransferSftp({ ...params, localPath });
      const preview = {
        ...sftp,
        host: String(patch.host || sftp.host || "").trim(),
        port: normalizeSshPort(patch.port ?? patch.sshPort ?? sftp.port, 22),
        username: String(patch.username ?? patch.user ?? sftp.username ?? "").trim(),
        remotePath: remotePathText(patch.remotePath ?? sftp.remotePath, process.platform),
      };
      requireApiConfirmation(params, {
        method: "target.update",
        operation: "更新 SFTP 工作区目标",
        sftp: preview,
        localPath,
        pathRequired: true,
      });
      const result = await updateWorkspaceTarget({ ...params, apiMode: true, localPath });
      publishLocalApiEvent("target.update", {
        localPath,
        remotePath: result.remotePath,
        updatedAt: new Date().toISOString(),
      });
      return result;
    },
    "project.create": async (params = {}) => {
      const remotePath = remotePathText(params.remotePath, process.platform);
      if (!remotePath) throw new Error("缺少远端项目目录 remotePath。");
      const sftp = apiTransferSftp(params);
      sftp.remotePath = remotePath;
      requireApiConfirmation(params, {
        method: "project.create",
        operation: "创建 SFTP 工作区",
        sftp,
        localPath: String(params.localPath || ""),
        pathRequired: true,
      });
      const result = await createOrOpenProject({ ...params, apiMode: true });
      publishLocalApiEvent("project.create", {
        localPath: result && result.localPath,
        remotePath: result && result.remotePath,
      });
      return result;
    },
    "sync.fromRemote": async (params = {}) => {
      const localPath = localPathText(params.localPath || "", process.platform);
      if (!localPath) throw new Error("缺少本地工作区 localPath。");
      const sftp = apiTransferSftp({ ...params, localPath });
      requireApiConfirmation(params, {
        method: "sync.fromRemote",
        operation: "远端同步到本地",
        sftp: { ...sftp, remotePath: sftp.remotePath || params.remotePath || "" },
        localPath,
        pathRequired: true,
      });
      const result = await syncFromRemote({ ...params, apiMode: true, localPath });
      publishLocalApiEvent("sync.fromRemote", {
        localPath,
        remotePath: result && result.remotePath,
      });
      return result;
    },
    "sync.downloadPaths": async (params = {}) => {
      const localPath = localPathText(params.localPath || "", process.platform);
      if (!localPath) throw new Error("缺少本地项目目录 localPath。");
      if (!params.server || typeof params.server !== "object") throw new Error("必须明确指定来源 Worker。");
      const scope = explicitDownloadScope(params);
      const sftp = apiTransferSftp({ ...params, localPath });
      requireApiConfirmation(params, {
        method: "sync.downloadPaths",
        operation: `仅下载 ${scope.paths.length} 条指定路径到本机`,
        sftp,
        localPath,
        pathRequired: true,
      });
      const result = await syncFromRemote({ ...params, apiMode: true, localPath, paths: scope.paths });
      publishLocalApiEvent("sync.downloadPaths", { localPath, remotePath: result.remotePath, paths: scope.paths });
      return result;
    },
    "sync.downloadMappedPaths": async (params = {}) => {
      const localPath = localPathText(params.localPath || "", process.platform);
      if (!localPath) throw new Error("缺少本地项目目录 localPath。");
      if (!params.server || typeof params.server !== "object") throw new Error("必须明确指定来源 Worker。");
      const plan = normalizeMappedDownloadEntries(params);
      const sftp = apiTransferSftp({ ...params, localPath });
      if (!sftp.host || !sftp.remotePath) throw new Error("必须明确指定来源 Worker 的主机和远端项目目录。");
      const previewEntries = plan.entries.map((entry) => ({
        remotePath: entry.remotePath,
        localRelativePath: entry.localRelativePath,
        bytes: entry.bytes,
        sha256: entry.sha256,
      }));
      requireApiConfirmation({
        ...params,
        mappedDownload: {
          fileCount: plan.entries.length,
          byteCount: plan.byteCount,
          maxFileBytes: plan.maxFileBytes,
          maxBatchBytes: plan.maxBatchBytes,
          overwrite: plan.overwrite,
          entries: previewEntries,
        },
      }, {
        method: "sync.downloadMappedPaths",
        operation: plan.memoryOnly ? `一次打包接收 ${plan.entries.length} 个指标文件到内存，仅校验不落盘` : `一次打包下载 ${plan.entries.length} 个映射文件到本机不同路径`,
        sftp,
        localPath,
        pathRequired: true,
        detail: previewEntries.map((entry) => `${entry.remotePath} -> ${entry.localRelativePath}`).join("\n"),
      });
      const result = await downloadMappedPaths({ ...params, apiMode: true, localPath, sftp, plan });
      publishLocalApiEvent("sync.downloadMappedPaths", {
        localPath,
        remotePath: sftp.remotePath,
        fileCount: result.fileCount,
        byteCount: result.byteCount,
        maxBatchBytes: plan.maxBatchBytes,
      });
      return result;
    },
    "sync.planLogPaths": async (params = {}) => listPlanLogPaths(params),
    "sync.projectInventory": async (params = {}) => projectInventory(params),
    "sync.projectFileStats": async (params = {}) => projectFileStats(params),
    "sync.projectTree": async (params = {}) => projectTree(params),
    "sync.deletePath": async (params = {}) => deleteProjectPath(params),
    "sync.serverToServerBatch": async (params = {}) => syncServerToServerBatch({ ...params, apiMode: true }),
    "sync.serverToServerFpsync": async (params = {}) => syncServerToServerFpsync({ ...params, apiMode: true }),
    "sync.serverToServer": async (params = {}) => {
      const result = await syncServerToServer({ ...params, apiMode: true });
      publishLocalApiEvent("sync.serverToServer", {
        sourceId: params.source && params.source.id,
        destinationId: params.destination && params.destination.id,
        relativePath: result.relativePath,
      });
      return result;
    },
    "transfers.list": async () => {
      const operationState = await listTransferOperationState();
      return { ok: true, instanceId: operationState.instanceId, transfers: listActiveTransfers(), operations: operationState.operations, settledOperations: operationState.settledOperations };
    },
    "transfers.reconcile": async (params = {}) => reconcileTransferOperation(params),
    "transfers.cancel": async (params = {}) => {
      const id = String(params.transferId || params.id || "").trim();
      const operationId = String(params.operationId || "").trim();
      if (!id && !operationId) throw new Error("缺少 transferId 或 operationId。");
      const reason = String(params.reason || "用户通过 API 取消");
      let operation = operationId ? transferOperationLedger.get(operationId) : undefined;
      if (operation && params.operationInstanceId && params.operationInstanceId !== operation.operationInstanceId)
        return { ok: true, transferId: id, operationId, cancelled: false, status: "identityMismatch", settled: false, operationInstanceId: operation.operationInstanceId, instanceId: currentTransferApiInstanceId() };
      if (operation && operation.status === "settled") {
        await transferLedgerWrite.catch(() => undefined);
        operation = transferOperationLedger.get(operationId);
        if (operation?.status === "settled" && operation.persisted)
          return { ok: true, transferId: id, operationId, cancelled: true, status: "settled", settled: true, operationInstanceId: operation.operationInstanceId, instanceId: currentTransferApiInstanceId() };
        return { ok: true, transferId: id, operationId, cancelled: false, status: "outcomeUnknown", settled: false, operationInstanceId: operation?.operationInstanceId || "", instanceId: currentTransferApiInstanceId() };
      }
      if (operationId) {
        if (!operation) return { ok: true, transferId: id, operationId, cancelled: false, status: "notFound", settled: false, operationInstanceId: "", instanceId: currentTransferApiInstanceId() };
        if (operation.outcomeUnknown)
          return { ok: true, transferId: id, operationId, cancelled: false, status: "outcomeUnknown", settled: false, operationInstanceId: operation.operationInstanceId, instanceId: currentTransferApiInstanceId() };
        if (operation.operationInstanceId !== currentTransferApiInstanceId())
          return { ok: true, transferId: id, operationId, cancelled: false, status: "outcomeUnknown", settled: false, operationInstanceId: operation.operationInstanceId, instanceId: currentTransferApiInstanceId() };
        cancelledTransferOperations.set(operationId, reason);
        while (cancelledTransferOperations.size > 512) cancelledTransferOperations.delete(cancelledTransferOperations.keys().next().value);
        operation.status = "cancelling";
        operation.cancelRequestedAt ||= new Date().toISOString();
        operation.reason = reason;
        await persistTransferOperationLedger();
      }
      const targets = [...activeTransfers.values()].filter(t => id ? t.id === id : t.operationId === operationId);
      if (!targets.length && !operationId) throw new Error("未找到活动传输：" + id);
      for (const transfer of targets) transfer.cancel(reason);
      if (operation) await maybeSettleTransferOperation(operationId);
      operation = operationId ? transferOperationLedger.get(operationId) : undefined;
      return { ok: true, transferId: id, operationId, cancelled: Boolean(targets.length || operation), status: operation?.status || "cancelling", settled: operation?.status === "settled" && operation.persisted === true, operationInstanceId: operation?.operationInstanceId || "", instanceId: currentTransferApiInstanceId() };
    },
    "upload.workspace": async (params = {}) => {
      const localPath = localPathText(params.localPath || "", process.platform);
      const sftp = resolveUploadSftp(localPath, params);
      requireApiConfirmation(params, {
        method: "upload.workspace",
        operation: "上传工作区",
        sftp,
        localPath,
        pathRequired: true,
      });
      const result = await uploadWorkspace({ ...params, apiMode: true, expectedTransferTarget: sftp });
      publishLocalApiEvent("upload.workspace", {
        targetId: result && result.targetId,
        remotePath: result && result.remotePath,
        uploadedAt: result && result.uploadedAt,
      });
      return result;
    },
    "upload.files": async (params = {}) => {
      if (!Array.isArray(params.files) && !params.manifest) {
        throw new Error("缺少上传文件列表 files 或 manifest。");
      }
      const localBase = localPathText(params.localBase || params.localPath || "", process.platform);
      const sftp = resolveUploadSftp(localBase, params);
      requireApiConfirmation(params, {
        method: "upload.files",
        operation: "上传指定文件",
        sftp,
        localPath: localBase,
        pathRequired: true,
      });
      const result = await uploadFiles({ ...params, apiMode: true, expectedTransferTarget: sftp });
      publishLocalApiEvent("upload.files", {
        remotePath: result && result.remotePath,
        files: result && result.files,
        uploadedAt: result && result.uploadedAt,
      });
      return result;
    },
    "handoff.markReady": async (params = {}) => {
      const localPath = localPathText(params.localPath || "", process.platform);
      if (!localPath) throw new Error("缺少本地工作区 localPath。");
      const sftp = readSftpConfig(localPath) || apiTransferSftp(params);
      requireApiConfirmation(params, {
        method: "handoff.markReady",
        operation: "上传并标记交接",
        sftp,
        localPath,
        pathRequired: true,
      });
      const result = await markHandoffReady({ ...params, apiMode: true, localPath });
      publishLocalApiEvent("handoff.markReady", {
        localPath,
        remotePath: result && result.remotePath,
        markedAt: result && result.markedAt,
      });
      return result;
    },
    "downloadScope.configure": async (params = {}) => {
      const localPath = localPathText(params.localPath || "", process.platform);
      const sftp = apiTransferSftp(params);
      requireApiConfirmation(params, {
        method: "downloadScope.configure",
        operation: "设置下载文件范围",
        sftp,
        localPath,
        pathRequired: true,
      });
      const result = await configureDownloadScope({ ...params, apiMode: true });
      publishLocalApiEvent("downloadScope.configure", {
        targetId: result && result.targetId,
        remotePath: result && result.remotePath,
        scope: result && result.scope,
      });
      return result;
    },
    "confirmations.reset": async (params = {}) => {
      requireApiConfirmation(params, {
        method: "confirmations.reset",
        operation: "重置 SimpleSFTP 路径免提醒记录",
        sftp: null,
        localPath: "",
        pathRequired: false,
      });
      const previous = extensionContext && extensionContext.globalState
        ? extensionContext.globalState.get(PATH_CONFIRMATIONS_STATE, [])
        : [];
      if (extensionContext && extensionContext.globalState) {
        await extensionContext.globalState.update(PATH_CONFIRMATIONS_STATE, []);
      }
      publishLocalApiEvent("confirmations.reset", { resetCount: previous.length });
      return { ok: true, resetCount: previous.length };
    },
  };
  for (const [name, method] of Object.entries(methods)) {
    if (!/^(sync[.]|upload[.]|download[.]|remote[.])/.test(name)) continue;
    methods[name] = async (params = {}) => {
      const controllerId = nextTransferId(name);
      const operationId = String(params._operationId || controllerId);
      const remoteMutation = /^(upload[.]|handoff[.]|sync[.](?:serverToServer|deletePath)|remote[.])/.test(name);
      const recoveryContext = name === "sync.serverToServerFpsync" || READ_ONLY_SETTLEMENT_METHODS.includes(name)
        ? { method: name, params: retryIdentity(params) } : undefined;
      await beginTransferOperation(operationId, params._operationInstanceId, remoteMutation, params._requestKey || transferRequestKey(name, params), recoveryContext);
      const controller = createTransferController({ id: controllerId, operation: name, localPath: params.localPath || params.localBase || "", remotePath: params.remotePath || "", host: params.source?.host || params.host || "" });
      controller.operationId = operationId;
      try {
        if (cancelledTransferOperations.has(operationId)) throw new Error(cancelledTransferOperations.get(operationId));
        const result = await transferContext.run(controller, () => withTransferCapacity(params, () => method(params)));
        if (controller.status === "cancelled") throw new Error("传输已取消，执行结果待确认");
        return result;
      } finally {
        controller.dispose();
        await finishTransferOperation(operationId);
      }
    };
  }
  return methods;
}

function requireApiConfirmation(params, { method, operation, sftp, localPath, pathRequired, detail }) {
  const preview = buildApiConfirmationPreview({ method, operation, sftp, localPath, pathRequired, detail, mappedDownload: params && params.mappedDownload });
  const requires = [];
  if (params.confirm !== true) requires.push("confirm");
  if (pathRequired && params.pathConfirmed !== true && !isRememberedTransferPath(localPath, sftp)) {
    requires.push("pathConfirmed");
  }
  if (requires.length) throw confirmationRequired({ ...preview, requires });
  return true;
}

function buildApiConfirmationPreview({ method, operation, sftp, localPath, pathRequired, detail, mappedDownload }) {
  return {
    method,
    operation,
    requires: [
      "confirm",
      ...(pathRequired ? ["pathConfirmed"] : []),
    ],
    ...(mappedDownload ? { mappedDownload } : {}),
    target: createTransferPreview({
      localPath,
      sftp,
      operation,
      detail: detail || "",
    }),
  };
}

function isRememberedTransferPath(localPath, sftp) {
  if (!localPath || !sftp || !sftp.host || !sftp.remotePath) return false;
  const key = transferPathConfirmationKey(localPath, sftp);
  const remembered = extensionContext && extensionContext.globalState
    ? extensionContext.globalState.get(PATH_CONFIRMATIONS_STATE, [])
    : [];
  return Array.isArray(remembered) && remembered.includes(key);
}

function apiTransferSftp(params = {}) {
  const active = getActiveSharedServer() || {};
  const incoming = params.server && typeof params.server === "object" ? params.server : {};
  const shared = sharedServerForOptions(params, incoming);
  const merged = { ...active, ...shared, ...incoming, ...params };
  const host = firstNonEmpty(
    incoming.transferHost,
    incoming.resolvedHost,
    incoming.sftpHost,
    incoming.sshHost,
    incoming.host,
    incoming.sshConfigHost,
    incoming.sshConfigAlias,
    params.sftpHost,
    params.sshHost,
    params.host,
    params.sshConfigHost,
    params.sshConfigAlias,
    shared.transferHost,
    shared.resolvedHost,
    merged.sftpHost,
    merged.sshHost,
    merged.host,
    merged.sshConfigHost,
    merged.sshConfigAlias,
    active.host,
    active.sshConfigHost
  );
  const username = String(
    incoming.user ||
    incoming.username ||
    shared.user ||
    shared.username ||
    merged.user ||
    merged.username ||
    ""
  ).trim();
  const port = normalizeSshPort(
    incoming.sshPort || incoming.port || shared.sshPort || shared.port || merged.sshPort || merged.port,
    22
  );
  const remotePath = remotePathText(
    requestedRemotePath(params) ||
    shared.remotePath ||
    shared.remoteBase ||
    merged.remotePath ||
    merged.remoteBase ||
    active.remotePath ||
    "",
    process.platform, true
  );
  return {
    name: String(incoming.id || incoming.label || shared.id || shared.label || merged.id || merged.label || host || "simple-sftp-target"),
    host,
    port,
    username,
    remotePath,
    connectTimeoutSeconds: resolvedConnectTimeoutSeconds(merged.connectTimeoutSeconds),
  };
}

function publicServerRecord(item) {
  if (!item) return null;
  return {
    id: item.id || "",
    label: item.label || item.id || "",
    host: firstNonEmpty(item.sftpHost, item.sshHost, item.host, item.sshConfigHost, item.sshConfigAlias),
    user: item.user || item.username || "",
    port: normalizeSshPort(item.sshPort || item.port, 22),
    remotePath: remotePathText(item.remotePath || item.remoteBase, process.platform),
    sshConfigHost: item.sshConfigHost || item.sshConfigAlias || "",
    source: item.source || "",
    enabled: item.enabled !== false,
  };
}

function simpleSftpConfigSchema() {
  return PACKAGE_JSON.contributes?.configuration?.properties || {};
}

function simpleSftpConfigSuffix(key) {
  return key.startsWith(API_CONFIG_PREFIX) ? key.slice(API_CONFIG_PREFIX.length) : key;
}

function simpleSftpConfigValue(config, key) {
  const schema = simpleSftpConfigSchema()[key] || {};
  return config.get(simpleSftpConfigSuffix(key), schema.default);
}

function validateSimpleSftpConfigValue(key, value) {
  const schema = simpleSftpConfigSchema()[key] || {};
  const type = schema.type;
  if (type === "string" && typeof value !== "string")
    throw new Error(`SimpleSFTP 配置 ${key} 需要 string：${typeof value}`);
  if (type === "number" && (typeof value !== "number" || !Number.isFinite(value)))
    throw new Error(`SimpleSFTP 配置 ${key} 需要 number：${typeof value}`);
  if (type === "integer" && !Number.isInteger(value))
    throw new Error(`SimpleSFTP 配置 ${key} 需要 integer：${typeof value}`);
  if (type === "boolean" && typeof value !== "boolean")
    throw new Error(`SimpleSFTP 配置 ${key} 需要 boolean：${typeof value}`);
  if (type === "array" && !Array.isArray(value))
    throw new Error(`SimpleSFTP 配置 ${key} 需要 array：${typeof value}`);
  if (type === "object" && (!value || typeof value !== "object" || Array.isArray(value)))
    throw new Error(`SimpleSFTP 配置 ${key} 需要 object：${typeof value}`);
  if (Number.isFinite(schema.minimum) && typeof value === "number" && value < schema.minimum)
    throw new Error(`SimpleSFTP 配置 ${key} 不能小于 ${schema.minimum}`);
  if (Number.isFinite(schema.maximum) && typeof value === "number" && value > schema.maximum)
    throw new Error(`SimpleSFTP 配置 ${key} 不能大于 ${schema.maximum}`);
  if (process.platform === "darwin" && key === "simpleSftpMac.remoteBase") return remotePathText(value, process.platform);
  if (process.platform === "darwin" && key === "simpleSftpMac.localBase") return localPathText(value, process.platform);
  return value;
}

function serverIdFromLabel(label) {
  return String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "") || `server-${Date.now()}`;
}

function sanitizeServerProfile(input, existing = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("servers.save 的 server 参数必须是对象。");
  const label = String(input.label || existing.label || "").trim();
  const id = String(input.id || label || "").trim() || serverIdFromLabel(label);
  if (!id)
    throw new Error("servers.save 缺少服务器 id 或 label。");
  const host = firstNonEmpty(
    input.host,
    input.sftpHost,
    input.sshHost,
    input.sshConfigHost,
    input.sshConfigAlias,
    existing.host,
    existing.sftpHost,
    existing.sshHost,
    existing.sshConfigHost,
    existing.sshConfigAlias
  );
  if (!host)
    throw new Error("servers.save 至少需要一个 host、sftpHost、sshHost 或 sshConfigHost。");
  const sshPort = normalizeSshPort(input.sshPort ?? input.port ?? existing.sshPort ?? existing.port, 22);
  return {
    ...existing,
    ...input,
    id,
    label: String(input.label || existing.label || id).trim() || id,
    enabled: input.enabled !== false,
    source: String(input.source || existing.source || "api").trim() || "api",
    sshPort,
    port: sshPort,
    remotePath: remotePathText(input.remotePath ?? input.remoteBase ?? existing.remotePath ?? existing.remoteBase, process.platform),
    localBase: localPathText(input.localBase ?? existing.localBase, process.platform),
    sshConfigHost: String(input.sshConfigHost ?? input.sshConfigAlias ?? existing.sshConfigHost ?? existing.sshConfigAlias ?? "").trim(),
    sshConfigAlias: String(input.sshConfigAlias ?? input.sshConfigHost ?? existing.sshConfigAlias ?? existing.sshConfigHost ?? "").trim(),
    sftpHost: String(input.sftpHost ?? existing.sftpHost ?? "").trim(),
    sshHost: String(input.sshHost ?? existing.sshHost ?? "").trim(),
    host: String(input.host ?? existing.host ?? host).trim(),
    user: String(input.user ?? input.username ?? existing.user ?? existing.username ?? "").trim(),
    username: String(input.username ?? input.user ?? existing.username ?? existing.user ?? "").trim(),
    maxConcurrentGpus: Number.isInteger(input.maxConcurrentGpus ?? existing.maxConcurrentGpus ?? 1)
      ? Math.max(1, Number(input.maxConcurrentGpus ?? existing.maxConcurrentGpus ?? 1))
      : 1,
    allowedGpuIds: Array.isArray(input.allowedGpuIds ?? existing.allowedGpuIds)
      ? [...(input.allowedGpuIds ?? existing.allowedGpuIds)].map(String)
      : [],
  };
}

function publishLocalApiEvent(type, data) {
  if (!localApiServer) return null;
  return localApiServer.publish({
    type,
    data: {
      ...(data || {}),
      publishedAt: new Date().toISOString(),
    },
  });
}

function filesSummary(files) {
  const items = Array.isArray(files) ? files : [];
  if (!items.length) return "调用方提供的 runtime manifest";
  const names = items.slice(0, 8).map((item) => {
    const value = typeof item === "string" ? item : String(item && (item.localPath || item.path || item.remoteName) || "");
    if (!value) return "-";
    try { return resolveUploadFilePath(value); } catch { return value; }
  });
  return `${names.join("、")}${items.length > names.length ? ` 等 ${items.length} 个文件` : ""}`;
}

function readSftpConfig(localPath) {
  const configPath = path.join(localPath, ".vscode", "sftp.json");
  if (!fs.existsSync(configPath)) return null;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (process.platform === "darwin") config.remotePath = remotePathText(config.remotePath, process.platform);
  return config;
}

function patternMatchesPath(lowerPath, pattern) {
  const lowerPattern = String(pattern).toLowerCase();
  if (lowerPattern.startsWith("*.")) {
    return lowerPath.endsWith(lowerPattern.slice(1));
  }
  if (lowerPattern.includes("*")) {
    return wildcardToRegExp(lowerPattern).test(lowerPath);
  }
  return lowerPath === lowerPattern || lowerPath.endsWith(`/${lowerPattern}`);
}

function wildcardToRegExp(pattern) {
  return new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, ".*")}$`, "i");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function writeLocalSessionRecord(localPath, record) {
  const vscodeDir = path.join(localPath, ".vscode");
  fs.mkdirSync(vscodeDir, { recursive: true });
  fs.writeFileSync(
    path.join(vscodeDir, "simple-sftp-session.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8"
  );
}

async function readRemoteHandoffMarker(sftp, markerName) {
  const markerPath = getRemoteMarkerPath(sftp.remotePath, markerName);
  const command = `if [ -f ${shellQuote(markerPath)} ]; then cat ${shellQuote(markerPath)}; fi`;
  const stdout = await runSsh(sftp, command, 15000);
  const text = stdout.trim();
  return text ? JSON.parse(text) : null;
}

async function writeRemoteHandoffMarker(sftp, markerName, marker) {
  const markerPath = getRemoteMarkerPath(sftp.remotePath, markerName);
  const json = `${JSON.stringify(marker, null, 2)}\n`;
  const command = `printf %s ${shellQuote(json)} > ${shellQuote(markerPath)}`;
  await withFileResourceLease("写入交接标记", sftp.remotePath, [markerPath], remoteResourceServer(sftp), () => runSsh(sftp, command, 15000));
}

function getRemoteMarkerPath(remotePath, markerName) {
  const safeMarkerName = path.posix.basename(markerName || DEFAULT_HANDOFF_MARKER);
  return `${String(remotePath).replace(/\/+$/, "")}/${safeMarkerName}`;
}


function watchTransferProcess(child, onIdle, fileStep = true, filenames = [], remoteMutation, options = {}) {
  const parent = transferContext.getStore();
  const apiContext = currentApiRequestContext();
  trackTransferResource(child, parent?.operationId, apiContext?.readOnly ? false : remoteMutation);
  let buffer = "", bytes = 0, wireBytes = 0;
  const allowed = new Set(filenames), completed = new Set();
  const idle = new ProgressInactivity(fileStep ? 120000 : 30000, () => { child.kill(); onIdle(new Error(fileStep ? "文件步骤 120 秒无真实进展，已停止。" : "控制请求 30 秒无有效响应，执行结果待确认。")); });
  const cancellation = parent?.onCancel((reason) => { child.kill(); idle.dispose(); onIdle(new Error(reason)); });
  const cancelledRead = () => { child.kill(); idle.dispose(); onIdle(apiContext.signal.reason); };
  if (apiContext?.readOnly) {
    apiContext.signal.addEventListener("abort", cancelledRead, { once: true });
    if (apiContext.signal.aborted) cancelledRead();
  }
  if (parent?.status === "cancelled") { child.kill(); idle.dispose(); throw new Error("传输已取消"); }
  const update = (evidence) => {
    evidence = { ...evidence, scope: String(evidence.metric === "wire" && options.wireScope || child.pid || child) };
    idle.update(evidence);
    parent?.updateProgress(evidence);
  };
  const receive = (chunk) => {
    if (options.stdoutBytesArePayload === false || (!fileStep && options.stdoutBytesArePayload !== true)) return;
    bytes += chunk.length; update({ phase: "transferring", processedBytes: bytes, metric: "wire" });
  };
  const stderr = (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (allowed.has(line) && !completed.has(line)) { completed.add(line); update({ phase: options.filenamePhase || "packing", processedFiles: completed.size }); }
      const wirePrefix = "SIMPLE_COMPRESSION_WIRE ";
      if (line.startsWith(wirePrefix)) {
        const count = Number(line.slice(wirePrefix.length));
        if (Number.isSafeInteger(count) && count > wireBytes) { wireBytes = count; update({ phase: "transferring", metric: "wire", processedBytes: count }); }
      }
      if (!line.startsWith("SIMPLE_PROGRESS ")) continue;
      try {
        const item = JSON.parse(line.slice(16));
        if (!["preparing", "hashing", "packing", "transferring", "unpacking", "verifying", "publishing", "distributing"].includes(item.phase)) continue;
        const evidence = { phase: item.phase };
        const keys = ["processedBytes", "processedFiles", "cacheHits", "cacheRehash"];
        if (keys.some(key => item[key] !== undefined && (!Number.isSafeInteger(item[key]) || item[key] < 0))) continue;
        for (const key of keys) if (item[key] !== undefined) evidence[key] = item[key];
        if (["ready", "unavailable", "read-failed", "write-failed"].includes(item.cacheStatus)) evidence.cacheStatus = item.cacheStatus;
        if (["processedBytes", "processedFiles"].some(key => evidence[key] !== undefined)) update(evidence);
      } catch {}
    }
    if (buffer.length > 16384) buffer = buffer.slice(-16384);
  };
  child.stderr?.on("data", stderr);
  child.once("close", () => { idle.dispose(); cancellation?.dispose?.(); child.stderr?.off?.("data", stderr); apiContext?.signal.removeEventListener("abort", cancelledRead); });
  child.once("error", () => idle.dispose());
  return { dispose: () => idle.dispose(), receive, update };
}

function runSsh(sftp, command, timeout) {
  return new Promise((resolve, reject) => {
    const child = execSsh(sftp, command, { timeout: 0, windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error(stderr || error.message);
        failure.stderr = stderr;
        reject(classifySftpFailure(failure, sftp, {
          command,
          sshStderr: stderr,
          sshCode: error.code,
        }));
        return;
      }
      resolve(stdout);
    });
    const monitor = watchTransferProcess(child, reject, Boolean(transferContext.getStore()), [], undefined, { stdoutBytesArePayload: false });
    child.stdout?.on("data", monitor.receive);
  });
}

async function handleSavedDocument(document) {
  if (!document || !["file", "vscode-remote"].includes(document.uri.scheme)) return;

  const cfg = vscode.workspace.getConfiguration("simpleSftpMac");
  if (!cfg.get("uploadOnSave")) return;

  let documentHostPath;
  try {
    documentHostPath = workspaceHostPathForUri(document.uri);
  } catch (error) {
    vscode.window.showWarningMessage(`SimpleSFTP 保存时上传已阻止：${formatError(error)}`);
    return;
  }
  const workspaceFolder = getWorkspaceFolderForFile(documentHostPath);
  if (!workspaceFolder) return;

  const localPath = getWorkspaceRoot(workspaceFolder);
  const sftp = readSftpConfig(localPath);
  if (!sftp || !sftp.remotePath || !sftp.host) return;

  disableExternalUploadOnSave(localPath);
  enqueueWorkspaceUpload(localPath, () => uploadChangedLocalFiles({ localPath, sftp }));
}

function enqueueWorkspaceUpload(localPath, task) {
  const key = process.platform === "win32" ? localPath.toLowerCase() : localPath;
  const previous = uploadQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task)
    .catch((error) => {
      vscode.window.showWarningMessage(`SimpleSFTP 保存时上传失败：${formatError(error)}`);
    })
    .finally(() => {
      if (uploadQueues.get(key) === next) {
        uploadQueues.delete(key);
      }
    });
  uploadQueues.set(key, next);
}

async function uploadChangedLocalFiles({ localPath, sftp }) {
  return withHostOperationLease("upload-on-save", "保存时上传", localPath, () => uploadChangedLocalFilesCore({ localPath, sftp }));
}

async function uploadChangedLocalFilesCore({ localPath, sftp }) {
  await confirmTransferPath({ localPath, sftp, operation: "保存时上传", detail: "当前工作区内自上次同步后变更的文件" });
  const scanStartedAt = new Date();
  const changedFiles = findChangedLocalFiles({ localPath, sftp });
  if (changedFiles.length === 0) {
    vscode.window.setStatusBarMessage("SimpleSFTP：没有需要上传的变更文件", 2500);
    return;
  }
  const uploadPlan = {
    mode: "changed",
    files: changedFiles.map((relativePath) => {
      const fullPath = path.join(localPath, relativePath);
      return { relativePath, fullPath, size: fs.statSync(fullPath).size };
    }),
    excludedRuleHits: 0,
    excludedNestedGitRepos: 0,
    nestedGitRoots: [],
  };
  uploadPlan.fileCount = uploadPlan.files.length;
  uploadPlan.byteCount = uploadPlan.files.reduce((total, file) => total + file.size, 0);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `SimpleSFTP 正在上传 ${changedFiles.length} 个变更文件`,
      cancellable: uploadProgressCancellable(),
    },
    (progress, token) => runLocalTarUpload({
      localPath,
      sftp,
      uploadPlan,
      operation: "上传变更文件",
      timeoutMs: transferTimeoutMs(sftp),
      token,
      progress,
    })
  );

  writeUploadState(localPath, {
    lastUploadedAt: scanStartedAt.toISOString(),
    mode: "changed",
    fileCount: changedFiles.length,
    remotePath: sftp.remotePath,
  });
  writeLocalSessionRecord(localPath, {
    action: "uploadChanged",
    device: getDeviceName(),
    remotePath: sftp.remotePath,
    fileCount: changedFiles.length,
    at: new Date().toISOString(),
  });
  vscode.window.setStatusBarMessage(`SimpleSFTP：已上传 ${changedFiles.length} 个变更文件`, 3500);
}

async function uploadAllLocalToRemote({ localPath, sftp, writeState = true, pathConfirmed = false, options = {} }) {
  return withHostOperationLease("upload-all-files", "上传全部本地文件", localPath, () => uploadAllLocalToRemoteCore({ localPath, sftp, writeState, pathConfirmed, options }));
}

async function uploadAllLocalToRemoteCore({ localPath, sftp, writeState = true, pathConfirmed = false, options = {} }) {
  if (!sftp || !sftp.remotePath || !sftp.host) {
    throw new Error("未配置可用的 SFTP 远端路径。");
  }
  if (!pathConfirmed) {
    await confirmTransferPath({ localPath, sftp, operation: "上传全部本地文件", detail: "当前工作区内未被忽略的文件" });
  }

  const uploadStartedAt = new Date();
  const uploadPlan = createWorkspaceUploadPlan(localPath, sftp);
  if (!uploadPlan.fileCount) {
    throw new Error("没有要上传的文件；所有文件都被忽略规则排除。");
  }
  const stats = await runUploadWithProgress(options, `上传全部本地文件 -> ${sftp.remotePath}`, (token, progress) => runLocalTarUpload({
      localPath,
      sftp,
      uploadPlan,
      operation: "上传全部文件",
      timeoutMs: transferTimeoutMs(sftp, options),
      token,
      transferId: options.transferId,
      progress,
    }));
  if (writeState) {
    writeUploadState(localPath, {
      lastUploadedAt: uploadStartedAt.toISOString(),
      mode: "all",
      remotePath: sftp.remotePath,
    });
  }
  return stats;
}

function findChangedLocalFiles({ localPath, sftp }) {
  const baselineMs = getUploadBaselineMs(localPath);
  const changed = [];
  walkLocalFiles(localPath, "", sftp.ignore, (relativePath, fullPath) => {
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs > baselineMs + 1) {
      changed.push(relativePath);
    }
  });
  return changed.sort((a, b) => a.localeCompare(b));
}

function walkLocalFiles(rootPath, relativeDir, ignorePatterns, visitFile, planStats = null, nestedGitRoots = null) {
  const currentDir = relativeDir ? path.join(rootPath, relativeDir) : rootPath;
  if (relativeDir && fs.existsSync(path.join(currentDir, ".git"))) {
    if (planStats) {
      planStats.excludedNestedGitRepos += 1;
      (nestedGitRoots || []).push(relativeDir);
    }
    return;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const relativePath = toPosixPath(relativeDir ? path.join(relativeDir, entry.name) : entry.name);
    const ignored = isIgnoredLocalPath(relativePath, ignorePatterns);
    if (ignored && planStats) planStats.excludedRuleHits += 1;
    if (ignored) continue;

    const fullPath = path.join(rootPath, relativePath);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walkLocalFiles(rootPath, relativePath, ignorePatterns, visitFile, planStats, nestedGitRoots);
      continue;
    }
    if (entry.isFile()) {
      visitFile(relativePath, fullPath);
    }
  }
}

function createWorkspaceUploadPlan(localPath, sftp) {
  const files = [];
  const nestedGitRoots = [];
  const stats = { excludedRuleHits: 0, excludedNestedGitRepos: 0 };
  walkLocalFiles(localPath, "", sftp.ignore, (relativePath, fullPath) => {
    const size = fs.statSync(fullPath).size;
    files.push({ relativePath, fullPath, size });
    stats.byteCount = (stats.byteCount || 0) + Number(size) || 0;
  }, stats, nestedGitRoots);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    mode: "workspace",
    files,
    fileCount: files.length,
    byteCount: files.reduce((total, file) => total + file.size, 0),
    excludedRuleHits: stats.excludedRuleHits,
    excludedNestedGitRepos: stats.excludedNestedGitRepos,
    nestedGitRoots: nestedGitRoots.sort(),
  };
}

function createManifestUploadPlan({ localPath, sftp, manifest, changedPaths }) {
  const changed = Array.isArray(changedPaths) ? new Set(changedPaths) : null;
  const relativePaths = getManifestUploadRelativePaths({ localPath, sftp, manifest })
    .filter((relativePath) => !changed || changed.has(relativePath));
  const files = relativePaths.map((relativePath) => {
    const fullPath = path.join(localPath, relativePath);
    const size = fs.statSync(fullPath).size;
    return { relativePath, fullPath, size };
  });
  return {
    mode: "manifest",
    files,
    fileCount: files.length,
    byteCount: files.reduce((total, file) => total + file.size, 0),
    excludedRuleHits: 0,
    excludedNestedGitRepos: 0,
    nestedGitRoots: [],
  };
}

function hashUploadPlanChunks(files, chunkSize = 500) {
  const hash = crypto.createHash("sha256");
  const chunks = [];
  for (let start = 0; start < files.length; start += chunkSize) {
    const entries = files.slice(start, start + chunkSize).map((file) => [
      toTarPath(file.relativePath),
      Number(file.size) || 0,
    ]);
    const payload = `${start}:${entries.length}:${JSON.stringify(entries)}`;
    const checksum = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
    hash.update(checksum);
    chunks.push({ start, count: entries.length, checksum });
  }
  return { algorithm: "sha256", chunkSize, chunks, combinedChecksum: hash.digest("hex") };
}

function getUploadBaselineMs(localPath) {
  const state = readUploadState(localPath);
  const stateTime = parseTimeMs(state && state.lastUploadedAt);
  if (stateTime !== null) return stateTime;

  const session = readLocalSessionRecord(localPath);
  const sessionTime = parseTimeMs(session && (session.at || session.markedAt));
  if (sessionTime !== null) return sessionTime;

  const now = new Date();
  writeUploadState(localPath, {
    lastUploadedAt: now.toISOString(),
    mode: "initial",
  });
  return now.getTime();
}

function readUploadState(localPath) {
  const statePath = path.join(localPath, ".vscode", SAVE_UPLOAD_STATE);
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function writeUploadState(localPath, state) {
  const vscodeDir = path.join(localPath, ".vscode");
  fs.mkdirSync(vscodeDir, { recursive: true });
  fs.writeFileSync(
    path.join(vscodeDir, SAVE_UPLOAD_STATE),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8"
  );
}

function readLocalSessionRecord(localPath) {
  const sessionPath = path.join(localPath, ".vscode", "simple-sftp-session.json");
  if (!fs.existsSync(sessionPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  } catch {
    return null;
  }
}

function parseTimeMs(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function isIgnoredLocalPath(relativePath, ignorePatterns) {
  const normalized = toPosixPath(relativePath).replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized) return false;
  const lowerPath = normalized.toLowerCase();
  const patterns = Array.isArray(ignorePatterns) ? ignorePatterns : [];
  return patterns.some((pattern) => patternMatchesPath(lowerPath, String(pattern).toLowerCase()));
}

function applyUploadOnSaveSettingToOpenWorkspaces() {
  const folders = vscode.workspace.workspaceFolders || [];
  for (const folder of folders) {
    let localPath;
    try {
      localPath = getWorkspaceRoot(folder);
    } catch {
      continue;
    }
    if (!readSftpConfig(localPath)) continue;
    disableExternalUploadOnSave(localPath);
    getUploadBaselineMs(localPath);
  }
}

function disableExternalUploadOnSave(localPath) {
  const sftpPath = path.join(localPath, ".vscode", "sftp.json");
  if (!fs.existsSync(sftpPath)) return;

  let sftp;
  try {
    sftp = JSON.parse(fs.readFileSync(sftpPath, "utf8"));
  } catch {
    return;
  }
  if (!sftp || sftp.uploadOnSave === false) return;

  sftp.uploadOnSave = false;
  fs.writeFileSync(sftpPath, `${JSON.stringify(sftp, null, 2)}\n`, "utf8");
}

function getWorkspaceFolderForFile(filePath) {
  const folders = vscode.workspace.workspaceFolders || [];
  const api = process.platform === "win32" ? path.win32 : path.posix;
  const normalize = value => process.platform === "win32" ? api.normalize(value).toLowerCase() : api.normalize(value);
  const normalizedFile = normalize(filePath);
  return folders
    .map((folder) => {
      try {
        return { folder, normalizedPath: normalize(getWorkspaceRoot(folder)) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(({ normalizedPath }) => (
      normalizedFile === normalizedPath ||
      normalizedFile.startsWith(`${normalizedPath}${api.sep}`)
    ))
    .sort((a, b) => b.normalizedPath.length - a.normalizedPath.length)
    .map(({ folder }) => folder)[0] || null;
}

function runLocalTarUpload(options) {
  const plan = options.uploadPlan || createWorkspaceUploadPlan(options.localPath, options.sftp);
  validateTarEntries(plan.files, process.platform);
  return withFileResourceLease(options.operation || "批量上传", options.sftp.remotePath,
    plan.files.map(file => file.relativePath), remoteResourceServer(options.sftp),
    () => withTransferCapacity({ server: options.sftp }, () => runLocalTarUploadCore({ ...options, uploadPlan: plan })));
}
function runLocalTarUploadCore({ localPath, sftp, uploadPlan, operation, timeoutMs, token, transferId, progress }) {
  const remoteCommand = createRemoteExtractCommand(sftp.remotePath);
  getSshArgs(sftp, remoteCommand);
  const plan = uploadPlan || createWorkspaceUploadPlan(localPath, sftp);
  validateTarEntries(plan.files, process.platform);
  const manifestContent = `${plan.files.map((file) => tarEntryPath(file.relativePath, process.platform)).join("\n")}\n`;
  const chunkedChecksum = hashUploadPlanChunks(plan.files);
  const startedAt = Date.now();
  const upload = new Promise((resolve, reject) => {
    const controller = createTransferController({
      id: transferId || nextTransferId(operation),
      operation,
      localPath,
      remotePath: String(sftp && sftp.remotePath || ""),
      host: String(sftp && sftp.host || ""),
    });
    controller.totalBytes = plan.byteCount;
    let reportedPercent = 0;
    let sshProc;
    try { sshProc = spawnSsh(sftp, remoteCommand, { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] }); }
    catch (error) { controller.dispose(); throw error; }
    trackTransferResource(sshProc, controller.operationId);

    let settled = false;
    let sshCode;
    let sshStderr = "";
    let cancelListener;
    let tokenDisposable;
    let timer;

    const stopController = (disposeController = true) => {
      clearTimeout(timer);
      if (tokenDisposable && typeof tokenDisposable.dispose === "function") {
        tokenDisposable.dispose();
      }
      if (disposeController) controller.dispose();
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      stopController(false);
      // EOF lets the remote tar process report its exit before retry is permitted.
      try { sshProc.stdin.end(); } catch { try { sshProc.kill(); } catch {} }
      try {
        reject(classifySftpFailure(error, sftp, {
          command: remoteCommand,
          sshStderr,
        }));
      } catch {
        reject(error);
      }
    };

    const finish = () => {
      if (settled || sshCode === undefined) return;
      settled = true;
      stopController();
      if (sshCode !== 0) {
        const failure = new Error(formatProcessFailure({
          operation,
          sshCode,
          sshStderr,
        }));
        reject(classifySftpFailure(failure, sftp, {
          command: remoteCommand,
          sshCode,
          sshStderr,
        }));
        return;
      }
      if (progress && reportedPercent < 100) progress.report({ increment: 100 - reportedPercent, message: "已上传并完成远端解包" });
      resolve({
        fileCount: plan.fileCount,
        byteCount: plan.byteCount,
        excludedRuleHits: plan.excludedRuleHits,
        excludedNestedGitRepos: plan.excludedNestedGitRepos,
        nestedGitRoots: plan.nestedGitRoots,
        durationMs: Date.now() - startedAt,
        verification: {
          method: "chunked-sha256",
          ...chunkedChecksum,
          manifestSha256: crypto.createHash("sha256").update(manifestContent, "utf8").digest("hex"),
        },
      });
    };

    cancelListener = (reason) => fail(new Error(reason || "传输已取消"));
    controller.onCancel(cancelListener);
    if (token) {
      if (token.isCancellationRequested) {
        fail(new Error("传输已取消"));
      } else if (typeof token.onCancellationRequested === "function") {
        tokenDisposable = token.onCancellationRequested(() => fail(new Error("传输已取消")));
      }
    }


    sshProc.on("error", fail);
    let unpackBuffer = ""; const unpacked = new Set();
    sshProc.stderr.on("data", (chunk) => {
      unpackBuffer += chunk.toString("utf8");
      const lines = unpackBuffer.split("\n"); unpackBuffer = lines.pop() || "";
      for (const name of lines) { if (plan.files.some(file => tarEntryPath(file.relativePath) === name) && !unpacked.has(name)) { unpacked.add(name); controller.updateProgress({ phase: "unpacking", processedFiles: unpacked.size }); } }
      sshStderr = appendProcessOutput(sshStderr, chunk);
    });
    sshProc.stdin.on("error", () => {});

    writeTarEntriesToStream({ localPath, files: plan.files, stream: sshProc.stdin, onFileBytes: (bytes) => {
      controller.transferredBytes += bytes;
      if (progress && plan.byteCount > 0) {
        const percent = Math.min(99, Math.floor(controller.transferredBytes * 100 / plan.byteCount));
        if (percent > reportedPercent) {
          progress.report({ increment: percent - reportedPercent, message: `${percent}% · ${controller.transferredBytes}/${plan.byteCount} 字节` });
          reportedPercent = percent;
        }
      }
    }, platform: process.platform })
      .then(() => sshProc.stdin.end())
      .catch(fail);
    sshProc.on("close", (code, signal) => {
      sshCode = code === null ? `signal ${signal || "unknown"}` : code;
      if (settled) { controller.dispose(); return; }
      finish();
      });
    });

  return upload.finally(() => {
  });
}

function createRemoteExtractCommand(remotePath) {
  const safeRemotePath = String(remotePath).replace(/\/+$/, "");
  return `mkdir -p ${shellQuote(safeRemotePath)} && tar -xvf - --index-file=/dev/stderr -C ${shellQuote(safeRemotePath)}`;
}

let mappedDownloadTransport = null;
function setMappedDownloadTransport(fn) {
  mappedDownloadTransport = typeof fn === "function" ? fn : null;
}

async function downloadMappedPaths(options = {}) {
  const localPath = resolveLocalWorkspacePath(options.localPath, "映射批量下载");
  return withHostOperationLease("download-mapped-paths", "映射批量下载", localPath, () => downloadMappedPathsCore({ ...options, localPath }));
}

async function downloadMappedPathsCore(options = {}) {
  return withTransferCapacity(options, () => downloadMappedPathsInternal(options));
}

async function downloadMappedPathsInternal(options = {}) {
  const localPath = localPathText(options.localPath || "", process.platform);
  let plan = options.plan || normalizeMappedDownloadEntries(options);
  const sftp = options.sftp || apiTransferSftp({ ...options, localPath });
  if (!sftp || !sftp.host || !sftp.remotePath) throw new Error("未配置可用的 SFTP 远端路径。");
  if (!plan.memoryOnly) assertMappedLocalDestinations(localPath, plan);
  const decision = await selectTransferCompression({ ...options, compression: plan.requestedCompression || options.compression || plan.compression }, sftp,
    { host: "local", port: 0, username: "", remotePath: localPath }, plan.entries.map(item => item.remotePath), Object.fromEntries(plan.entries.map(item => [item.remotePath, item.bytes || 0])), true);
  plan = { ...plan, compression: decision.compression };
  const archiveNames = plan.entries.map((_, index) => `mapped/${index}`);
  const byArchiveName = new Map(plan.entries.map((entry, index) => [archiveNames[index], entry]));
  const stage = { name: "validate", sshCount: 0 };
  const progressState = {
    phase: "打包前校验",
    transferredBytes: 0,
    byteCount: plan.byteCount,
    fileCount: plan.entries.length,
    completedFiles: 0,
  };
  const report = (message) => {
    progressState.message = message;
    if (options.progress && typeof options.progress.report === "function") options.progress.report({ message });
  };
  report(`校验 ${plan.entries.length} 个映射，准备单批最多 ${plan.maxBatchBytes} 字节的${plan.compression === "gzip" ? "gzip 压缩" : "无压缩"}打包`);
  let stream;
  let sshExitSeen = null;
  const watchSshExit = () => {
    if (!stream || !stream.sshExit || typeof stream.sshExit.then !== "function" || sshExitSeen) return;
    sshExitSeen = stream.sshExit.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  };
  try {
    stage.name = "transfer";
    if (mappedDownloadTransport) {
      stage.sshCount = 1;
      const transportResult = await Promise.resolve().then(() => mappedDownloadTransport({
        sftp,
        entries: plan.entries.map((entry) => ({ remotePath: entry.remotePath, archiveName: `mapped/${entry.index}`, bytes: entry.bytes, sha256: entry.sha256 })),
        maxFileBytes: plan.maxFileBytes,
        maxBatchBytes: plan.maxBatchBytes,
        remoteCommand: createMappedDownloadCommand(sftp, plan),
        timeoutMs: transferTimeoutMs(sftp, options),
        transferId: options.transferId,
        signal: {
          cancelled: () => Boolean(options.token && options.token.isCancellationRequested || transferContext.getStore()?.status === "cancelled"),
        },
      }));
      stream = transportResult;
      watchSshExit();
    } else {
      stream = openMappedDownloadStream({
        sftp,
        plan,
        localPath,
        timeoutMs: transferTimeoutMs(sftp, options),
        token: options.token,
        transferId: options.transferId,
        progress: options.progress,
        onSpawn: () => { stage.sshCount += 1; },
      });
      watchSshExit();
    }
    stage.name = "extract";
    const extract = () => (plan.memoryOnly ? extractMappedMetricsToMemory : extractMappedTarStream)({
      stream,
      byArchiveName,
      localPath,
      maxFileBytes: plan.maxFileBytes,
      maxBatchBytes: plan.maxBatchBytes,
      overwrite: plan.overwrite,
      shouldCancel: () => Boolean(options.token && options.token.isCancellationRequested || transferContext.getStore()?.status === "cancelled"),
      onFileBytes: (bytes) => {
        progressState.transferredBytes += bytes;
        transferContext.getStore()?.updateProgress({ phase: "distributing", processedBytes: progressState.transferredBytes });
        report(`已接收 ${progressState.transferredBytes} 字节，${plan.memoryOnly ? "正在核验指标（不落盘）" : "正在按映射写入"}`);
      },
      onFile: () => { progressState.completedFiles += 1; transferContext.getStore()?.updateProgress({ phase: "distributing", processedFiles: progressState.completedFiles }); },
    });
    const written = plan.memoryOnly ? await extract() : await withFileResourceLease("指标文件分发", localPath, plan.entries.map(entry => entry.localRelativePath), "local", extract);
    if (written.length !== plan.entries.length) {
      const missing = plan.entries.filter((entry) => !written.some((item) => item.remotePath === entry.remotePath));
      const error = new Error(`映射下载未完成：缺少 ${missing.map((entry) => entry.remotePath).join("、") || "未知条目"}。阶段：解包。下一步：核对远端文件是否仍是普通文件后重试这一批。`);
      error.stage = "extract";
      error.partial = written;
      throw error;
    }
    if (sshExitSeen) {
      stage.name = "transfer";
      const exit = await sshExitSeen;
      if (!exit.ok) throw exit.error;
    }
    return {
      ok: true,
      ...(plan.memoryOnly ? { memoryOnly: true } : {}),
      localPath,
      remotePath: sftp.remotePath,
      host: sftp.host,
      fileCount: written.length,
      byteCount: written.reduce((total, item) => total + item.bytes, 0),
      transferredBytes: progressState.transferredBytes,
      completedFiles: written.length,
      streamCount: 1,
      compression: plan.compression || "none",
      compressionDecision: decision,
      wireBytes: stream.wireBytes || 0,
      sshCount: stage.sshCount,
      entries: written,
      phase: "complete",
    };
  } catch (error) {
    if (stream && typeof stream.destroy === "function") stream.destroy();
    if (sshExitSeen) {
      const exit = await sshExitSeen;
      if (!exit.ok && error && error.stage === "extract" && exit.error && exit.error.stage === "transfer") {
        if (error.partialResiduals) exit.error.partialResiduals = error.partialResiduals;
        if (error.partial) exit.error.partial = error.partial;
        throw exit.error;
      }
    }
    if (plan.memoryOnly && error) { delete error.partial; delete error.partialResiduals; }
    if (error && error.stage) throw error;
    const wrapped = error instanceof Error ? error : new Error(String(error || "映射下载失败"));
    wrapped.stage = wrapped.stage || stage.name;
    if (!wrapped.nextStep) {
      wrapped.nextStep = plan.memoryOnly
        ? "指标批次未完整核验，未发布本批指标且未写入原始文件；核对 SSH 后重试整批。"
        : stage.name === "transfer"
        ? "传输未完成，已写入的文件保留；核对 SSH 后重试整批，不要逐文件下载。"
        : "解包未完成，已写入的文件保留；核对映射和远端文件后重试整批。";
    }
    if (!/阶段：/.test(wrapped.message)) {
      wrapped.message = `映射下载失败。阶段：${wrapped.stage}。${wrapped.message} 下一步：${wrapped.nextStep}`;
    }
    throw wrapped;
  }
}

function openMappedDownloadStream({ sftp, plan, localPath, timeoutMs, token, transferId, onSpawn, progress, spawnImpl }) {
  const remoteCommand = createMappedDownloadCommand(sftp, plan);
  getSshArgs(sftp, remoteCommand);
  const remoteRequest = createMappedDownloadRequest(sftp, plan);
  const { PassThrough } = require("stream");
  const output = new PassThrough();
  let resolveExit;
  let rejectExit;
  output.sshExit = new Promise((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  output.sshExit.catch(() => undefined);
  const controller = createTransferController({
    id: transferId || nextTransferId("映射批量下载"),
    operation: "映射批量下载",
    localPath: String(localPath || ""),
    remotePath: String(sftp.remotePath || ""),
    host: String(sftp.host || ""),
  });
  controller.totalBytes = plan.byteCount || 0;
  const launch = spawnImpl || spawn;
  let sshProc;
  try {
    sshProc = spawnSsh(sftp, remoteCommand, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }, launch);
  } catch (error) {
    // No child exists: do not retain a phantom active transfer after spawn fails.
    controller.dispose();
    rejectExit(error);
    output.destroy();
    throw error;
  }
  trackTransferResource(sshProc, controller.operationId);
  if (onSpawn) onSpawn(sshProc);
  let sshStderr = "";
  let settled = false;
  let timer;
  let tokenDisposable;
  let lastProgressAt = 0;
  output.wireBytes = 0;
  const wireStartedAt = Date.now();
  const archiveDecoder = plan.compression === "gzip" ? require("node:zlib").createGunzip() : null;
  const finishFailure = (error) => {
    const classified = classifySftpFailure(error, sftp, {
      command: remoteCommand,
      sshStderr,
      sshCode: error && error.sshCode,
    });
    classified.stage = "transfer";
    classified.sshCode = error && error.sshCode;
    classified.nextStep = "SSH 打包流未完成；核对主机、超时和远端 python3 后重试整批。";
    rejectExit(classified);
    archiveDecoder?.destroy();
    output.destroy();
  };
  const fail = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (tokenDisposable && typeof tokenDisposable.dispose === "function") tokenDisposable.dispose();
    archiveDecoder?.destroy();
    try { sshProc.kill(); } catch {}
    finishFailure(error);
  };
  controller.onCancel((reason) => fail(new Error(reason || "传输已取消")));
  if (token) {
    if (token.isCancellationRequested) fail(new Error("传输已取消"));
    else if (typeof token.onCancellationRequested === "function") {
      tokenDisposable = token.onCancellationRequested(() => fail(new Error("传输已取消")));
    }
  }

  sshProc.on("error", fail);
  if (archiveDecoder) {
    archiveDecoder.on("error", fail);
    archiveDecoder.on("data", (chunk) => { if (!output.write(chunk)) archiveDecoder.pause(); });
    archiveDecoder.on("drain", () => sshProc.stdout.resume());
  }
  sshProc.stderr.on("data", (chunk) => { sshStderr = appendProcessOutput(sshStderr, chunk); });
  sshProc.stdout.on("data", (chunk) => {
    output.wireBytes += chunk.length;
    controller.transferredBytes += chunk.length;
    const now = Date.now();
    if (progress && typeof progress.report === "function" && now - lastProgressAt >= 250) {
      progress.report({ message: `已接收 ${controller.transferredBytes} 字节，正在解包映射` });
      lastProgressAt = now;
    }
    if (!(archiveDecoder || output).write(chunk)) sshProc.stdout.pause();
  });
  output.on("drain", () => {
    if (archiveDecoder) { archiveDecoder.resume(); return; }
    if (sshProc.stdout && !sshProc.stdout.destroyed && typeof sshProc.stdout.resume === "function") sshProc.stdout.resume();
  });
  output.on("close", () => {
    if (!settled) fail(new Error("传输已取消"));
  });
  sshProc.on("close", (code, signal) => {
    clearTimeout(timer);
    if (tokenDisposable && typeof tokenDisposable.dispose === "function") tokenDisposable.dispose();
    controller.dispose();
    const sshCode = code === null ? `signal ${signal || "unknown"}` : code;
    if (code !== 0) {
      const failure = new Error(formatProcessFailure({
        operation: "映射批量下载",
        sshCode,
        sshStderr,
      }));
      failure.sshCode = sshCode;
      failure.stage = "transfer";
      if (!settled) {
        settled = true;
        finishFailure(failure);
      }
      return;
    }
    if (settled) return;
    const finish = () => {
      if (settled) return;
      settled = true;
      output.end();
      compressionHistory.record(compressionHistory.key(sftp, { host: "local", port: 0, username: "", remotePath: localPath }), output.wireBytes, Date.now() - wireStartedAt);
      resolveExit({ sshCode: 0 });
    };
    if (archiveDecoder) { archiveDecoder.once("end", finish); archiveDecoder.end(); }
    else finish();
  });
  sshProc.stdin.on("error", fail);
  if (!settled) {
    try { sshProc.stdin.end(remoteRequest); } catch (error) { fail(error); }
  }
  return output;
}

function createMappedDownloadCommand(sftp, plan) {
  return `python3 -c ${shellQuote(createMappedDownloadScript())}`;
}

function createMappedDownloadRequest(sftp, plan) {
  const payload = Buffer.from(JSON.stringify({
    root: String(sftp.remotePath).replace(/\/+$/, ""),
    files: plan.entries.map((entry) => ({ remotePath: entry.remotePath, archiveName: `mapped/${entry.index}`, bytes: entry.bytes, sha256: entry.sha256 })),
    maxFileBytes: plan.maxFileBytes,
    maxBatchBytes: plan.maxBatchBytes,
    compression: plan.compression || "none",
  }), "utf8");
  if (payload.length > 1024 * 1024) throw new Error("映射下载请求超过 1 MiB 上限，未启动 SSH。");
  return payload;
}

function createMappedDownloadScript() {
  return [
    "import gzip,json,os,sys,tarfile",
    "payload=sys.stdin.buffer.read(1048577)",
    "if len(payload) > 1048576: raise SystemExit('mapped request exceeds byte limit')",
    "request=json.loads(payload.decode('utf-8'))",
    "root_path=str(request.get('root') or '')",
    "if not os.path.isabs(root_path): raise SystemExit('mapped root must be absolute')",
    "root=os.path.realpath(root_path)",
    "files=request.get('files') or []",
    "limit=int(request.get('maxFileBytes') or 0)",
    "batch_limit=int(request.get('maxBatchBytes') or 0)",
    "def fail(message):",
    "    sys.stderr.write(message+'\\n')",
    "    raise SystemExit(73)",
    "def inside(value):",
    "    try: return os.path.commonpath([root, value]) == root",
    "    except ValueError: return False",
    "selected=[]",
    "total_size=0",
    "seen=set()",
    "for item in files:",
    "    rel=item.get('remotePath')",
    "    if not isinstance(rel,str) or not rel or len(rel.encode('utf-8')) > 4096 or any(ord(c) < 32 or ord(c) == 127 or c in (':',chr(92)) for c in rel): fail('unsafe remote path')",
    "    archive=str(item.get('archiveName') or '')",
    "    parts=[part for part in rel.split('/') if part]",
    "    if not rel or rel != '/'.join(parts) or any(part in ('.','..') for part in parts): fail('unsafe remote path: '+rel)",
    "    if not archive.startswith('mapped/') or '/' in archive[7:] or not archive[7:].isdigit(): fail('unsafe archive name')",
    "    if rel in seen: fail('duplicate remote path: '+rel)",
    "    seen.add(rel)",
    "    cursor=root",
    "    for part in parts:",
    "        cursor=os.path.join(cursor, part)",
    "        if os.path.islink(cursor): fail('remote symlink: '+rel)",
    "    full=os.path.realpath(cursor)",
    "    if not inside(full) or os.path.islink(full) or not os.path.isfile(full): fail('remote file missing or unsafe: '+rel)",
    "    size=os.path.getsize(full)",
    "    declared=item.get('bytes')",
    "    if size > limit: fail('remote file exceeds limit: '+rel)",
    "    if declared is not None and int(declared) != size: fail('remote size changed: '+rel)",
    "    total_size += size",
    "    if batch_limit > 0 and total_size > batch_limit: fail('mapped batch exceeds uncompressed byte limit: '+str(batch_limit))",
    "    selected.append((archive, full, size))",
    "sink=gzip.GzipFile(fileobj=sys.stdout.buffer,mode='wb',compresslevel=6) if request.get('compression') == 'gzip' else sys.stdout.buffer",
    "with tarfile.open(fileobj=sink, mode='w|', format=tarfile.GNU_FORMAT) as archive:",
    "    for name, full, size in selected:",
    "        info=tarfile.TarInfo(name)",
    "        info.size=size",
    "        info.mode=0o644",
    "        info.type=tarfile.REGTYPE",
    "        with open(full, 'rb') as handle: archive.addfile(info, handle)",
    "if request.get('compression') == 'gzip': sink.close()",
  ].join("\n");
}

const MAPPED_TAR_BLOCK = 512;

async function extractMappedMetricsToMemory({ stream, byArchiveName, maxFileBytes, maxBatchBytes, onFileBytes, onFile, shouldCancel }) {
  const pending = new Map(byArchiveName), written = [];
  const reader = createTarByteReader(stream);
  let total = 0, zeros = 0;
  for (;;) {
    if (shouldCancel?.()) throw new Error("指标下载已取消");
    const header = await reader.take(512);
    if (!header) throw new Error("指标 tar 流缺少完整尾部");
    if (header.every(byte => byte === 0)) { if (++zeros === 2) break; continue; }
    if (zeros) throw new Error("指标 tar 尾部不连续");
    const parsed = parseMappedTarHeader(header), target = pending.get(parsed.name);
    if (!target || !["0", "\0"].includes(parsed.typeflag) || parsed.size !== target.bytes || parsed.size > maxFileBytes) throw new Error("指标 tar 条目或大小不符合声明");
    total += parsed.size;
    if (total > maxBatchBytes || total > 4 * 1024 * 1024) throw new Error("内存指标下载超过批次上限");
    const body = Buffer.alloc(parsed.size), digest = crypto.createHash("sha256");
    for (let received = 0; received < body.length;) {
      if (shouldCancel?.()) throw new Error("指标下载已取消");
      const piece = await reader.take(Math.min(65536, body.length - received));
      if (!piece) throw new Error("指标 tar 文件中断");
      piece.copy(body, received); received += piece.length; digest.update(piece); onFileBytes?.(piece.length);
    }
    const sha256 = digest.digest("hex");
    if (sha256 !== target.sha256) throw new Error(`文件 SHA256 与权威结果不一致：${target.remotePath}`);
    const padding = (512 - parsed.size % 512) % 512;
    if (padding) await reader.discard(padding);
    written.push({ remotePath: target.remotePath, bytes: body.length, sha256, dataBase64: body.toString("base64"), ok: true });
    pending.delete(parsed.name); onFile?.(target);
  }
  if (pending.size) throw new Error("指标 tar 缺少声明文件");
  if (stream.sshExit) await stream.sshExit;
  return written;
}

async function extractMappedTarStream({ stream, byArchiveName, localPath, maxFileBytes, maxBatchBytes = MAPPED_DOWNLOAD_DEFAULT_MAX_BATCH_BYTES, overwrite, onFileBytes, onFile, shouldCancel }) {
  const pending = new Map(byArchiveName);
  const written = [];
  const staged = [];
  const residuals = [];
  const reader = createTarByteReader(stream);
  const root = path.resolve(localPath);
  let zeroBlocks = 0;
  let archiveBytes = 0;
  const failExtract = (message, extra = {}) => {
    const error = new Error(`${message}。阶段：解包。下一步：已完成文件保留，未完成目标保持原内容；残留临时文件见 partialResiduals。`);
    error.stage = "extract";
    error.partial = written.slice();
    error.partialResiduals = residuals.slice();
    Object.assign(error, extra);
    return error;
  };
  try {
    for (;;) {
      if (shouldCancel && shouldCancel()) {
        if (stream && typeof stream.destroy === "function") stream.destroy();
        throw failExtract("传输已取消");
      }
      const block = await reader.take(MAPPED_TAR_BLOCK);
      if (!block) break;
      if (block.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        if (zeroBlocks >= 2) break;
        continue;
      }
      zeroBlocks = 0;
      const parsed = parseMappedTarHeader(block);
      const padding = (MAPPED_TAR_BLOCK - (parsed.size % MAPPED_TAR_BLOCK)) % MAPPED_TAR_BLOCK;
      if (parsed.pax || parsed.typeflag === "5") {
        if (parsed.size > 65536) throw failExtract("tar 元数据超过有界大小");
        await reader.discard(parsed.size + padding);
        continue;
      }
      const target = pending.get(parsed.name);
      if (!target || parsed.typeflag !== "0" && parsed.typeflag !== "\0" || parsed.size > maxFileBytes) {
        throw failExtract(`tar 条目未通过映射校验：${parsed.name || "(empty)"}`);
      }
      archiveBytes += parsed.size;
      if (archiveBytes > maxBatchBytes) throw failExtract("映射批次超过未压缩字节上限");
      const destination = target.localFullPath;
      const parent = path.dirname(destination);
      fs.mkdirSync(parent, { recursive: true });
      assertMappedAncestorChain(root, target.localRelativePath);
      let existing = null;
      try { existing = fs.lstatSync(destination); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (existing) {
        if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) throw failExtract(`写入前本机目标不再是独占普通文件：${target.localRelativePath}`);
        if (!overwrite) throw failExtract(`本机文件已存在，未确认覆盖：${target.localRelativePath}`);
      }
      const staging = mappedStagingPath(destination);
      residuals.push(staging);
      const handle = openMappedStagingStream(staging);
      trackTransferResource(handle);
      let received = 0;
      const expectedSha256 = String(target.sha256 || "").toLowerCase();
      const digest = expectedSha256 ? require("crypto").createHash("sha256") : null;
      try {
        while (received < parsed.size) {
          if (shouldCancel && shouldCancel()) throw failExtract("传输已取消");
          const piece = await reader.take(Math.min(64 * 1024, parsed.size - received));
          if (!piece) throw failExtract("tar 流在文件结束前中断");
          await writeStreamChunk(handle, piece);
          if (digest) digest.update(piece);
          received += piece.length;
          if (onFileBytes) onFileBytes(piece.length);
        }
        await new Promise((resolve, reject) => fs.fsync(handle.fd, error => error ? reject(error) : resolve()));
        await closeWriteStream(handle);
        const actualSha256 = digest ? digest.digest("hex") : "";
        if (expectedSha256 && actualSha256 !== expectedSha256) throw failExtract(`文件 SHA256 与权威结果不一致：${target.remotePath}`);
        if (padding) await reader.discard(padding);
        assertMappedAncestorChain(root, target.localRelativePath);
        if (existing && !overwrite) throw failExtract(`本机文件已存在，未确认覆盖：${target.localRelativePath}`);
        staged.push({ staging, destination, target, size: parsed.size, sha256: actualSha256, existed: Boolean(existing) });
      } catch (error) {
        handle.destroy();
        if (!handle.closed) await new Promise((resolve) => handle.once("close", resolve));
        if (error && error.partialResiduals) throw error;
        throw failExtract(error && error.message || "映射写入失败");
      }
      pending.delete(parsed.name);
    }
    if (zeroBlocks < 2 || pending.size) throw failExtract("映射归档缺少完整尾部或声明文件");
    if (stream && stream.sshExit && typeof stream.sshExit.then === "function") await stream.sshExit;
    for (const item of staged) {
      assertMappedAncestorChain(root, item.target.localRelativePath);
      fs.renameSync(item.staging, item.destination);
      const index = residuals.indexOf(item.staging);
      if (index >= 0) residuals.splice(index, 1);
      written.push({
        remotePath: item.target.remotePath,
        localRelativePath: item.target.localRelativePath,
        localPath: item.destination,
        bytes: item.size,
        sha256: item.sha256,
        ok: true,
      });
      if (onFile) onFile(item.target);
    }
  } catch (error) {
    const original = error && error.partialResiduals ? error : failExtract(error && error.message || "映射解包失败");
    const cleanupFailures = cleanupMappedStagingFiles(root, residuals);
    original.partialResiduals = cleanupFailures;
    if (cleanupFailures.length) original.message += ` 暂存保留供同目标重试复用：${cleanupFailures.map((item) => path.basename(item)).join("、")}`;
    throw original;
  }
  return written;
}

// Compatibility entry: report recoverable slots; never delete incomplete data automatically.
function cleanupMappedStagingFiles(root, paths) {
  return paths.filter(candidate => fs.existsSync(candidate));
}

function mappedStagingPath(destination) {
  const identity = crypto.createHash("sha256").update(path.resolve(destination)).digest("hex").slice(0, 32);
  return path.join(path.dirname(destination), `.${path.basename(destination)}.simple-sftp-partial-${identity}`);
}

function openMappedStagingStream(staging) {
  let before;
  try { before = fs.lstatSync(staging); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (before && (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1)) throw new Error("暂存槽不是独占普通文件");
  const fd = fs.openSync(staging, before ? fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0) : "wx");
  try {
    const opened = fs.fstatSync(fd), after = fs.lstatSync(staging);
    if (!opened.isFile() || opened.nlink !== 1 || after.isSymbolicLink() || opened.dev !== after.dev || opened.ino !== after.ino || before && (before.dev !== opened.dev || before.ino !== opened.ino)) throw new Error("暂存槽身份发生变化");
    fs.ftruncateSync(fd, 0);
    return fs.createWriteStream(staging, { fd, autoClose: true });
  } catch (error) { fs.closeSync(fd); throw error; }
}

function assertMappedAncestorChain(root, relativePath) {
  let rootStat;
  try { rootStat = fs.lstatSync(root); }
  catch { throw Object.assign(new Error(`本机项目目录不可用：${root}`), { stage: "extract" }); }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw Object.assign(new Error(`本机项目目录必须是真实目录：${root}`), { stage: "extract" });
  }
  let cursor = root;
  const parts = String(relativePath || "").split("/");
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    const last = index === parts.length - 1;
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) {
      if (error.code === "ENOENT") {
        if (last) return;
        throw Object.assign(new Error(`写入前映射父目录缺失：${cursor}`), { stage: "extract" });
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw Object.assign(new Error(`写入前映射路径包含符号链接：${cursor}`), { stage: "extract" });
    }
    if (!last && !stat.isDirectory()) {
      throw Object.assign(new Error(`写入前映射父级不是目录：${cursor}`), { stage: "extract" });
    }
    if (!last) {
      let real;
      try { real = fs.realpathSync(cursor); }
      catch { throw Object.assign(new Error(`无法解析映射父目录：${cursor}`), { stage: "extract" }); }
      const within = path.relative(fs.realpathSync(root), real);
      if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
        throw Object.assign(new Error(`写入前映射路径越出项目根目录：${relativePath}`), { stage: "extract" });
      }
    }
  }
}

function createTarByteReader(stream) {
  const chunks = [];
  let buffered = 0;
  const pull = () => new Promise((resolve, reject) => {
    if (stream.readableEnded || stream.destroyed || stream.closed) {
      const existing = typeof stream.read === "function" ? stream.read() : null;
      resolve(existing && existing.length ? existing : null);
      return;
    }
    const existing = stream.read();
    if (existing && existing.length) {
      resolve(existing);
      return;
    }
    const onReadable = () => {
      cleanup();
      resolve(stream.read() || Buffer.alloc(0));
    };
    const onDone = () => { cleanup(); resolve(null); };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      stream.off("readable", onReadable);
      stream.off("end", onDone);
      stream.off("close", onDone);
      stream.off("error", onError);
    };
    stream.once("readable", onReadable);
    stream.once("end", onDone);
    stream.once("close", onDone);
    stream.once("error", onError);
  });
  return {
    async take(size) {
      while (buffered < size) {
        const chunk = await pull();
        if (!chunk || !chunk.length) {
          if (!buffered) return null;
          const error = new Error("tar 流在块边界前中断。阶段：解包。下一步：重试整批。");
          error.stage = "extract";
          throw error;
        }
        chunks.push(chunk);
        buffered += chunk.length;
      }
      const out = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const head = chunks[0];
        const need = size - offset;
        if (head.length <= need) {
          head.copy(out, offset);
          offset += head.length;
          buffered -= head.length;
          chunks.shift();
        } else {
          head.copy(out, offset, 0, need);
          chunks[0] = head.subarray(need);
          buffered -= need;
          offset += need;
        }
      }
      return out;
    },
    async discard(size) {
      let left = size;
      while (left > 0) {
        const piece = await this.take(Math.min(left, 64 * 1024));
        if (!piece) {
          const error = new Error("tar 填充块不完整。阶段：解包。下一步：重试整批。");
          error.stage = "extract";
          throw error;
        }
        left -= piece.length;
      }
    },
  };
}

function parseMappedTarHeader(block) {
  if (!block || block.length !== MAPPED_TAR_BLOCK) {
    throw Object.assign(new Error("tar 头长度无效。阶段：解包。"), { stage: "extract" });
  }
  const checksumField = block.subarray(148, 156).toString("ascii");
  if (!/^[\0 ]*[0-7]{6}\0[ \0]$/.test(checksumField) && !/^[\0 ]*[0-7]{6}\0 $/.test(checksumField)) {
    throw Object.assign(new Error("tar 头校验域无效。阶段：解包。"), { stage: "extract" });
  }
  const unsigned = Buffer.from(block);
  unsigned.fill(0x20, 148, 156);
  const sum = unsigned.reduce((total, value) => total + value, 0);
  const expected = parseInt(checksumField.replace(/\0.*$/, "").trim(), 8);
  if (sum !== expected) throw Object.assign(new Error("tar 头校验和不匹配。阶段：解包。"), { stage: "extract" });
  const name = readTarField(block, 0, 100);
  const prefix = readTarField(block, 345, 155);
  const sizeText = block.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
  if (sizeText && !/^[0-7]+$/.test(sizeText)) {
    throw Object.assign(new Error("tar 头大小无效。阶段：解包。"), { stage: "extract" });
  }
  const typeflag = String.fromCharCode(block[156] || 48);
  const size = sizeText ? parseInt(sizeText, 8) : 0;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw Object.assign(new Error("tar 头大小无效。阶段：解包。"), { stage: "extract" });
  }
  const fullName = prefix ? `${prefix.replace(/\/$/, "")}/${name}` : name;
  return { name: fullName.replace(/^\.\//, ""), size, typeflag, pax: typeflag === "x" || typeflag === "g" };
}

function readTarField(block, offset, length) {
  return block.subarray(offset, offset + length).toString("utf8").split("\0", 1)[0];
}

function writeStreamChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => error ? reject(error) : resolve());
  });
}

function closeWriteStream(stream) {
  return new Promise((resolve, reject) => {
    stream.end((error) => error ? reject(error) : resolve());
  });
}

async function downloadRemoteToLocal({ localPath, sftp, downloadScope }) {
  return withHostOperationLease("download-workspace", "下载远端工作区", localPath, () => downloadRemoteToLocalCore({ localPath, sftp, downloadScope }));
}

async function downloadRemoteToLocalCore({ localPath, sftp, downloadScope }) {
  if (!sftp || !sftp.remotePath || !sftp.host) {
    throw new Error("未配置可用的 SFTP 远端路径。");
  }

  fs.mkdirSync(localPath, { recursive: true });
  const title = `正在同步远端到本地：${sftp.remotePath} -> ${localPath}`;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: uploadProgressCancellable(),
    },
    (progress, token) => runRemoteTarExtract({
      localPath,
      sftp,
      downloadScope,
      timeoutMs: transferTimeoutMs(sftp),
      token,
      progress,
    })
  );
}

function runRemoteTarExtract(options) {
  return withFileResourceLease("批量下载", options.localPath, options.downloadScope?.paths || [], "local",
    () => runRemoteTarExtractCore(options));
}
function runRemoteTarExtractCore({ localPath, sftp, downloadScope, timeoutMs, token, transferId, progress }) {
  const remoteCommand = createRemoteTarCommand(sftp, downloadScope);
  getSshArgs(sftp, remoteCommand);
  return new Promise((resolve, reject) => {
    const controller = createTransferController({
      id: transferId || nextTransferId("远端到本地同步"),
      operation: "远端到本地同步",
      localPath,
      remotePath: String(sftp && sftp.remotePath || ""),
      host: String(sftp && sftp.host || ""),
    });
    let sshProc;
    try { sshProc = spawnSsh(sftp, remoteCommand, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { controller.dispose(); throw error; }
    const tarProc = spawn("tar", ["-xvf", "-", "-C", localPath], {
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
    });
    trackTransferResource(sshProc, controller.operationId);
    trackTransferResource(tarProc, controller.operationId);

    let settled = false;
    let sshCode;
    let tarCode;
    let sshStderr = "";
    let tarStderr = "";
    let cancelListener;
    let tokenDisposable;
    let timer;
    let lastProgressAt = 0;

    const stopController = (disposeController = true) => {
      clearTimeout(timer);
      if (tokenDisposable && typeof tokenDisposable.dispose === "function") {
        tokenDisposable.dispose();
      }
      if (disposeController) controller.dispose();
    };

    const disposeAfterProcessesClose = () => {
      if (sshCode === undefined || tarCode === undefined) return;
      clearTimeout(timer);
      if (tokenDisposable && typeof tokenDisposable.dispose === "function") tokenDisposable.dispose();
      controller.dispose();
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      stopController(false);
      try { sshProc.kill(); } catch {}
      try { tarProc.kill(); } catch {}
      reject(classifySftpFailure(error, sftp, {
        command: remoteCommand,
        sshStderr,
        tarStderr,
      }));
      disposeAfterProcessesClose();
    };

    const finish = () => {
      if (settled || sshCode === undefined || tarCode === undefined) return;
      settled = true;
      stopController();
      if (sshCode !== 0 || tarCode !== 0) {
        const failure = new Error(formatProcessFailure({
          operation: "远端到本地同步",
          sshCode,
          tarCode,
          sshStderr,
          tarStderr,
        }));
        reject(classifySftpFailure(failure, sftp, {
          command: remoteCommand,
          sshCode,
          tarCode,
          sshStderr,
          tarStderr,
        }));
        return;
      }
      resolve();
    };

    cancelListener = (reason) => fail(new Error(reason || "传输已取消"));
    controller.onCancel(cancelListener);
    if (token) {
      if (token.isCancellationRequested) {
        fail(new Error("传输已取消"));
      } else if (typeof token.onCancellationRequested === "function") {
        tokenDisposable = token.onCancellationRequested(() => fail(new Error("传输已取消")));
      }
    }


    sshProc.on("error", fail);
    tarProc.on("error", fail);
    sshProc.stderr.on("data", (chunk) => {
      sshStderr = appendProcessOutput(sshStderr, chunk);
    });
    let unpackBuffer = ""; const unpacked = new Set();
    tarProc.stderr.on("data", (chunk) => {
      tarStderr = appendProcessOutput(tarStderr, chunk);
      unpackBuffer += chunk.toString("utf8");
      let newline;
      while ((newline = unpackBuffer.indexOf("\n")) >= 0) {
        const entry = unpackBuffer.slice(0, newline).replace(/\r$/, ""); unpackBuffer = unpackBuffer.slice(newline + 1);
        // Windows bsdtar reports only successfully extracted members with the x prefix.
        if (entry.startsWith("x ") && !unpacked.has(entry)) {
          unpacked.add(entry); controller.updateProgress({ phase: "unpacking", processedFiles: unpacked.size });
        }
      }
      if (unpackBuffer.length > 16384) unpackBuffer = unpackBuffer.slice(-16384);
    });
    tarProc.stdin.on("error", () => {});

    sshProc.stdout.on("data", (chunk) => {
      controller.transferredBytes += chunk.length;
      const now = Date.now();
      if (progress && now - lastProgressAt >= 250) {
        progress.report({ message: `已接收 ${(controller.transferredBytes / 1048576).toFixed(1)} MiB，正在解包` });
        lastProgressAt = now;
      }
    });
    sshProc.stdout.pipe(tarProc.stdin);
    sshProc.on("close", (code, signal) => {
      sshCode = code === null ? `signal ${signal || "unknown"}` : code;
      if (settled) { disposeAfterProcessesClose(); return; }
      finish();
    });
    tarProc.on("close", (code, signal) => {
      tarCode = code === null ? `signal ${signal || "unknown"}` : code;
      if (settled) { disposeAfterProcessesClose(); return; }
      finish();
    });
  });
}

function createRemoteTarCommand(sftp, downloadScope) {
  const remotePath = process.platform === "darwin" ? remotePathText(sftp.remotePath, "darwin") : String(sftp.remotePath).replace(/\/+$/, "");
  const scope = downloadScope && Array.isArray(downloadScope.paths) && downloadScope.paths.length
    ? normalizeDownloadScope(downloadScope)
    : null;
  if (scope) {
    return `python3 -c ${shellQuote(createRemoteDownloadScript(remotePath, scope))}`;
  }
  const args = [
    "tar",
    "-cf",
    "-",
    ...getTarExcludeArgs(sftp.ignore),
    ".",
  ];
  return `cd ${shellQuote(remotePath)} && ${args.map(shellQuote).join(" ")}`;
}

function createRemoteDownloadScript(remotePath, downloadScope) {
    if (process.platform === "darwin") remotePath = remotePathText(remotePath, "darwin");
    const scope = normalizeDownloadScope(downloadScope);
    const payload = Buffer.from(JSON.stringify(scope), "utf8").toString("base64");
    return [
      "import base64,json,os,sys,tarfile",
      `root=os.path.realpath(${JSON.stringify(remotePath)})`,
      `scope=json.loads(base64.b64decode(${JSON.stringify(payload)}).decode('utf-8'))`,
      "paths=scope.get('paths') or []",
      "extensions=[str(v).lower() for v in (scope.get('extensions') or ['*'])]",
      "allow_any='*' in extensions",
      "max_bytes=None if scope.get('noSizeLimit') else int(float(scope.get('maxFileSizeMB') or 1024)*1024*1024)",
      "blocked={'.git','.vscode','.codex','zlk_cluster'}",
      "def blocked_path(rel):",
      "    parts=rel.replace('\\\\','/').lower().split('/')",
      "    if any(p in blocked for p in parts): return True",
      "    if parts[0]!='simple_cluster': return False",
      "    if len(parts)==1: return False",
      "    if len(parts)>1 and parts[1] in ('results','debug_runs'): return False",
      "    if len(parts)==2 and parts[1]=='tmp': return False",
      "    if len(parts)>2 and parts[1]=='tmp' and parts[2]=='tmux_logs': return False",
      "    if len(parts)>2 and parts[1]=='tmp' and parts[2]=='cluster_scheduler': return len(parts)>3 and parts[3]!='logs' and not parts[-1].endswith('.log')",
      "    return True",
      "selected=[]",
      "seen=set()",
      "def safe_relative(rel,allow_root=False):",
      "    if not isinstance(rel,str) or not rel or len(rel.encode('utf-8')) > 4096 or any(ord(c)<32 or ord(c)==127 or c in (':',chr(92)) for c in rel): return False",
      "    return (allow_root and rel=='.') or all(p and p not in ('.','..') for p in rel.split('/'))",
      "def inside(value):",
      "    try: return os.path.commonpath([root, value]) == root",
      "    except ValueError: return False",
      "def allowed(rel, full):",
      "    if not safe_relative(rel) or rel in seen or os.path.islink(full) or not os.path.isfile(full): return False",
      "    if blocked_path(rel): return False",
      "    if max_bytes is not None and os.path.getsize(full) > max_bytes: return False",
      "    lower=rel.lower()",
      "    return allow_any or any(lower.endswith(ext) for ext in extensions)",
      "for rel_root in paths:",
      "    if not safe_relative(rel_root,True): raise SystemExit('unsafe download scope')",
      "    target=os.path.join(root, rel_root)",
      "    cursor=root",
      "    for part in rel_root.split('/'):",
      "        cursor=os.path.join(cursor,part)",
      "        if os.path.islink(cursor): raise SystemExit('download scope contains symlink')",
      "    if not inside(os.path.realpath(target)): raise SystemExit('download scope escapes root')",
      "    if os.path.isfile(target):",
      "        rel=os.path.relpath(target,root).replace(os.sep,'/')",
      "        if allowed(rel,target): seen.add(rel); selected.append((rel,target))",
      "        continue",
      "    if not os.path.isdir(target): continue",
      "    for current,dirs,files in os.walk(target,followlinks=False):",
      "        dirs[:]=[d for d in dirs if not os.path.islink(os.path.join(current,d)) and not blocked_path(os.path.relpath(os.path.join(current,d),root).replace(os.sep,'/'))]",
      "        for name in files:",
      "            full=os.path.join(current,name)",
      "            rel=os.path.relpath(full,root).replace(os.sep,'/')",
      "            if allowed(rel,full): seen.add(rel); selected.append((rel,full))",
      "with tarfile.open(fileobj=sys.stdout.buffer,mode='w|') as archive:",
      "    for rel,full in sorted(selected): archive.add(full,arcname=rel,recursive=False)",
    ].join("\n");
}

function getTarExcludeArgs(ignorePatterns) {
  const excludes = new Set();
  for (const pattern of Array.isArray(ignorePatterns) ? ignorePatterns : []) {
    addTarExcludePattern(excludes, pattern);
  }
  addTarExcludePattern(excludes, ".vscode");
  addTarExcludePattern(excludes, DEFAULT_HANDOFF_MARKER);
  return Array.from(excludes).map((pattern) => `--exclude=${pattern}`);
}

function addTarExcludePattern(excludes, pattern) {
  const normalized = String(pattern || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized === ".") return;

  excludes.add(normalized);
  if (!normalized.startsWith("./")) {
    excludes.add(`./${normalized}`);
  }
  if (!normalized.includes("/") && !normalized.includes("*")) {
    excludes.add(`*/${normalized}`);
  }
}

function appendProcessOutput(existing, chunk) {
  return `${existing}${chunk.toString("utf8")}`.slice(-4000);
}

function toPosixPath(value) {
  return String(value).replace(/\\/g, "/");
}

function toTarPath(value) {
  const normalized = toPosixPath(value).replace(/^\/+/, "");
  return normalized.startsWith("-") ? `./${normalized}` : normalized;
}

function formatProcessFailure({ operation, sshCode, tarCode, sshStderr, tarStderr }) {
  const sshText = String(sshStderr || "").trim();
  const tarText = String(tarStderr || "").trim();
  const details = [
    `ssh 退出码：${sshCode}`,
    tarCode === undefined ? "" : `tar 退出码：${tarCode}`,
    sshText ? `ssh: ${sshText}` : "",
    tarText ? `tar: ${tarText}` : "",
  ].filter(Boolean);
  return `${operation || "SFTP 传输"}失败。${details.join(" | ")}`;
}

function classifySftpFailure(error, sftp, context = {}) {
  const classified = classifyTransportFailure(error, context);
  const host = String(sftp && sftp.host || "").trim();
  const port = normalizeSshPort(sftp && sftp.port, 22);
  if (classified.category !== "user_cancelled") {
    classified.message = `SimpleSFTP 到 ${host || "未知主机"}:${port} 的传输失败：${classified.message} ${classified.diagnosis}`;
  }
  classified.apiData = {
    category: classified.category,
    retryable: classified.retryable,
    diagnosis: classified.diagnosis,
    host,
    port,
    remotePath: String(sftp && sftp.remotePath || ""),
    sshStderr: classified.details.sshStderr,
  };
  return classified;
}

function classifyTransportFailure(error, context = {}) {
  const source = error instanceof Error ? error : new Error(String(error || "传输失败"));
  const combined = [
    source.message,
    source.stderr || "",
    String(context.sshStderr || ""),
    String(context.tarStderr || ""),
  ].join("\n").toLowerCase();
  const classified = new Error(source.message || "SimpleSFTP 传输失败。");
  classified.cause = source;
  classified.details = {
    sshExitCode: context.sshCode,
    tarExitCode: context.tarCode,
    sshStderr: String(context.sshStderr || "").slice(-4000),
    tarStderr: String(context.tarStderr || "").slice(-4000),
  };
  if (source.name === "Cancel" || /传输已取消|用户通过 api 取消/.test(combined)) {
    classified.category = "user_cancelled";
    classified.retryable = false;
    classified.diagnosis = "用户或调用方取消了传输。";
    return classified;
  }
  if (/connection timed out|no route to host|network is unreachable/.test(combined)) {
    classified.category = "dns_tcp_unreachable";
    classified.retryable = true;
    classified.diagnosis = "SSH 地址或端口不可达；核对服务器配置、网络和防火墙。";
    return classified;
  }
  if (/传输超过|simple-sftp timeout|timeout|timed out/.test(combined)) {
    classified.category = "transfer_timeout";
    classified.retryable = true;
    classified.diagnosis = "传输超时；先核对 SSH IP、端口和网络，再检查目标负载或增大超时。";
    return classified;
  }
  if (/permission denied \(publickey|authentication failed|host key verification failed|invalid format\)/.test(combined)) {
    classified.category = "ssh_auth_failed";
    classified.retryable = false;
    classified.diagnosis = "SSH 认证、密钥或 host key 验证失败；先用同一 alias 手动连接验证。";
    return classified;
  }
  if (/local forward|forwarding failed|channel .* not opened/.test(combined)) {
    classified.category = "local_forward_unavailable";
    classified.retryable = true;
    classified.diagnosis = "本机转发端口未建立或目标 Agent/SSH 服务不可达。";
    return classified;
  }
  if (/enotfound|no such host|name or service not known|temporary failure in name resolution|econnrefused|connection refused/.test(combined)) {
    classified.category = "dns_tcp_unreachable";
    classified.retryable = true;
    classified.diagnosis = "DNS 或 TCP 链路不可达；核对网络、防火墙和服务器地址。";
    return classified;
  }
  if (/subsystem request failed|unknown subsystem/.test(combined)) {
    classified.category = "sftp_subsystem_unavailable";
    classified.retryable = false;
    classified.diagnosis = "远端 SSH 子系统不可用；确认服务器允许当前账号使用所需子系统。";
    return classified;
  }
  if (/mkdir |permission denied|read-only file system|disk quota exceeded|no space left on device/.test(combined)) {
    classified.category = "remote_permission_denied";
    classified.retryable = false;
    classified.diagnosis = "远端目录权限、只读文件系统或磁盘配额导致写入失败。";
    return classified;
  }
  if (/remote root|outside .*root|路径越界|不安全的受管理代码路径/.test(combined)) {
    classified.category = "remote_root_validation_failed";
    classified.retryable = false;
    classified.diagnosis = "目标路径未通过远端根目录或托管路径安全校验。";
    return classified;
  }
  classified.category = "transport_failed";
  classified.retryable = true;
  classified.diagnosis = "传输失败；请查看 SSH/tar 的退出码和错误输出。";
  return classified;
}

function getSshTarget(sftp) {
  const host = String(sftp.host || "").trim();
  const username = String(sftp.username || "").trim();
  if (!host) throw new Error("缺少 SFTP host。");
  if (!username || host.includes("@")) return host;
  return `${username}@${host}`;
}

function getSshArgs(sftp, command) {
  const args = macAuthentication ? sshAuthArgs(macAuthentication.config(sftp)) : [];
  const port = normalizeSshPort(sftp && sftp.port, 22);
  if (port !== 22) {
    args.push("-p", String(port));
  }
  const rawConnectTimeout = Number((sftp && sftp.connectTimeoutSeconds) || defaultConnectTimeoutSeconds);
  const connectTimeout = Number.isFinite(rawConnectTimeout)
    ? Math.min(Math.max(0, Math.floor(rawConnectTimeout)), 3600)
    : defaultConnectTimeoutSeconds;
  if (connectTimeout > 0) {
    args.push("-o", `ConnectTimeout=${connectTimeout}`);
  }
  args.push(getSshTarget(sftp), command);
  return args;
}

function authenticatedSsh(sftp, command, options, launch, extra = []) {
  const args = getSshArgs(sftp, command);
  const auth = macAuthentication?.invocation(sftp);
  try {
    const child = launch("ssh", [...(auth ? [] : extra), ...args], auth ? { ...options, env: auth.env } : options);
    if (auth) { child.once("close", auth.release); child.once("error", auth.release); }
    return child;
  } catch (error) { auth?.release(); throw error; }
}
function spawnSsh(sftp, command, options, launch = spawn, extra = []) { return authenticatedSsh(sftp, command, options, launch, extra); }
function execSsh(sftp, command, options, callback) { return authenticatedSsh(sftp, command, options, (file, args, config) => execFile(file, args, config, callback)); }

function normalizeSshPort(value, fallback = 22) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function upsertAgentsFile({ execHost, localPath, remotePath, userName, port }) {
  const agentsPath = path.join(localPath, "AGENTS.md");
  const existing = fs.existsSync(agentsPath)
    ? fs.readFileSync(agentsPath, "utf8")
    : "# Agent Instructions\n";
  const block = createAgentsManagedBlock({ execHost, localPath, remotePath, userName, port });

  let next;
  if (existing.includes(AGENTS_BLOCK_START) && existing.includes(AGENTS_BLOCK_END)) {
    const pattern = new RegExp(
      `${escapeRegExp(AGENTS_BLOCK_START)}[\\s\\S]*?${escapeRegExp(AGENTS_BLOCK_END)}`,
      "m"
    );
    next = existing.replace(pattern, block.trimEnd());
  } else {
    next = `${existing.trimEnd()}\n\n${block}`;
  }

  fs.writeFileSync(agentsPath, `${next.trimEnd()}\n`, "utf8");
}

function createAgentsManagedBlock({ execHost, localPath, remotePath, userName, port }) {
  const sshCommand = createSshCommandTemplate({ execHost, remotePath, userName, port });
  return `${AGENTS_BLOCK_START}
## SimpleSFTP

此工作区在本地 VS Code 中编辑，并通过 SimpleSFTP 与远端 Linux 项目目录同步。

路径映射：

- 远端：${remotePath}
- 本地：${localPath}

工作流：

- 切换设备后开始编辑前，先运行 \`SimpleSFTP：远端同步到本地\`。
- 编辑时保存本地文件，SimpleSFTP 会上传自上次成功同步或上传后发生变化的文件。
- 关闭本设备前，运行 \`SimpleSFTP：上传并标记交接\`，选择 \`上传全部并标记\`。
- 命令、测试、训练、Git 操作和依赖服务器环境的脚本仍应在服务器上执行。

远端命令模板：

\`\`\`bash
${sshCommand}
\`\`\`

除非用户明确要求，不要直接在 Windows 本地运行项目测试或训练。
${AGENTS_BLOCK_END}
`;
}

function createSshCommandTemplate({ execHost, remotePath, userName, port }) {
  const sshPort = normalizeSshPort(port, 22);
  const target = userName ? `${userName}@${execHost}` : execHost;
  const portArgs = sshPort === 22 ? "" : ` -p ${sshPort}`;
  return `ssh${portArgs} ${target} 'cd ${remotePath} && <command>'`;
}

function addGitInfoExclude(localPath, entry) {
  const excludePath = path.join(localPath, ".git", "info", "exclude");
  if (!fs.existsSync(path.dirname(excludePath))) return;

  const existing = fs.existsSync(excludePath)
    ? fs.readFileSync(excludePath, "utf8")
    : "";
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(entry)) return;

  const prefix = existing.trimEnd();
  const next = `${prefix}${prefix ? "\n" : ""}${entry}\n`;
  fs.writeFileSync(excludePath, next, "utf8");
}

function getDeviceName() {
  return os.hostname();
}

function formatTime(value) {
  if (!value) return "未知时间";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function deactivate() {
  extensionDeactivating = true;
  for (const controller of [...activeTransfers.values()]) controller.cancel("插件停用");
  for (const resources of activeTransferResources.values()) for (const resource of resources) {
    try { resource.kill?.(); resource.destroy?.(); } catch { /* Keep unconfirmed receipts. */ }
  }
  const boundedWait = async promise => {
    let timer;
    try { await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]); }
    finally { clearTimeout(timer); }
  };
  await boundedWait(Promise.all([...activeTransferResources.keys()].map(waitLocalTransferResources)));
  await boundedWait(persistTransferOperationLedger());
  if (macAuthentication) { await macAuthentication.dispose(); macAuthentication = undefined; }
  if (localApiServer) {
    await localApiServer.dispose().catch(() => undefined);
    localApiServer = undefined;
  }
}

function waitLocalTransferResources(operationId) {
  const resources = [...(activeTransferResources.get(operationId) || [])];
  return Promise.all(resources.map(resource => new Promise(resolve => {
    if (resource.closed || resource.destroyed && typeof resource.kill !== "function") { resolve(); return; }
    resource.once("close", resolve);
  })));
}

async function withTransferCapacity(options, work) {
  if (!transferContext.getStore()) require("./mac-update-gate").assertBusinessAllowed();
  const parent = transferContext.getStore();
  const abort = new AbortController();
  const cancel = reason => abort.abort(new Error(reason || "传输已取消"));
  const cancelSubscription = parent?.onCancel(cancel);
  if (parent?.status === "cancelled" || options.token?.isCancellationRequested) cancel("传输已取消");
  const tokenSubscription = options.token?.onCancellationRequested?.(() => cancel("传输已取消"));
  const readSignal = currentApiRequestContext()?.readOnly ? currentApiRequestContext().signal : undefined;
  const cancelRead = () => abort.abort(readSignal.reason);
  readSignal?.addEventListener("abort", cancelRead, { once: true });
  if (readSignal?.aborted) cancelRead();
  const keys = [options.source, options.destination, options.server, options.sftp, options.target, options].filter(item => item?.host).map(item => String(item.host).toLowerCase() + ":" + normalizeSshPort(item.port, 22));
  parent?.pause();
  try {
    return await transferCapacity.run(keys, abort.signal, async () => {
      parent?.resume();
      try { return await work(); }
      finally { if (parent?.operationId) await waitLocalTransferResources(parent.operationId); }
    });
  } finally { parent?.resume(); cancelSubscription?.dispose?.(); tokenSubscription?.dispose?.(); readSignal?.removeEventListener("abort", cancelRead); }
}

module.exports = {
  waitForUpdateIdle: async () => {
    while (activeTransfers.size || activeTransferResources.size || activeUploadOperations.size || uploadQueues.size) await new Promise(resolve => setTimeout(resolve, 250));
  },
  activate,
  deactivate,
  __test: {
    spawnSsh,
    getSshArgs,
    setMacAuthentication: value => { macAuthentication = value; },
    addTarExcludePattern,
    apiTransferSftp,
    createListRemoteDirsSshArgs,
    createRemoteExtractCommand,
    createRemoteTarCommand,
    createRemoteDownloadScript,
    createMappedDownloadCommand,
    createMappedDownloadScript,
    normalizeMappedDownloadEntries,
    assertMappedLocalDestinations,
    downloadMappedPathsCore,
    setMappedDownloadTransport,
    extractMappedTarStream,
    openMappedDownloadStream,
    directSyncTarget,
    directSyncRelativePath,
    directSyncCommand,
    guardedRemoteDeleteCommand,
    removeLocalStagingDirectory,
    batchDestinationGuardCommand,
    directTarBatchCommand,
    tarPackingCommand,
    tarUnpackingCommand,
    stagedTarUnpackingCommand,
    transferCompression,
    negotiateTransferCompression,
    selectTransferCompression,
    setCompressionProbeTransport,
    compressionHistory,
    partitionTransferPaths,
    transferPartitionedTar,
    transferPartitionedTarCore,
    relayTarFilesCore,
    transferChunkedServerFile,
    transferErrorLog,
    syncServerToServerFpsyncCore,
    syncServerToServerFpsync,
    setRemoteBatchTransport,
    batchFileHashScript,
    scopeInventoryScript,
    remoteBatchStage,
    fpsyncProgressTitle,
    planLogPathsFromState,
    projectInventoryScript,
    projectTreePathAllowed,
    normalizeDownloadScope,
    normalizeDownloadScopePath,
    relativeRemoteScopePath,
    readTargetDownloadScope,
    writeTargetDownloadScope,
    createAgentsManagedBlock,
    createSshCommandTemplate,
    createWorkspaceTargetName,
    createTransferPreview,
    createTransferController,
    createLocalApiMethods,
    setTransferSettlementTestContext(options = {}) {
      transferRecoveryTestHooks = options.recoveryHooks || null;
      transferRecoveries.clear();
      extensionContext = { globalState: options.globalState };
      localApiServer = { instanceId: () => String(options.instanceId || "test-instance") };
      if (options.reset !== false) {
        transferLedgerLoaded = false;
        transferLedgerWrite = Promise.resolve();
        transferOperationLedger.clear();
        activeTransferResources.clear();
        activeTransfers.clear();
        activeUploadOperations.clear();
      }
    },
    beginTransferOperation,
    finishTransferOperation,
    trackTransferResource,
    listTransferOperationState,
    atomicWriteJsonIfMissing,
    migrateLegacyCodeSyncState,
    createManifestUploadPlan,
    createWorkspaceUploadPlan,
    hashUploadPlanChunks,
    classifyTransportFailure,
    isRememberedTransferPath,
    listActiveTransfers,
    refreshConnectTimeoutFromConfig,
    resolveCreateProjectTarget,
    updateWorkspaceTargetCore,
    getSshArgs,
    getSshTarget,
    getManifestUploadRelativePaths,
    getMissingManagedFiles,
    formatSftpTargetSummary,
    getTarExcludeArgs,
    isIgnoredLocalPath,
    isSafeRemoteManagedPath,
    mergeIgnorePatterns,
    patternMatchesPath,
    resolveUploadSftp,
    sanitizeRelativeUploadPath,
    sharedServerCandidateKeys,
    simpleSftpConfigSchema,
    simpleSftpConfigSuffix,
    transferTimeoutMs,
    uploadProgressCancellable,
    validateSimpleSftpConfigValue,
    sanitizeServerProfile,
    toTarPath,
    writeWorkspace,
  },
};
