"use strict";
const fs = require("node:fs"), path = require("node:path");
const { randomUUID } = require("node:crypto");
const { macComponentDirectory } = require("./mac-paths");
const CLI_COMMAND = "simpleSftpMac.showCliEntry";
const MARKER = "# simple-local.simple-sftp-mac managed CLI v1";
function valid(version) {
  return typeof version === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    && version.split(".").every(part => Number.isSafeInteger(Number(part)));
}
function compare(a, b) {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  return 0;
}
function shellQuote(value) {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error("CLI 路径包含无效字符。");
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
function launcherText(entry, version = "0.0.0") {
  if (!path.isAbsolute(entry)) throw new Error("CLI 入口必须是绝对路径。");
  if (!valid(version)) throw new Error("CLI 扩展版本无效。");
  return ["#!/bin/sh", MARKER, `# extension-version: ${version}`,
    "if ! command -v node >/dev/null 2>&1; then",
    "  printf '%s\\n' 'SimpleSFTP Mac CLI requires Node.js 20+ in PATH.' >&2",
    "  exit 127", "fi",
    "if ! node -e 'if (parseInt(process.versions.node, 10) < 20) process.exit(1)' >/dev/null 2>&1; then",
    "  printf '%s\\n' 'SimpleSFTP Mac CLI requires Node.js 20+.' >&2",
    "  exit 126", "fi", `exec node ${shellQuote(entry)} "$@"`, ""].join("\n");
}
function writeMacCliLauncher(extensionPath, directory = macComponentDirectory("SimpleSFTPMac")) {
  const extensionRoot = fs.realpathSync(extensionPath);
  const pkg = JSON.parse(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8"));
  if (pkg.publisher !== "simple-local" || pkg.name !== "simple-sftp-mac") throw new Error("CLI 包身份不匹配。");
  const entry = path.join(extensionRoot, "bin", "simple-sftp-api.js"), entryInfo = fs.lstatSync(entry);
  if (!entryInfo.isFile() || entryInfo.isSymbolicLink() || fs.realpathSync(entry) !== entry) throw new Error("CLI 包入口不是可信普通文件。");
  const text = launcherText(entry, pkg.version);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error("CLI 组件目录不能是链接。");
  const componentRoot = fs.realpathSync(directory), cliDirectory = path.join(componentRoot, "cli");
  fs.mkdirSync(cliDirectory, { mode: 0o700, recursive: true });
  if (fs.lstatSync(cliDirectory).isSymbolicLink() || fs.realpathSync(cliDirectory) !== cliDirectory) throw new Error("CLI 目录不能是链接。");
  const roots = [componentRoot, cliDirectory].map(name => ({ name, info: fs.lstatSync(name) }));
  const verifyDirectories = () => {
    for (const { name, info } of roots) {
      const now = fs.lstatSync(name);
      if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== info.dev || now.ino !== info.ino || fs.realpathSync(name) !== name
        || (typeof process.getuid === "function" && now.uid !== process.getuid())) throw new Error("CLI 目录身份发生变化。");
    }
  };
  const target = path.join(cliDirectory, "simple-sftp-mac-api");
  const verifyTarget = () => {
    verifyDirectories();
    try {
      const info = fs.lstatSync(target);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16384) throw new Error("CLI 路径存在未知文件，已拒绝覆盖。");
      const previous = fs.readFileSync(target, "utf8"), version = previous.split("\n")[2]?.replace(/^# extension-version: /, "");
      if (!previous.startsWith("#!/bin/sh\n" + MARKER + "\n") || !valid(version)) throw new Error("CLI 路径存在未知文件，已拒绝覆盖。");
      return { text: previous, version };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  };
  const previous = verifyTarget();
  if (previous && (compare(previous.version, pkg.version) > 0 || previous.text === text)) return target;
  const slot = path.join(cliDirectory, "simple-sftp-mac-api.writing-" + randomUUID());
  const fd = fs.openSync(slot, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o700);
  try { fs.writeFileSync(fd, text, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const current = verifyTarget();
  if (current && compare(current.version, pkg.version) > 0) return target;
  fs.renameSync(slot, target); fs.chmodSync(target, 0o700);
  return target;
}
function registerMacCli(context, vscode) {
  const refresh = () => writeMacCliLauncher(context.extensionPath || context.extensionUri?.fsPath);
  context.subscriptions.push(vscode.commands.registerCommand(CLI_COMMAND, async () => {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("CLI 入口仅支持 Apple Silicon Mac。");
    const target = refresh(), command = shellQuote(target) + " self-check";
    const choice = await vscode.window.showInformationMessage(`CLI 入口：${target}。终端需要 Node.js 20+；每次扩展激活会刷新入口，保留当前工作目录，不自动修改 PATH。`, "复制自检命令");
    if (choice === "复制自检命令") await vscode.env.clipboard.writeText(command);
    return { path: target, command };
  }));
  return { refresh };
}
module.exports = { CLI_COMMAND, launcherText, shellQuote, writeMacCliLauncher, registerMacCli };
