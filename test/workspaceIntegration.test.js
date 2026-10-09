const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../extension.js"), "utf8");
const { resolveWorkspaceLocation } = require("../workspace-path.js");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const headerEnd = source.indexOf(") {", start);
  assert.ok(headerEnd >= 0, `missing function body ${name}`);
  const body = headerEnd + 2;
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function remoteSandbox() {
  const remoteUri = {
    scheme: "vscode-remote",
    path: "/workspaces/MCP/demo",
    fsPath: "/workspaces/MCP/demo",
    toString: () => "vscode-remote://dev-container/workspaces/MCP/demo",
  };
  return {
    path,
    process: { platform: "win32" },
    resolveWorkspaceLocation,
    vscode: {
      workspace: {
        workspaceFolders: [{ uri: remoteUri }],
        getConfiguration: () => ({
          get: (key) => key === "workspaceHostRoot" ? "D:\\GitRepo" : "/workspaces",
        }),
      },
      Uri: {
        joinPath: (uri, ...parts) => ({ scheme: uri.scheme, path: [uri.path, ...parts].join("/") }),
        file: (value) => ({ scheme: "file", path: value }),
      },
    },
  };
}

test("remote workspace paths map to the Windows host while editor files keep remote URIs", () => {
  const sandbox = remoteSandbox();
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction("getPrimaryWorkspaceFolder"),
    extractFunction("workspaceMappingConfig"),
    extractFunction("workspaceLocationForFolder"),
    extractFunction("getWorkspaceRoot"),
    extractFunction("resolveLocalWorkspacePath"),
    extractFunction("workspaceEditorUriForRelative"),
    "this.api = { getWorkspaceRoot, resolveLocalWorkspacePath, workspaceEditorUriForRelative };",
  ].join("\n"), sandbox);

  assert.equal(sandbox.api.getWorkspaceRoot(), "D:\\GitRepo\\MCP\\demo");
  assert.equal(sandbox.api.resolveLocalWorkspacePath("/workspaces/MCP/demo/results", "上传工作区"), "D:\\GitRepo\\MCP\\demo\\results");
  const editorUri = sandbox.api.workspaceEditorUriForRelative(".vscode/sftp.json");
  assert.equal(editorUri.scheme, "vscode-remote");
  assert.equal(editorUri.path, "/workspaces/MCP/demo/.vscode/sftp.json");
});

test("all transfer entry points confirm expected host and remote paths before side effects", () => {
  const ordered = [
    ["createOrOpenProject", "confirmTransferPath", "writeWorkspace"],
    ["syncFromRemoteCore", "confirmTransferPath", "downloadRemoteToLocal"],
    ["markHandoffReadyCore", "confirmTransferPath", "writeRemoteHandoffMarker"],
    ["uploadWorkspaceCore", "confirmTransferPath", "readRemoteCodeManifest"],
    ["uploadFilesCore", "confirmTransferPath", "runUploadWithProgress"],
    ["uploadChangedLocalFilesCore", "confirmTransferPath", "findChangedLocalFiles"],
  ];
  for (const [name, gate, effect] of ordered) {
    const body = extractFunction(name);
    assert.ok(body.indexOf(gate) >= 0, `${name} missing path confirmation`);
    assert.ok(body.indexOf(gate) < body.indexOf(effect), `${name} confirms after ${effect}`);
  }
  assert.match(source, /\{ modal: true \}, "仅本次继续", "此后该路径不再提醒", "取消"/);
  assert.match(source, /本地宿主位置：\$\{preview\.localPath\}/);
  assert.match(source, /远端预期位置：\$\{preview\.remotePath\}/);
});

test("all host file side effects acquire the shared operation lease", () => {
  const leased = [
    "createOrOpenProject",
    "syncFromRemote",
    "markHandoffReady",
    "uploadWorkspace",
    "uploadFiles",
    "uploadChangedLocalFiles",
    "uploadAllLocalToRemote",
    "downloadRemoteToLocal",
  ];
  for (const name of leased) {
    assert.match(extractFunction(name), /withHostOperationLease\(/, `${name} missing host operation lease`);
  }
  assert.doesNotMatch(source, /configureIgnores|配置忽略规则/);
  assert.match(source, /pluginId: "simple-local\.simple-sftp"/);
  assert.match(source, /showErrorMessage\(error\.message, \{ modal: true \}, "知道了"\)/);
});

test("remote saves and workspace configuration use mapped host paths", () => {
  assert.doesNotMatch(source, /workspaceFolder\.uri\.fsPath|folder\.uri\.fsPath/);
  assert.match(source, /\["file", "vscode-remote"\]\.includes\(document\.uri\.scheme\)/);
  assert.match(source, /documentHostPath = workspaceHostPathForUri\(document\.uri\)/);
  assert.match(source, /vscode\.Uri\.joinPath\(folder\.uri, \.\.\.normalized\.split\("\/"\)\)/);
  assert.match(source, /process\.platform !== "win32"/);
});
