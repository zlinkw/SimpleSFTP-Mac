const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../extension.js"), "utf8");

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

function sandbox() {
  const profile = {
    id: "nwpu3",
    label: "NWPU3",
    host: "NWPU3",
    user: "qgking",
    port: 22,
    remotePath: "/data/qgking/zlk/MultiModal",
  };
  const context = {
    DEFAULT_IGNORES: [],
    FIXED_IGNORES: [".git", ".vscode"],
    readSharedServers: () => ({ servers: [profile] }),
    getActiveSharedServer: () => profile,
    readSftpConfig: () => ({ host: "NWPU3", username: "qgking", port: 22, remotePath: profile.remotePath }),
    mergeIgnorePatterns: (...groups) => [...new Set(groups.flatMap((group) => Array.isArray(group) ? group : []))],
    normalizeSshPort: (value, fallback) => Number(value) || fallback,
    resolvedConnectTimeoutSeconds: () => 15,
  };
  vm.createContext(context);
  vm.runInContext([
    "sharedServerCandidateKeys", "sharedServerForOptions", "firstNonEmpty",
    "requestedRemotePath", "resolveUploadSftp", "apiTransferSftp",
    "assertTransferTargetUnchanged",
  ].map(extractFunction).join("\n"), context);
  return context;
}

test("explicit upload path overrides a saved server root in preview and execution", () => {
  const code = sandbox();
  const params = {
    localPath: "C:\\runtime",
    server: { id: "nwpu3", host: "NWPU3", user: "qgking", port: 22 },
    remotePath: "/data/qgking/zlk/simple_agent",
  };
  const preview = code.apiTransferSftp(params);
  const upload = code.resolveUploadSftp(params.localPath, params);
  assert.equal(preview.remotePath, params.remotePath);
  assert.equal(upload.remotePath, params.remotePath);
  assert.doesNotThrow(() => code.assertTransferTargetUnchanged(preview, upload));
  const customHost = { ...params, server: { ...params.server, host: "custom-host" } };
  assert.equal(code.apiTransferSftp(customHost).host, "custom-host");
  assert.equal(code.resolveUploadSftp(params.localPath, customHost).host, "custom-host");
});

test("string server name resolves exactly and unknown names fail closed", () => {
  const code = sandbox();
  const params = { server: "NWPU3", remotePath: "/data/qgking/zlk/simple_agent" };
  assert.equal(code.resolveUploadSftp("C:\\runtime", params).remotePath, params.remotePath);
  assert.equal(code.apiTransferSftp(params).host, "NWPU3");
  assert.throws(() => code.resolveUploadSftp("C:\\runtime", { ...params, server: "missing" }), /未找到指定的 SFTP 服务器/);
});

test("conflicting explicit paths and target drift block upload", () => {
  const code = sandbox();
  const params = {
    remotePath: "/data/qgking/zlk/simple_agent",
    server: { id: "nwpu3", remotePath: "/data/qgking/zlk/MultiModal" },
  };
  assert.throws(() => code.apiTransferSftp(params), /远端目标冲突/);
  assert.throws(() => code.resolveUploadSftp("C:\\runtime", params), /远端目标冲突/);
  const target = code.resolveUploadSftp("C:\\runtime", { server: "NWPU3" });
  assert.throws(() => code.assertTransferTargetUnchanged(target, { ...target, remotePath: "/data/qgking/zlk/simple_agent" }), /目标在确认后发生变化/);
});

test("API previews and upload cores use identical resolved targets", () => {
  assert.match(source, /"upload\.workspace": async[\s\S]*?const sftp = resolveUploadSftp\(localPath, params\)/);
  assert.match(source, /"upload\.files": async[\s\S]*?const sftp = resolveUploadSftp\(localBase, params\)/);
  assert.match(source, /if \(options\.expectedTransferTarget\) assertTransferTargetUnchanged\(options\.expectedTransferTarget, sftp\)/);
});

test("upload target uses only built-in exclusions", () => {
  const code = sandbox();
  code.DEFAULT_IGNORES = ["data", "*.npy"];
  const target = code.resolveUploadSftp("C:\\runtime", {
    server: { id: "nwpu3", ignore: ["user-server-ignore"] },
    ignore: ["user-request-ignore"],
  });
  assert.deepEqual(Array.from(target.ignore).sort(), ["*.npy", ".git", ".vscode", "data"]);
});

test("legacy ignore configuration surface is removed", () => {
  assert.doesNotMatch(source, /configureIgnores|ignores\.configure|TARGET_IGNORE_STATE|IGNORE_PRESETS/);
  assert.doesNotMatch(source, /readTargetIgnorePatterns|writeTargetIgnorePatterns|getRemoteIgnoreCandidates/);
});
