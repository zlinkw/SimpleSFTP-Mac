const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const paths = require("../workspace-path");
const root = path.resolve(__dirname, "..");
const localRequire = createRequire(path.join(root, "extension.js"));
const source = fs.readFileSync(path.join(root, "extension.js"), "utf8");

function fixture(listOutput = " 研究 A \0Model\0model\0") {
  const local = "/Users/test/ 实验 A ", remote = "/Data/研究 / 实验 A ";
  const writes = [], transfers = [], listings = [], changes = [], leases = [], listCommands = [];
  const settings = { localBase: "/Users/test/项目 ", remoteBase: "/Data/研究 ", sshHost: "worker", sshPort: 2222, userName: "research", writeAgentsFile: false };
  const files = new Map([[local + "/代码.py", "print('中文')"], [local + "/.vscode/sftp.json", JSON.stringify({ host: "worker", username: "research", port: 2222, remotePath: remote })]]);
  const mockFs = { ...fs, existsSync: p => files.has(p), lstatSync: () => ({ isFile: () => true }), statSync: p => ({ size: Buffer.byteLength(files.get(p) || ""), isFile: () => true }),
    mkdirSync() {}, writeFileSync(p, data, encoding) { assert.equal(encoding, "utf8"); files.set(p, data); writes.push({ path: p, data }); },
    readFileSync(p, encoding) { if (files.has(p)) return files.get(p); return fs.readFileSync(p, encoding); } };
  const module = { exports: {} }, config = { get: (key, fallback) => settings[key] ?? fallback, update: async (key, value) => changes.push({ key, value }) };
  const sandbox = { module, exports: module.exports, __dirname: root, __filename: path.join(root, "extension.js"), Buffer, console,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, AbortController, process: { ...process, platform: "darwin", arch: "arm64" },
    require(name) {
      if (name === "path") return { ...path.posix, win32: path.win32, posix: path.posix };
      if (name === "fs") return mockFs;
      if (name === "vscode") return { TreeItem: class {}, ConfigurationTarget: { Workspace: 2, Global: 1 }, workspace: { workspaceFolders: [], getConfiguration: () => config }, window: { showWarningMessage: async () => {}, showInformationMessage: async () => {}, showErrorMessage: async () => {} } };
      if (name === "./host-operation-lease.js") return { HostOperationLeaseConflictError: class extends Error {}, HostOperationLeaseManager: class { async run(spec, work) { leases.push(spec); return work(); } } };
      return localRequire(name);
    } };
  vm.createContext(sandbox);
  vm.runInContext(source + `
    publishLocalApiEvent = () => {};
    beginTransferOperation = async () => {};
    finishTransferOperation = async () => {};
    readSharedServers = () => ({ servers: [] });
    getActiveSharedServer = () => null;
    const actualListRemoteDirs = listRemoteDirs;
    execSsh = (sftp, command, _options, callback) => { listCommands.push(command); callback(null, listOutput, ''); return {}; };
    watchTransferProcess = () => ({ receive() {} });
    listRemoteDirs = async (sftp, remotePath) => { listings.push({ sftp, remotePath }); return actualListRemoteDirs(sftp, remotePath); };
    runLocalTarUpload = async value => { transfers.push({ ...value, command: createRemoteExtractCommand(value.sftp.remotePath) }); return { fileCount: value.uploadPlan.fileCount }; };
    migrateLegacyCodeSyncState = () => {};
    inspectRemoteManagedFiles = async (_sftp, manifest) => ({ mismatches: transfers.length ? [] : Object.keys(manifest) });
    pruneRemoteMissingManagedFiles = async (_sftp, missing) => { if (missing.length) throw Error('unexpected removal'); return { deleted: 0 }; };
    writeWorkspace = async value => { writes.push(value); };
    this.api = { createLocalApiMethods, resolveUploadSftp, apiTransferSftp, requestedRemotePath, resolveCreateProjectTarget,
      sanitizeServerProfile, resolveLocalWorkspacePath, resolveUploadFilePath, transferRequestKey, validateSimpleSftpConfigValue,
      directSyncTarget, transferPathConfirmationKey, enqueueWorkspaceUpload };
  `, Object.assign(sandbox, { writes, transfers, listings, listCommands, listOutput }));
  return { api: sandbox.api, methods: sandbox.api.createLocalApiMethods(), local, remote, writes, transfers, listings, changes, leases, settings, listCommands };
}

test("Mac absolute paths follow Experiment's rule without decoding or folding names", () => {
  const experiment = localRequire(path.resolve(root, "../SimpleExperiment-Mac/dist/mac/PosixPath.js"));
  const values = ["/Data/研究 / 实验 A ", "/Data/model", "/data/Model", "/tmp/literal%2f%20 ", "/Data/e\u0301", "/Data/é", "/Data//研究///", "/", "//host/share", "relative", "C:/work", "/Data/./x", "/Data/../x", "/Data/a\\b", "/Data/a\t", "/Data/a\0", "/Data/a\x7f", 42, null];
  for (const allowRoot of [false, true]) for (const value of values) {
    let expected;
    try { expected = experiment.normalizePosixAbsolutePath(value, "路径", allowRoot); }
    catch { assert.throws(() => paths.normalizeMacAbsolutePath(value, "路径", allowRoot)); continue; }
    assert.equal(paths.normalizeMacAbsolutePath(value, "路径", allowRoot), expected);
  }
  assert.equal(paths.localPathText("", "darwin"), "");
  assert.equal(paths.remotePathText(undefined, "darwin"), "");
});

test("profiles, settings and confirmation identities preserve Mac roots and reject malformed paths", () => {
  const f = fixture(), server = { host: "worker", username: "research", remotePath: f.remote, localBase: f.local };
  assert.equal(f.api.sanitizeServerProfile(server).remotePath, f.remote);
  assert.equal(f.api.sanitizeServerProfile(server).localBase, f.local);
  assert.equal(f.api.resolveCreateProjectTarget(server, { get: key => f.settings[key] }).localBase, f.local);
  assert.equal(f.api.validateSimpleSftpConfigValue("simpleSftpMac.remoteBase", f.remote), f.remote);
  assert.equal(f.api.validateSimpleSftpConfigValue("simpleSftpMac.localBase", f.local), f.local);
  for (const bad of ["relative", "/", "//data", "/Data/../x", "/Data/./x", "/Data/a\t", "/Data/a\\b"])
    assert.throws(() => f.api.sanitizeServerProfile({ ...server, remotePath: bad }));
  assert.equal(f.api.resolveLocalWorkspacePath(f.local), f.local);
  assert.equal(f.api.resolveUploadFilePath(f.local + "/代码.py"), f.local + "/代码.py");
  assert.notEqual(f.api.transferRequestKey("upload.workspace", { localPath: f.local, remotePath: f.remote }), f.api.transferRequestKey("upload.workspace", { localPath: f.local.trimEnd(), remotePath: f.remote }));
  assert.notEqual(f.api.transferPathConfirmationKey(f.local, server), f.api.transferPathConfirmationKey(f.local, { ...server, remotePath: f.remote.toLowerCase() }));
  assert.throws(() => f.api.requestedRemotePath({ remotePath: f.remote, server: { remotePath: f.remote.trimEnd() } }), /目标冲突/);
  assert.equal(f.api.directSyncTarget(server, "来源").remotePath, f.remote);
});

test("actual API preview and file/workspace upload target exactly the same spaced POSIX roots", async () => {
  for (const method of ["upload.files", "upload.workspace"]) {
    const f = fixture(), params = { localPath: f.local, remotePath: f.remote, server: { host: "worker", username: "research", port: 2222 },
      files: [f.local + "/代码.py"], manifest: method === "upload.workspace" ? { "代码.py": { size: 15, sha256: "a".repeat(64) } } : undefined,
      preComparedManifest: true, transientManifest: true, pruneManagedFiles: false, stateFileMode: "virtual" };
    await assert.rejects(f.methods[method](params), error => {
      assert.equal(error.apiCode, 2001); assert.equal(error.apiData.target.localPath, f.local); assert.equal(error.apiData.target.remotePath, f.remote); return true;
    });
    assert.equal(f.transfers.length, 0);
    const result = await f.methods[method]({ ...params, confirm: true, pathConfirmed: true });
    assert.equal(result.remotePath, f.remote); assert.equal(f.transfers.length, 1);
    assert.equal(f.transfers[0].localPath, f.local); assert.equal(f.transfers[0].sftp.remotePath, f.remote);
    assert.ok(f.transfers[0].command.includes("'" + f.remote + "'"));
    assert.equal(f.writes.length, 0);
    for (const bad of ["/", "/Data/../x", "relative", "//Data/x", "/Data/x\t"])
      await assert.rejects(f.methods[method]({ ...params, remotePath: bad, confirm: true, pathConfirmed: true }));
    assert.equal(f.transfers.length, 1);
  }
});

test("directory browsing may read root while project creation and target updates reject it", async () => {
  const f = fixture(), params = { localPath: f.local, remotePath: f.remote, host: "worker", username: "research", confirm: true, pathConfirmed: true };
  const listed = await f.methods["remote.listDirs"]({ ...params, remotePath: "/" });
  assert.deepEqual(Array.from(listed.dirs), [" 研究 A ", "Model", "model"]);
  assert.ok(f.listCommands[0].includes("-printf '%f\\0'"));
  assert.equal(f.listings[0].remotePath, "/");
  const result = await f.methods["target.update"]({ ...params, patch: { remotePath: f.remote } });
  assert.equal(result.remotePath, f.remote); assert.equal(result.localPath, f.local);
  assert.equal(f.writes[0].path, f.local + "/.vscode/sftp.json");
  assert.equal(JSON.parse(f.writes[0].data).remotePath, f.remote);
  await f.methods["project.create"](params);
  assert.equal(f.writes[1].localPath, f.local); assert.equal(f.writes[1].remotePath, f.remote);
  for (const method of ["project.create", "target.update"])
    await assert.rejects(f.methods[method]({ ...params, remotePath: "/", patch: { remotePath: "/" } }));
  assert.equal(f.writes.length, 2);
  for (const output of ["a\tbad\0", "a\nbad\0", "../other\0", "a\\bad\0"])
    await assert.rejects(fixture(output).methods["remote.listDirs"](params));
});

test("Mac save queues distinguish case and keep same-path saves sequential", async () => {
  const f = fixture(), entered = [], releases = [];
  const work = label => () => new Promise(resolve => { entered.push(label); releases.push(resolve); });
  f.api.enqueueWorkspaceUpload("/Users/test/Model ", work("upper"));
  f.api.enqueueWorkspaceUpload("/Users/test/model ", work("lower"));
  f.api.enqueueWorkspaceUpload("/Users/test/Model ", work("upper-again"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(entered, ["upper", "lower"]);
  releases[0](); releases[1]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(entered, ["upper", "lower", "upper-again"]);
  releases[2](); await new Promise(resolve => setImmediate(resolve));
});
