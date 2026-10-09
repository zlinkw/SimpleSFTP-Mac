const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  return request === "vscode" ? {
    TreeItem: class {},
    ProgressLocation: { Notification: 1 },
    window: { withProgress: (_options, operation) => operation({ report: () => undefined }), showErrorMessage: () => undefined },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  } : originalLoad.call(this, request, ...args);
};
const { __test } = require("../extension.js");
Module._load = originalLoad;

function storage() {
  const values = new Map();
  return {
    get(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
    async update(key, value) { values.set(key, structuredClone(value)); },
  };
}

test("settled transfer receipts survive service restart with their original operation identity", async () => {
  const globalState = storage();
  const requestKey = "a".repeat(64);
  __test.setTransferSettlementTestContext({ globalState, instanceId: "pid-a:started-a" });
  await __test.beginTransferOperation("done-op", "pid-a:started-a", false, requestKey);
  await __test.finishTransferOperation("done-op");

  __test.setTransferSettlementTestContext({ globalState, instanceId: "pid-b:started-b" });
  const state = await __test.listTransferOperationState();
  assert.equal(state.instanceId, "pid-b:started-b");
  assert.deepEqual(state.settledOperations.map(({ operationId, operationInstanceId, status }) => ({ operationId, operationInstanceId, status })), [
    { operationId: "done-op", operationInstanceId: "pid-a:started-a", status: "settled" },
  ]);
  await __test.beginTransferOperation("retry-op", "pid-b:started-b", false, requestKey);
  await __test.finishTransferOperation("retry-op");
});

test("unsettled transfer after restart stays outcomeUnknown and cannot be acknowledged as stopped", async () => {
  const globalState = storage();
  const requestKey = "b".repeat(64);
  __test.setTransferSettlementTestContext({ globalState, instanceId: "pid-a:started-a" });
  await __test.beginTransferOperation("unknown-op", "pid-a:started-a", true, requestKey);
  __test.trackTransferResource({ once() { return this; } }, "unknown-op");
  await __test.finishTransferOperation("unknown-op");

  __test.setTransferSettlementTestContext({ globalState, instanceId: "pid-b:started-b" });
  const state = await __test.listTransferOperationState();
  assert.equal(state.operations.some((row) => row.operationId === "unknown-op" && row.status === "outcomeUnknown"), true);
  await assert.rejects(__test.beginTransferOperation("retry-op", "pid-b:started-b", true, requestKey), /未确认的旧请求/);
  const cancellation = await __test.createLocalApiMethods()["transfers.cancel"]({ operationId: "unknown-op" });
  assert.equal(cancellation.cancelled, false);
  assert.equal(cancellation.settled, false);
  assert.equal(cancellation.status, "outcomeUnknown");
  const mismatched = await __test.createLocalApiMethods()["transfers.cancel"]({ operationId: "unknown-op", operationInstanceId: "pid-b:started-b" });
  assert.equal(mismatched.status, "identityMismatch");
});

test("settlement waits for mapped-download write streams to close", async () => {
  const globalState = storage();
  __test.setTransferSettlementTestContext({ globalState, instanceId: "pid-a:started-a" });
  await __test.beginTransferOperation("write-op", "pid-a:started-a", false, "c".repeat(64));
  const stream = { once(_event, listener) { this.onClose = listener; return this; } };
  __test.trackTransferResource(stream, "write-op");
  await __test.finishTransferOperation("write-op");
  let state = await __test.listTransferOperationState();
  assert.equal(state.settledOperations.some((row) => row.operationId === "write-op"), false);
  stream.onClose();
  await new Promise((resolve) => setImmediate(resolve));
  state = await __test.listTransferOperationState();
  assert.equal(state.settledOperations.some((row) => row.operationId === "write-op" && row.status === "settled"), true);
});
