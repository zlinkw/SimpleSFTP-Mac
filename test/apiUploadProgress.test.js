const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const runtimeRequire = require("node:module").createRequire(path.join(__dirname, "../extension.js"));

const source = fs.readFileSync(path.join(__dirname, "../extension.js"), "utf8");
const start = source.indexOf("function runUploadWithProgress(");
const end = source.indexOf("async function confirmTransferPath(", start);
assert.ok(start >= 0 && end > start);

function createRunner() {
  let progressCalls = 0;
  const sandbox = {
    require: runtimeRequire,
    vscode: {
      ProgressLocation: { Notification: 15 },
      window: {
        withProgress: (_options, operation) => {
          progressCalls += 1;
          return operation(undefined, { isCancellationRequested: false });
        },
      },
    },
    uploadProgressCancellable: () => true,
    createTransferController: () => ({ id: "test", status: "running", dispose() {} }),
    transferContext: new (require("node:async_hooks").AsyncLocalStorage)(),
    nextTransferId: () => "test",
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source.slice(start, end)}\nthis.run = runUploadWithProgress;`, sandbox);
  return { run: sandbox.run, get progressCalls() { return progressCalls; } };
}

test("API upload resolves without waiting for VS Code notification lifecycle", async () => {
  const runner = createRunner();
  const result = await runner.run({ apiMode: true }, "upload", async (token) => {
    assert.equal(token, undefined);
    return { ok: true };
  });
  assert.equal(result.ok, true);
  assert.equal(runner.progressCalls, 0);
});

test("interactive upload retains the cancellable progress notification", async () => {
  const runner = createRunner();
  const result = await runner.run({}, "upload", async (token) => {
    assert.equal(token.isCancellationRequested, false);
    return { ok: true };
  });
  assert.equal(result.ok, true);
  assert.equal(runner.progressCalls, 1);
});

test('disconnected read removes its capacity ticket without touching the active transfer', async () => {
  const { TransferCapacity } = require('../transfer-capacity');
  const pool = new TransferCapacity(), controller = new AbortController();
  let release, started = false;
  const active = pool.run(['worker:22'], undefined, () => new Promise(resolve => { release = resolve; }));
  const start = source.indexOf('async function withTransferCapacity('), end = source.indexOf('module.exports =', start);
  assert.ok(start >= 0 && end > start);
  const sandbox = { require: runtimeRequire, AbortController, Error, String, transferContext: { getStore: () => undefined },
    currentApiRequestContext: () => ({ readOnly: true, signal: controller.signal }),
    transferCapacity: pool, normalizeSshPort: (_port, fallback) => fallback, waitLocalTransferResources: async () => {} };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end) + '\nthis.capacity = withTransferCapacity;', sandbox);
  const queued = sandbox.capacity({ source: { host: 'worker' } }, () => { started = true; });
  assert.equal(pool.pending.length, 1);
  controller.abort(Error('reader disconnected'));
  await assert.rejects(queued, /reader disconnected/);
  assert.equal(started, false); assert.equal(pool.pending.length, 0); assert.equal(pool.active, 1);
  release(); await active; assert.equal(pool.active, 0);
});

test("SSH spawn errors settle uploads even if killing the child throws", async () => {
  const uploadStart = source.indexOf("function runLocalTarUpload(");
  const uploadEnd = source.indexOf("function createRemoteExtractCommand(", uploadStart);
  assert.ok(uploadStart >= 0 && uploadEnd > uploadStart);
  let disposed = false, child;
  const sandbox = {
    Date,
    Promise,
    clearTimeout,
    setTimeout,
    crypto: require("node:crypto"),
    createRemoteExtractCommand: () => "tar -xf -",
    hashUploadPlanChunks: () => ({ algorithm: "sha256", chunks: [] }),
    tarEntryPath: (value) => value,
    remoteResourceServer: () => "worker:22",
    withFileResourceLease: (_operation, _project, _paths, _server, work) => work(),
    withTransferCapacity: (_options, work) => work(),
    createTransferController: () => ({ onCancel() {}, dispose() { disposed = true; } }),
    trackTransferResource: () => {},
    nextTransferId: () => "test-upload",
    getSshArgs: () => [],
    transferTimeoutMs: () => 200,
    classifyTransportFailure: (error) => error,
    appendProcessOutput: () => "",
    writeTarEntriesToStream: () => new Promise(() => {}),
    spawnSsh: () => {
      child = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdin.end = () => {};
      child.stderr = new EventEmitter();
      child.kill = () => { throw new Error("kill failed"); };
      queueMicrotask(() => child.emit("error", new Error("ssh unavailable")));
      return child;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source.slice(uploadStart, uploadEnd)}\nthis.upload = runLocalTarUpload;`, sandbox);
  await assert.rejects(sandbox.upload({
    localPath: "C:/project",
    sftp: { remotePath: "/project" },
    uploadPlan: { files: [], fileCount: 0, byteCount: 0 },
    operation: "test",
    timeoutMs: 200,
  }), /ssh unavailable/);
  assert.equal(disposed, false);
  child.emit("close", null, "SIGTERM");
  assert.equal(disposed, true);
});
