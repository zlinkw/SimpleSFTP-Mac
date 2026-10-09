const assert = require("node:assert/strict"), test = require("node:test"), Module = require("node:module");
const { spawnSync } = require("node:child_process");
const { clientRequestKey, assertLocalProcessesIdle, settlementProbeCommand } = require("../transfer-settlement");
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  return request === "vscode" ? { TreeItem: class {}, ProgressLocation: { Notification: 1 },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { withProgress: (_options, operation) => operation({ report() {} }), showErrorMessage() {} },
  } : originalLoad.call(this, request, ...args);
};
const { __test } = require("../extension");
Module._load = originalLoad;
const method = "sync.serverToServerFpsync";
const params = { source: { id: "source", host: "source-host", username: "tester", port: 2222, remotePath: "/projects/example" },
  destination: { id: "destination", host: "dest-host", username: "tester", port: 2223, remotePath: "/projects/example" } };
const key = clientRequestKey(method, params), ledgerKey = "simple-sftp-transfer-settlement.v1";

function downloadFixture(options = {}) {
  const downloadMethod = options.method || "sync.downloadMappedPaths";
  const retryParams = { localPath: "C:/projects/example", server: { id: "source", host: "source-host", username: "tester", port: 2222, remotePath: "/projects/example" } };
  const requestKey = clientRequestKey(downloadMethod, retryParams), order = [];
  const values = new Map([[ledgerKey, [{ operationId: "old-download", operationInstanceId: "123:old", status: "outcomeUnknown",
    startedAt: new Date().toISOString(), remoteMutation: options.remoteMutation === true, requestKey }]]]);
  const globalState = { get: (name, fallback) => values.get(name) || fallback,
    async update(name, value) { if (options.failPersistence) throw Error("disk locked"); values.set(name, structuredClone(value)); } };
  __test.setTransferSettlementTestContext({ globalState, instanceId: "456:new", recoveryHooks: {
    async localProof() { order.push("local"); if (options.localBusy) throw Error("LOCAL_TRANSFER_OR_OWNER_STILL_ACTIVE"); },
    async acquire() { throw Error("read-only recovery must not lock remote writers"); },
  } });
  __test.setRemoteBatchTransport(() => { throw Error("read-only recovery must not run remote writer probes"); });
  const reconcile = (overrides = {}) => __test.createLocalApiMethods()["transfers.reconcile"]({ operationId: "old-download", operationInstanceId: "123:old",
    requestKey, retryMethod: downloadMethod, retryParams, ...overrides });
  return { values, order, requestKey, retryParams, reconcile };
}

test("legacy read-only download is settled only after local exit proof and permits a fresh request", async () => {
  const f = downloadFixture();
  await assert.rejects(__test.beginTransferOperation("too-early", "456:new", false, f.requestKey), /未确认的旧请求/);
  assert.equal((await f.reconcile()).settled, true);
  assert.deepEqual(f.order, ["local", "local"]);
  assert.equal(f.values.get(ledgerKey)[0].recovery.kind, "verified-read-transfer-exit");
  await __test.beginTransferOperation("fresh-read", "456:new", false, f.requestKey);
  await __test.finishTransferOperation("fresh-read");
});

for (const method of ["sync.projectInventory", "sync.projectTree", "sync.projectFileStats"]) {
  test(`legacy ${method} inspection recovers after proven local exit without a remote writer probe`, async () => {
    const f = downloadFixture({ method });
    assert.equal((await f.reconcile()).settled, true);
    assert.deepEqual(f.order, ["local", "local"]);
    await __test.beginTransferOperation("fresh-inspection", "456:new", false, f.requestKey);
    await __test.finishTransferOperation("fresh-inspection");
    const busy = downloadFixture({ method, localBusy: true });
    assert.equal((await busy.reconcile()).settled, false);
    const writer = downloadFixture({ method, remoteMutation: true });
    assert.equal((await writer.reconcile()).settled, false);
    const changed = downloadFixture({ method });
    assert.equal((await changed.reconcile({ retryParams: { ...changed.retryParams, localPath: 'C:/other' } })).status, 'identityMismatch');
  });
}

for (const option of ["localBusy", "remoteMutation", "failPersistence"]) {
  test(`read-only recovery refuses uncertain evidence (${option})`, async () => {
    const f = downloadFixture({ [option]: true });
    assert.equal((await f.reconcile()).settled, false);
    await assert.rejects(__test.beginTransferOperation("blocked-read", "456:new", false, f.requestKey), /未确认的旧请求/);
  });
}

test("changed read target or a live child cannot be cleared by read-only recovery", async () => {
  const f = downloadFixture();
  assert.equal((await f.reconcile({ retryParams: { ...f.retryParams, localPath: "C:/projects/other" } })).status, "identityMismatch");
  __test.trackTransferResource({ once() { return this; } }, "old-download");
  assert.equal((await f.reconcile()).settled, false);
  assert.deepEqual(f.order, []);
});

function fixture(options = {}) {
  const values = new Map([[ledgerKey, options.noLegacy ? [] : [{ operationId: "legacy-op", operationInstanceId: "123:old", status: "outcomeUnknown",
    startedAt: new Date().toISOString(), reason: "process closed without authoritative remote exit status (SIGTERM)",
    remoteMutation: true, requestKey: key }]]]);
  const order = [];
  const globalState = { get: (name, fallback) => values.get(name) || fallback,
    async update(name, value) { if (options.failPersistence) throw Error("disk locked"); await options.onWrite?.(); values.set(name, structuredClone(value)); } };
  __test.setTransferSettlementTestContext({ globalState, instanceId: "456:new", recoveryHooks: {
    async localProof() { order.push("local"); if (options.localBusy) throw Error("LOCAL_TRANSFER_OR_OWNER_STILL_ACTIVE"); },
    async acquire(resources) {
      order.push("lease"); assert.equal(resources.length, 2); assert.equal(resources[0].target, params.source.remotePath);
      return { async assertHeld() { if (options.leaseLost) throw Error("LEASE_LOST"); }, async release() { order.push("release"); } };
    },
  } });
  __test.setRemoteBatchTransport(async (target, command, paths, _timeout, transport) => {
    order.push(target.host); assert.equal(transport.remoteMutation, false); assert.deepEqual(paths, []);
    assert.match(command, /simple_sftp_settlement_probe/);
    if (options.remoteBusy && target.host === "dest-host") return JSON.stringify({ idle: false, reason: "REMOTE_TRANSFER_SLOT_BUSY" });
    if (options.processBlocker && target.host === "dest-host") return JSON.stringify({ idle: false, reason: "REMOTE_TRANSFER_STILL_ACTIVE",
      blocker: options.processBlocker });
    if (options.malformedProof) return JSON.stringify({ idle: true, root: target.remotePath });
    if (options.externalProof) return JSON.stringify({ idle: true, root: target.remotePath, inspectedProcesses: 3, inspectedLocks: 1, ...options.externalProof });
    return JSON.stringify({ idle: true, root: target.remotePath, inspectedProcesses: 3, inspectedLocks: 1 });
  });
  const reconcile = (overrides = {}) => __test.createLocalApiMethods()["transfers.reconcile"]({ operationId: "legacy-op", operationInstanceId: "123:old",
    requestKey: key, retryMethod: method, retryParams: params, ...overrides });
  return { values, order, reconcile };
}

test("legacy SIGTERM receipt blocks first, then proven exit permits one fresh dispatch without deleting history", async () => {
  const f = fixture();
  await assert.rejects(__test.beginTransferOperation("not-started", "456:new", true, key), error => {
    assert.equal(error.apiData.notStarted, true); assert.equal(error.apiData.blockedOperationId, "legacy-op"); return true;
  });
  assert.equal((await f.reconcile()).settled, true);
  assert.deepEqual(f.order, ["lease", "local", "source-host", "dest-host", "local", "release"]);
  const old = f.values.get(ledgerKey)[0];
  assert.match(old.reason, /SIGTERM/); assert.equal(old.recovery.originalOutcome, "outcomeUnknown");
  assert.equal(old.recovery.kind, "verified-writer-exit");
  await __test.beginTransferOperation("new-op", "456:new", true, key);
  await __test.finishTransferOperation("new-op");
  const state = await __test.listTransferOperationState();
  assert.equal(state.settledOperations.length, 2);
  __test.setTransferSettlementTestContext({ globalState: { get: (name, fallback) => f.values.get(name) || fallback }, instanceId: "789:next" });
  assert.equal((await __test.listTransferOperationState()).settledOperations[0].recovery.kind, "verified-writer-exit");
});

for (const [option, reason] of [["localBusy", /LOCAL_TRANSFER/], ["remoteBusy", /REMOTE_TRANSFER_SLOT_BUSY/],
  ["malformedProof", /INVALID_REMOTE_EXIT_PROOF/], ["leaseLost", /LEASE_LOST/], ["failPersistence", /PERSISTENCE_FAILED/]]) {
  test(`incomplete exit evidence (${option}) remains guarded and never permits replay`, async () => {
    const f = fixture({ [option]: true });
    const receipt = await f.reconcile(); assert.equal(receipt.settled, false); assert.match(receipt.reason, reason);
    await assert.rejects(__test.beginTransferOperation("new-op", "456:new", true, key), /未确认的旧请求/);
    assert.equal((await __test.listTransferOperationState()).settledOperations.length, 0);
  });
}

test("changed host, original instance, or unsupported method cannot unlock legacy evidence", async () => {
  const f = fixture();
  assert.equal((await f.reconcile({ operationInstanceId: "other:instance" })).status, "identityMismatch");
  assert.equal((await f.reconcile({ retryParams: { ...params, destination: { ...params.destination, host: "other-host" } } })).status, "identityMismatch");
  assert.equal((await f.reconcile({ retryMethod: "sync.deletePath" })).settled, false);
  assert.deepEqual(f.order, []);
});

test('explicit tar exit proof preserves bounded unobserved external SFTP evidence without argv', async () => {
  const f = fixture({ externalProof: { protocol: 'staged-tar-v1', unobservedExternalSessions: [
    { pid: 345, name: 'sftp-server', scope: 'external-session-uninspectable', argv: 'secret' },
  ] } });
  assert.equal((await f.reconcile()).settled, true);
  const proof = f.values.get(ledgerKey)[0].recovery.proofs[0];
  assert.deepEqual(proof.unobservedExternalSessions, [{ pid: 345, name: 'sftp-server', scope: 'external-session-uninspectable' }]);
  assert.doesNotMatch(JSON.stringify(proof), /secret|argv/);
  const invalid = fixture({ externalProof: { protocol: 'unknown', unobservedExternalSessions: [
    { pid: 345, name: 'sftp-server', scope: 'external-session-uninspectable' },
  ] } });
  assert.equal((await invalid.reconcile()).settled, false);
});

test("a real active remote process reports bounded endpoint identity without unlocking or exposing argv", async () => {
  const f = fixture({ processBlocker: { pid: 345, name: "python3", state: "S", scope: "target-root", command: "password=secret" } });
  const receipt = await f.reconcile();
  assert.equal(receipt.settled, false);
  assert.deepEqual(receipt.blocker, { role: "destination", pid: 345, name: "python3", state: "S", scope: "target-root" });
  assert.match(receipt.reason, /destination:dest-host pid=345 python3 state=S scope=target-root/);
  assert.doesNotMatch(JSON.stringify(receipt), /password|secret/);
  await assert.rejects(__test.beginTransferOperation("new-op", "456:new", true, key), /未确认的旧请求/);
  assert.equal((await __test.listTransferOperationState()).settledOperations.length, 0);
});

test("untrusted blocker fields cannot enter diagnostics and never count as exit evidence", async () => {
  const f = fixture({ processBlocker: { pid: "bad", name: "secret", state: "Z", scope: "anything" } });
  const receipt = await f.reconcile();
  assert.equal(receipt.settled, false); assert.equal(receipt.blocker, undefined);
  assert.match(receipt.reason, /REMOTE_TRANSFER_STILL_ACTIVE destination:dest-host/);
  assert.doesNotMatch(receipt.reason, /secret/);
});

test("an SFTP session with a target write handle still denies replay with only bounded process identity", async () => {
  const f = fixture({ processBlocker: { pid: 345, name: "sftp-server", state: "S", scope: "target-root", path: "/project/private.csv" } });
  const receipt = await f.reconcile();
  assert.equal(receipt.settled, false);
  assert.deepEqual(receipt.blocker, { role: "destination", pid: 345, name: "sftp-server", state: "S", scope: "target-root" });
  assert.doesNotMatch(JSON.stringify(receipt), /private\.csv/);
  await assert.rejects(__test.beginTransferOperation("new-op", "456:new", true, key), /未确认的旧请求/);
  assert.equal((await __test.listTransferOperationState()).settledOperations.length, 0);
});

test("live same-instance request with no child count is not proof of exit", async () => {
  const f = fixture();
  await __test.beginTransferOperation("live-op", "456:new", true, "c".repeat(64));
  const receipt = await f.reconcile({ operationId: "live-op", operationInstanceId: "456:new", requestKey: "c".repeat(64) });
  assert.equal(receipt.settled, false); assert.match(receipt.reason, /尚未退出/); assert.deepEqual(f.order, []);
});

test("failed start persistence never dispatches business work and can later establish an exit receipt", async () => {
  const options = { noLegacy: true, failPersistence: true }, f = fixture(options);
  await assert.rejects(__test.beginTransferOperation("failed-start", "456:new", true, key), error => error.apiData.notStarted === true);
  options.failPersistence = false;
  assert.equal((await f.reconcile({ operationId: "failed-start", operationInstanceId: "456:new" })).settled, true);
  await __test.beginTransferOperation("replacement", "456:new", true, key);
  await __test.finishTransferOperation("replacement");
});

test("same-target dispatch cannot pass while the recovered receipt is still being committed", async () => {
  const options = {}, f = fixture(options); let checked = 0;
  options.onWrite = async () => {
    checked++; await assert.rejects(__test.beginTransferOperation("early-replay", "456:new", true, key), /未确认的旧请求/);
  };
  assert.equal((await f.reconcile()).settled, true); assert.equal(checked, 1);
});

test("probe uses the packaged read-only protocol; identities do not carry credentials or file manifests", () => {
  assert.equal(key.length, 64);
  assert.equal(clientRequestKey(method, { ...params, confirm: true, relativePaths: ["one"], password: "secret" }), key);
  assert.notEqual(clientRequestKey(method, { ...params, source: { ...params.source, port: 99 } }), key);
  const command = settlementProbeCommand("/projects/example", value => "'" + value.replace(/'/g, "'\\''") + "'");
  assert.match(command, /python3 -B -c/); assert.doesNotMatch(command, /rm |kill |rsync /);
});

test("a previous service in the same PID cannot be confused with a drained current-generation request", () => {
  const current = [{ ProcessId: 123, Name: "Code.exe" }];
  assert.throws(() => assertLocalProcessesIdle(current, 123, false, 123), /OWNER_STILL_ACTIVE/);
  assert.doesNotThrow(() => assertLocalProcessesIdle(current, 123, true, 123));
  assert.throws(() => assertLocalProcessesIdle([{ ProcessId: 999, Name: "Code.exe" }], 999, true, 123), /OWNER_STILL_ACTIVE/);
  assert.throws(() => assertLocalProcessesIdle([{ ProcessId: 124, Name: "ssh.exe" }], 123, true, 123), /LOCAL_TRANSFER/);
  assert.throws(() => assertLocalProcessesIdle([{}], 123, false, 123), /UNAVAILABLE/);
  assert.doesNotThrow(() => assertLocalProcessesIdle([], 999, false, 123));
});

test("read-only remote census and stage-lock recovery safety gates", () => {
  const result = spawnSync("python", ["-B", "-X", "utf8", "test/transfer_settlement_probe_test.py"],
    { cwd: require("node:path").join(__dirname, ".."), encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
});
