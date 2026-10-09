const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { resolveWorkspaceLocation } = require("../workspace-path.js");

const mapping = {
  hostRoot: "D:\\GitRepo\\",
  containerRoot: "/workspaces/",
};

test("SimpleSFTP declares a Windows UI host and optional mapping settings", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  assert.deepEqual(packageJson.extensionKind, ["ui"]);
  assert.ok(packageJson.files.includes("workspace-path.js"));
  assert.equal(packageJson.contributes.configuration.properties["simpleSftp.workspaceHostRoot"].default, "");
  assert.equal(packageJson.contributes.configuration.properties["simpleSftp.workspaceContainerRoot"].default, "");
});

test("SimpleSFTP path mapping preserves Windows file workspaces", () => {
  const result = resolveWorkspaceLocation({
    scheme: "file",
    path: "/D:/GitRepo/demo",
    fsPath: "D:/GitRepo/demo/",
    external: "file:///D:/GitRepo/demo",
  });
  assert.deepEqual(result, {
    scheme: "file",
    editorUri: "file:///D:/GitRepo/demo",
    hostPath: "D:\\GitRepo\\demo\\",
    relativePath: "",
    remote: false,
  });
});

test("SimpleSFTP path mapping preserves remote URI and maps nested host paths", () => {
  const result = resolveWorkspaceLocation({
    scheme: "vscode-remote",
    path: "/workspaces/MCP/simple-sftp",
    fsPath: "/workspaces/MCP/simple-sftp",
    external: "vscode-remote://dev-container+abc/workspaces/MCP/simple-sftp",
  }, mapping);
  assert.equal(result.editorUri, "vscode-remote://dev-container+abc/workspaces/MCP/simple-sftp");
  assert.equal(result.hostPath, "D:\\GitRepo\\MCP\\simple-sftp");
  assert.equal(result.relativePath, "MCP/simple-sftp");
  assert.equal(result.remote, true);
});

test("SimpleSFTP path mapping requires both remote mapping settings", () => {
  const uri = { scheme: "vscode-remote", path: "/workspaces/demo", fsPath: "/workspaces/demo" };
  assert.throws(() => resolveWorkspaceLocation(uri, {}), /simpleSftp\.workspaceHostRoot/);
  assert.throws(() => resolveWorkspaceLocation(uri, { hostRoot: "D:\\GitRepo" }), /simpleSftp\.workspaceContainerRoot/);
  assert.throws(() => resolveWorkspaceLocation({ ...uri, scheme: "untitled" }, mapping), /不支持的工作区 URI scheme/);
});

test("SimpleSFTP path mapping rejects traversal and path injection", () => {
  const invalidPaths = [
    "/workspaces/../secret",
    "/workspaces/%2e%2e/secret",
    "/workspaces/%252e%252e/secret",
    "/workspaces%2f..%2fsecret",
    "/other/demo",
    "/workspaces/C:/temp",
    "//server/share",
    "/workspaces/demo\\evil",
    "/workspaces/demo\0evil",
    "/workspaces/demo%00evil",
    "/workspaces/demo%255cevil",
  ];
  for (const remotePath of invalidPaths) {
    assert.throws(() => resolveWorkspaceLocation({
      scheme: "vscode-remote",
      path: remotePath,
      fsPath: remotePath,
    }, mapping), undefined, remotePath);
  }
  assert.throws(() => resolveWorkspaceLocation({
    scheme: "vscode-remote",
    path: "/workspaces/demo",
    fsPath: "/workspaces/demo",
  }, { ...mapping, hostRoot: "\\\\server\\share" }), /Windows 盘符绝对路径/);
});
