const path = require("path");

function resolveWorkspaceLocation(uri, config = {}) {
  const scheme = String(uri && uri.scheme || "").trim().toLowerCase();
  const editorUri = String(uri && uri.external || `${scheme}:${String(uri && uri.path || "")}`);
  if (scheme === "file") {
    const hostPath = normalizeWindowsAbsolutePath(uri && uri.fsPath, "本地工作区路径");
    return { scheme, editorUri, hostPath, relativePath: "", remote: false };
  }

  const remoteScheme = String(config.remoteScheme || "vscode-remote").trim().toLowerCase();
  if (scheme !== remoteScheme) {
    throw new Error(`不支持的工作区 URI scheme：${scheme || "<empty>"}`);
  }
  if (!String(config.hostRoot || "").trim()) {
    throw new Error("远程工作区缺少配置 simpleSftp.workspaceHostRoot。");
  }
  if (!String(config.containerRoot || "").trim()) {
    throw new Error("远程工作区缺少配置 simpleSftp.workspaceContainerRoot。");
  }

  const hostRoot = normalizeWindowsAbsolutePath(config.hostRoot, "simpleSftp.workspaceHostRoot");
  const containerRoot = normalizeContainerRoot(config.containerRoot);
  const containerPath = normalizeContainerPath(uri && uri.path, "远程工作区路径");
  if (containerPath !== containerRoot && !containerPath.startsWith(`${containerRoot}/`)) {
    throw new Error(`远程工作区路径不在配置根 ${containerRoot} 内。`);
  }

  const relativePath = path.posix.relative(containerRoot, containerPath);
  if (isEscapingRelativePath(relativePath, path.posix)) {
    throw new Error(`远程工作区路径越界：${containerPath}`);
  }
  const segments = relativePath ? relativePath.split("/") : [];
  if (segments.some((segment) => segment.includes(":"))) {
    throw new Error("远程工作区路径不得包含 Windows 盘符或 alternate data stream。");
  }

  const hostPath = path.win32.resolve(hostRoot, ...segments);
  const hostRelative = path.win32.relative(hostRoot, hostPath);
  if (isEscapingRelativePath(hostRelative, path.win32)) {
    throw new Error(`映射后的 Windows 路径越界：${hostPath}`);
  }
  return { scheme, editorUri, hostPath, relativePath, remote: true };
}

function normalizeWindowsAbsolutePath(value, label) {
  const raw = String(value || "").trim();
  if (!/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
    throw new Error(`${label} 必须是 Windows 盘符绝对路径。`);
  }
  return path.win32.normalize(raw);
}

function normalizeContainerRoot(value) {
  const root = normalizeContainerPath(value, "simpleSftp.workspaceContainerRoot");
  return root === "/" ? root : root.replace(/\/+$/, "");
}

function normalizeContainerPath(value, label) {
  const raw = String(value || "").trim();
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    throw new Error(`${label} 必须是单根 POSIX 绝对路径。`);
  }
  if (raw.includes("\\") || raw.includes("\0")) {
    throw new Error(`${label} 包含禁止的反斜杠或 NUL。`);
  }
  if (/%(?:2f|5c)/i.test(raw)) {
    throw new Error(`${label} 不得使用编码后的路径分隔符。`);
  }
  const decoded = decodePathRepeatedly(raw, label);
  if (decoded.includes("\\") || decoded.includes("\0")) {
    throw new Error(`${label} 解码后包含禁止的反斜杠或 NUL。`);
  }
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label} 不得包含 . 或 .. 路径段。`);
  }
  const normalized = path.posix.normalize(decoded);
  if (!normalized.startsWith("/") || normalized.startsWith("//")) {
    throw new Error(`${label} 规范化后不是安全的 POSIX 绝对路径。`);
  }
  return normalized;
}

function decodePathRepeatedly(value, label) {
  let decoded = value;
  for (let index = 0; index < 4 && /%[0-9a-f]{2}/i.test(decoded); index += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      throw new Error(`${label} 包含无效的 URI 编码。`);
    }
  }
  if (/%[0-9a-f]{2}/i.test(decoded)) {
    throw new Error(`${label} 包含过度编码的路径。`);
  }
  return decoded;
}

function isEscapingRelativePath(value, api) {
  return value === ".." || value.startsWith(`..${api.sep}`) || api.isAbsolute(value);
}

module.exports = { resolveWorkspaceLocation };
