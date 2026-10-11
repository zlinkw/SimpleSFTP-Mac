"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), Module = require("node:module");
const { EventEmitter } = require("node:events");
const { clientRequestKey, retryIdentity } = require("../transfer-settlement");
const originalLoad = Module._load;
let api;
try {
  Module._load = function(name, ...args) { return name === "vscode" ? {
    TreeItem: class {}, ProgressLocation: { Notification: 1 },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { withProgress: (_options, work) => work({ report() {} }), showErrorMessage() {} },
  } : originalLoad.call(this, name, ...args); };
  api = require("../extension").__test;
} finally { Module._load = originalLoad; }
const ledgerKey = "simple-sftp-transfer-settlement.v1";
const server = { id: "target", host: "worker.example", username: "research", port: 2222, remotePath: "/projects/中文 A" };
function fixture(options = {}) {
  const retryMethod = "upload.files", retryParams = { localBase: "D:/fixture/project", server };
  const requestKey = clientRequestKey(retryMethod, retryParams), order = [];
  const values = new Map([[ledgerKey, [{ operationId: "old-upload", operationInstanceId: "123:old", status: "outcomeUnknown",
    startedAt: new Date().toISOString(), remoteMutation: true, requestKey,
    ...(options.withContext ? { recoveryContext: { method: retryMethod, params: retryIdentity(retryParams) } } : {}) }]]]);
  api.setTransferSettlementTestContext({ instanceId: "456:new", globalState: {
    get: (key, fallback) => values.get(key) || fallback,
    async update(key, rows) { if (options.persistence) throw Error("disk locked"); values.set(key, structuredClone(rows)); },
  }, recoveryHooks: {
    async localProof() { order.push("local"); if (options.localBusy) throw Error("LOCAL_TRANSFER_OR_OWNER_STILL_ACTIVE"); },
    async acquire(resources) { order.push("lease"); assert.equal(resources.length, 1); return {
      async assertHeld() { order.push("held"); }, async release() { order.push("release"); },
    }; },
  } });
  api.setRemoteBatchTransport(async (target, command, paths, timeout, config) => {
    order.push("remote"); assert.equal(target.host, server.host); assert.equal(config.remoteMutation, false);
    assert.match(command, /plain-tar-v1/); assert.equal(paths.length, 0); assert.equal(timeout, 20000);
    if (options.remoteError) throw Error("permission denied");
    return JSON.stringify(options.proof || { idle: true, root: server.remotePath, protocol: "plain-tar-v1",
      inspectedProcesses: 4, inspectedLocks: 0, unobservedExternalSessions: [] });
  });
  return { values, order, requestKey, retryParams, reconcile: overrides => api.createLocalApiMethods()["transfers.reconcile"]({
    operationId: "old-upload", operationInstanceId: "123:old", requestKey, retryMethod, retryParams, ...overrides }) };
}
test("legacy upload.files resolves only after two local proofs, target writer census and durable receipt", async () => {
  const f = fixture();
  await assert.rejects(api.beginTransferOperation("early", "456:new", true, f.requestKey), /未确认/);
  assert.equal((await f.reconcile()).settled, true);
  assert.deepEqual(f.order, ["lease", "held", "local", "remote", "local", "held", "release"]);
  const receipt = f.values.get(ledgerKey)[0];
  assert.equal(receipt.recovery.kind, "verified-writer-exit");
  assert.equal(receipt.recovery.originalOutcome, "outcomeUnknown");
  assert.equal(receipt.uploaded, undefined, "exit proof must not claim file upload success");
  await api.beginTransferOperation("retry", "456:new", true, f.requestKey);
  await api.finishTransferOperation("retry");
});
test("upload recovery by ID uses persisted exact target and retains all writer exit guards", async () => {
  const f = fixture({ withContext: true });
  assert.equal((await f.reconcile({ retryMethod: undefined, retryParams: undefined, requestKey: undefined })).settled, true);
  assert.deepEqual(f.order, ["lease", "held", "local", "remote", "local", "held", "release"]);
  const busy = fixture({ withContext: true, localBusy: true });
  assert.equal((await busy.reconcile({ retryMethod: undefined, retryParams: undefined, requestKey: undefined })).settled, false);
  assert.ok(!busy.order.includes("remote"));
});

test("only a fresh confirmed upload checks its exact legacy blocker; previews and failed proofs never dispatch", async () => {
  let f = fixture();
  const invoke = params => api.createLocalApiMethods()["upload.files"]({ ...f.retryParams, _requestKey: f.requestKey, ...params });
  await assert.rejects(invoke({}), /未确认/);
  assert.deepEqual(f.order, []);
  await assert.rejects(invoke({ confirm: true, pathConfirmed: true }), /缺少上传文件列表/);
  assert.equal(f.values.get(ledgerKey).find(row => row.operationId === "old-upload").status, "settled");
  f = fixture({ localBusy: true });
  await assert.rejects(invoke({ confirm: true, pathConfirmed: true }), error => error.apiData.notStarted === true && error.apiData.reconciliation.settled === false);
  assert.equal(f.values.get(ledgerKey).length, 1);
});
test("missing identity, unavailable proof, live writers, mismatched protocol and persistence failure keep upload blocked", async () => {
  for (const options of [{ localBusy: true }, { remoteError: true }, { persistence: true },
    { proof: { idle: false, reason: "REMOTE_TRANSFER_STILL_ACTIVE", blocker: { pid: 42, name: "tar", state: "R", scope: "unscoped" } } },
    { proof: { idle: true, root: server.remotePath, protocol: "staged-tar-v1", inspectedProcesses: 3, inspectedLocks: 0 } },
    { proof: { idle: true, root: server.remotePath, protocol: "plain-tar-v1", inspectedProcesses: 3, inspectedLocks: 0, unobservedExternalSessions: [{}] } }]) {
    const f = fixture(options); assert.equal((await f.reconcile()).settled, false);
    await assert.rejects(api.beginTransferOperation("blocked", "456:new", true, f.requestKey), /未确认/);
    assert.equal(f.values.get(ledgerKey)[0].status, "outcomeUnknown");
  }
  const f = fixture(); assert.equal((await f.reconcile({ operationInstanceId: "another" })).status, "identityMismatch");
  assert.equal((await f.reconcile({ retryParams: { server: { ...server, host: "other" } } })).status, "identityMismatch");
  assert.deepEqual(f.order, []);
});
test("read-only authentication cancellation drains without fabricating upload success; ambiguous writer exit still blocks", async () => {
  for (const remoteMutation of [false, true]) {
    const values = new Map(); api.setTransferSettlementTestContext({ instanceId: "456:new", globalState: {
      get: (key, fallback) => values.get(key) || fallback, update: async (key, value) => values.set(key, structuredClone(value)),
    } });
    await api.beginTransferOperation("cancelled-auth", "456:new", true, "a".repeat(64));
    const child = new EventEmitter(); api.trackTransferResource(child, "cancelled-auth", remoteMutation);
    child.emit("close", 255); await api.finishTransferOperation("cancelled-auth");
    const state = await api.listTransferOperationState();
    assert.equal(state.settledOperations.some(row => row.operationId === "cancelled-auth"), !remoteMutation);
  }
});
test("actual relay authenticates both endpoints before inventory and names the rejected target", async () => {
  const calls = []; api.setMacAuthentication({ config: () => ({ method: "auto" }) });
  api.setRemoteBatchTransport(async (target, command, paths, timeout, options) => {
    calls.push({ target, command, options });
    assert.equal(command, "printf %s SIMPLE_SFTP_AUTH_READY"); assert.equal(options.remoteMutation, false);
    if (target.host === server.host) throw Error("Permission denied (publickey,password).");
    return "SIMPLE_SFTP_AUTH_READY";
  });
  try {
    await assert.rejects(api.syncServerToServerFpsyncCore({ apiMode: true, source: { ...server, host: "source.example" },
      destination: server, relativePaths: ["校验用/中文 文件 %20.txt"], confirm: true, pathConfirmed: true }, { report() {} }),
      error => error.code === "SSH_AUTHENTICATION_NOT_READY" && error.apiData.notStarted === true && error.apiData.role === "目标");
    assert.deepEqual(calls.map(row => row.target.host), ["source.example", server.host]);
    assert.equal(calls.length, 2, "no inventory, tar writer, upload or retry may start after destination auth rejection");
    await assert.rejects(api.runLocalTarUploadCore({ localPath: "D:/fixture/project", sftp: server,
      uploadPlan: { files: [{ relativePath: "中文.txt", content: Buffer.from("x"), size: 1 }] } }), /上传目标 SSH 认证未完成/);
  } finally { api.setMacAuthentication(undefined); api.setRemoteBatchTransport(undefined); }
});
