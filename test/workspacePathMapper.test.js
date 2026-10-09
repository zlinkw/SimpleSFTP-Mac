const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { resolveWorkspaceLocation: resolveNativeWorkspaceLocation } = require("../workspace-path.js");

function resolveWorkspaceLocation(uri, config = {}) { return resolveNativeWorkspaceLocation(uri, { platform: "win32", ...config }); }

const mapping = {
  hostRoot: "D:\\GitRepo\\",
  containerRoot: "/workspaces/",
};

test("SimpleSFTP declares a Windows UI host and optional mapping settings", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  assert.deepEqual(packageJson.extensionKind, ["ui"]);
  assert.ok(packageJson.files.includes("workspace-path.js"));
  assert.equal(packageJson.contributes.configuration.properties["simpleSftpMac.workspaceHostRoot"].default, "");
  assert.equal(packageJson.contributes.configuration.properties["simpleSftpMac.workspaceContainerRoot"].default, "");
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
  assert.throws(() => resolveWorkspaceLocation(uri, {}), /simpleSftpMac\.workspaceHostRoot/);
  assert.throws(() => resolveWorkspaceLocation(uri, { hostRoot: "D:\\GitRepo" }), /simpleSftpMac\.workspaceContainerRoot/);
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

test('Mac file workspaces preserve Chinese, spaces, case and literal percent paths', () => {
  for (const p of ['/Users/test/研究 项目/Model','/Users/test/研究 项目/model','/Users/test/100%20 literal/尾部 ']) {
    const result=resolveWorkspaceLocation({scheme:'file',path:p,fsPath:p}, {platform:'darwin'});
    assert.equal(result.hostPath,p);
    assert.equal(result.remote,false);
  }
  for (const p of ['C:/work','//host/work','/Users/test/../escape','relative','/Users/test/\\bad','/Users/test/\0bad']) {
    assert.throws(()=>resolveWorkspaceLocation({scheme:'file',path:p,fsPath:p},{platform:'darwin'}),/POSIX/);
  }
  assert.throws(()=>resolveWorkspaceLocation({scheme:'vscode-remote',path:'/workspaces/demo',fsPath:'/workspaces/demo'},{platform:'darwin'}),/Dev Containers/);
});
