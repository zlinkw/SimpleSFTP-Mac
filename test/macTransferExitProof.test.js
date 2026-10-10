"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), Module = require("node:module");
const nativeCalls = [];
let stdout = " 111 /Applications/Visual Studio Code.app/Code Helper (Plugin)\n 222 /Applications/Termius.app/Termius\n 333 /usr/bin/ssh-agent\n 444 /usr/sbin/sshd\n", nativeError;
function load(platform = "darwin") {
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../transfer-settlement.js"), "utf8"), {
    module: mod, exports: mod.exports, __dirname: path.join(__dirname, ".."), Buffer,
    process: { platform, pid: 111 }, require(name) {
      if (name === "node:child_process") return { execFile(file, args, options, callback) {
        nativeCalls.push({ file, args, options }); callback(nativeError, stdout);
      } };
      return require(name);
    },
  }, { filename: "transfer-settlement.js" });
  return mod.exports;
}
const settlement = load();
const idle = stdout;
test("Darwin native proof accepts complete idle snapshot without reading Termius sessions or arguments", async () => {
  stdout = idle; nativeError = undefined; nativeCalls.length = 0;
  const proof = await settlement.localTransferExitProof("123:old");
  assert.equal(proof.localOwnerExited, true); assert.equal(proof.localTransportCount, 0);
  const call = nativeCalls[0]; assert.equal(call.file, "/bin/ps");
  assert.deepEqual(Array.from(call.args), ["-ax", "-o", "pid=,comm="]);
  assert.equal(call.options.timeout, 6000); assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.encoding, "utf8"); assert.equal(call.options.maxBuffer, 512 * 1024);
});
test("live or reused owner PID blocks recovery; only explicitly drained current owner is allowed", async () => {
  stdout = idle + " 123 /Applications/新应用.app/新应用\n";
  for (const allow of [false, true]) await assert.rejects(settlement.localTransferExitProof("123:old", allow), /STILL_ACTIVE/);
  stdout = idle;
  await assert.rejects(settlement.localTransferExitProof("111:previous"), /STILL_ACTIVE/);
  assert.equal((await settlement.localTransferExitProof("111:drained", true)).localOwnerExited, false);
});
test("every live local streaming transport blocks instead of stopping any process", async () => {
  for (const name of ["ssh", "scp", "sftp", "rsync", "tar", "gzip", "pigz", "zstd"]) {
    stdout = idle + ` 555 /Users/测试用户/带 空格/${name}\n`;
    await assert.rejects(settlement.localTransferExitProof("123:old"), /STILL_ACTIVE/);
  }
});
test("corrupt, incomplete, oversized or unavailable native snapshots never establish exit", async () => {
  for (const bad of ["", " 222 /usr/bin/ps\n", idle + " 111 duplicate\n", idle + "malformed\n", idle + " 0 invalid\n", idle + " 2147483648 invalid\n", idle + "\u0000", idle + "\uFFFD", idle + "x".repeat(512 * 1024)]) {
    stdout = bad; await assert.rejects(settlement.localTransferExitProof("123:old"), /UNAVAILABLE/);
  }
  stdout = idle; nativeError = Error("timeout");
  await assert.rejects(settlement.localTransferExitProof("123:old"), /UNAVAILABLE/); nativeError = undefined;
  for (const id of ["missing", "0:invalid", "2147483648:invalid"]) await assert.rejects(settlement.localTransferExitProof(id), /UNAVAILABLE/);
});
test("Windows keeps native CIM proof and unsupported platforms do not execute a fallback", async () => {
  const windows = load("win32"); stdout = "[]"; nativeCalls.length = 0;
  assert.equal((await windows.localTransferExitProof("123:old")).localOwnerExited, true);
  assert.equal(nativeCalls[0].file, "pwsh.exe"); assert.match(nativeCalls[0].args[3], /Get-CimInstance Win32_Process/);
  stdout = JSON.stringify([{ ProcessId: 123, Name: "Code.exe" }]);
  await assert.rejects(windows.localTransferExitProof("123:old"), /STILL_ACTIVE/);
  nativeCalls.length = 0; await assert.rejects(load("linux").localTransferExitProof("123:old"), /UNAVAILABLE/);
  assert.equal(nativeCalls.length, 0); stdout = idle;
});

const originalLoad = Module._load;
let api;
try {
  Module._load = function(request, ...args) {
    if (request === "./transfer-settlement") return settlement;
    if (request === "vscode") return { TreeItem: class {}, ProgressLocation: { Notification: 1 },
      workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
      window: { withProgress: (_options, operation) => operation({ report() {} }), showErrorMessage() {} } };
    return originalLoad.call(this, request, ...args);
  };
  api = require("../extension").__test;
} finally { Module._load = originalLoad; }
const ledgerKey = "simple-sftp-transfer-settlement.v1";
function fixture(failPersistence = false) {
  const retryMethod = "sync.downloadMappedPaths", retryParams = { localPath: "/fixture/project", server: {
    id: "source", host: "source-host", username: "tester", port: 2222, remotePath: "/projects/example" } };
  const requestKey = settlement.clientRequestKey(retryMethod, retryParams);
  const values = new Map([[ledgerKey, [{ operationId: "old-download", operationInstanceId: "123:old", status: "outcomeUnknown",
    startedAt: new Date().toISOString(), remoteMutation: false, requestKey }]]]);
  api.setTransferSettlementTestContext({ instanceId: "111:current", globalState: {
    get: (name, fallback) => values.get(name) || fallback,
    async update(name, value) { if (failPersistence) throw Error("disk locked"); values.set(name, structuredClone(value)); },
  }, recoveryHooks: { async acquire() { throw Error("read-only recovery must not lease remote writers"); } } });
  api.setRemoteBatchTransport(() => { throw Error("read-only recovery must not contact remote writers"); });
  return { values, requestKey, reconcile: () => api.createLocalApiMethods()["transfers.reconcile"]({
    operationId: "old-download", operationInstanceId: "123:old", requestKey, retryMethod, retryParams }) };
}
test("actual recovery consumer obtains Darwin proof twice, persists receipt and permits fresh dispatch", async () => {
  stdout = idle; nativeCalls.length = 0; const f = fixture();
  await assert.rejects(api.beginTransferOperation("too-early", "111:current", false, f.requestKey), /未确认的旧请求/);
  assert.equal((await f.reconcile()).settled, true); assert.equal(nativeCalls.length, 2);
  assert.equal(f.values.get(ledgerKey)[0].recovery.kind, "verified-read-transfer-exit");
  await api.beginTransferOperation("fresh-read", "111:current", false, f.requestKey); await api.finishTransferOperation("fresh-read");
});
test("actual recovery consumer retains unknown outcome for live owner, unavailable proof or failed persistence", async () => {
  for (const scenario of ["busy", "unavailable", "persistence"]) {
    stdout = scenario === "busy" ? idle + " 123 /bin/ssh\n" : scenario === "unavailable" ? "" : idle;
    const f = fixture(scenario === "persistence");
    assert.equal((await f.reconcile()).settled, false);
    assert.equal(f.values.get(ledgerKey)[0].status, "outcomeUnknown");
    await assert.rejects(api.beginTransferOperation("blocked-read", "111:current", false, f.requestKey), /未确认的旧请求/);
  }
  stdout = idle;
});
