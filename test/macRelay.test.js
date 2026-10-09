const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const root = path.resolve(__dirname, "..");
const runtimeRequire = createRequire(path.join(root, "extension.js"));
const source = { host: "source.example.org", username: "research", port: 2222, remotePath: "/projects/中文 A" };
const destination = { host: "destination.example.org", username: "other", port: 2223, remotePath: "/projects/中文 B" };
const tick = () => new Promise(resolve => setImmediate(resolve));

function payload(command) {
  for (const match of command.matchAll(/[A-Za-z0-9+/=]{30,}/g)) {
    try { const value = JSON.parse(zlib.inflateRawSync(Buffer.from(match[0], "base64"))); if (value.root) return value; } catch {}
  }
}

function harness(options = {}) {
  const calls = [], controls = [], sessions = new Map(), leases = [];
  const data = options.data || Buffer.from("tar bytes\0中文\0Password: belongs to a file, not SSH input");
  let id = 0;
  class LeaseManager {
    async run(request, work) { const lease = { request, held: true }; leases.push(lease); try { return await work(); } finally { lease.held = false; } }
  }
  const fakeSpawn = (file, args, launchOptions) => {
    const writer = launchOptions.stdio[1] === "ignore";
    if (writer && options.throwWriter) throw Error("destination spawn failed");
    const child = new EventEmitter(), input = [];
    Object.assign(child, { pid: ++id, stdout: writer ? null : new PassThrough({ highWaterMark: 1024 }), stderr: new PassThrough(), input, writer });
    child.close = (code = 0, signal) => { if (child.closed) return; child.closed = true; child.emit("close", code, signal); };
    child.kill = () => { child.killed = true; if (options.killThrows) throw Error("kill failed"); if (options.autoKill !== false) queueMicrotask(() => child.close(null, "SIGTERM")); return true; };
    child.stdin = new Writable({ highWaterMark: 1024, write(bytes, _encoding, callback) {
      input.push(Buffer.from(bytes)); if (options.slowWriter && writer) setImmediate(callback); else callback();
    } });
    if (writer && options.auto !== false) child.stdin.on("finish", () => child.close(0));
    calls.push({ file, args, options: launchOptions, child });
    if (!writer && options.auto !== false) queueMicrotask(() => { child.stdout.end(data); child.close(0); });
    return child;
  };
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, __dirname: root, __filename: path.join(root, "extension.js"),
    Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, AbortController,
    process: { ...process, platform: "darwin", arch: "arm64" },
    require(name) {
      if (name === "vscode") return { TreeItem: class {}, ProgressLocation: { Notification: 1 } };
      if (name === "child_process") return { ...runtimeRequire(name), spawn: fakeSpawn };
      if (name === "./host-operation-lease.js") return { HostOperationLeaseManager: LeaseManager, HostOperationLeaseConflictError: class extends Error {} };
      return runtimeRequire(name);
    } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "extension.js"), "utf8") +
    "\nmodule.exports.__test.contextRun = (value,work) => transferContext.run(value,work);", sandbox);
  const api = module.exports.__test;
  api.setMacAuthentication({ config: () => ({ method: "password" }), invocation(target) {
    const nonce = crypto.randomBytes(32).toString("hex"); sessions.set(nonce, target.host);
    return { env: { SIMPLE_SFTP_AUTH_NONCE: nonce }, release() { sessions.delete(nonce); } };
  } });
  api.setRemoteBatchTransport((target, command, paths, timeout, request) => {
    controls.push({ target, command, paths, timeout, request });
    return options.control ? options.control(target, command, paths, request) : JSON.stringify({ offset: 8 * 1024 * 1024, chunkBytes: 8 * 1024 * 1024 });
  });
  return { api, calls, controls, sessions, leases, data };
}

function assertIndependentConnections(h) {
  assert.equal(h.calls.length, 2);
  const [read, write] = h.calls;
  assert.equal(read.file, "ssh"); assert.equal(write.file, "ssh");
  assert.ok(read.args.includes("research@source.example.org")); assert.ok(write.args.includes("other@destination.example.org"));
  assert.ok(read.args.includes("2222")); assert.ok(write.args.includes("2223"));
  assert.ok(read.args.includes("ForwardAgent=no")); assert.ok(write.args.includes("ForwardAgent=no"));
  assert.notEqual(read.options.env.SIMPLE_SFTP_AUTH_NONCE, write.options.env.SIMPLE_SFTP_AUTH_NONCE);
  for (const call of h.calls) {
    assert.ok(!call.args.includes("-A")); assert.ok(!call.args.includes("BatchMode=yes"));
    assert.doesNotMatch(call.args.at(-1), /\| ssh |rsync /);
  }
}

test("actual Mac fpsync compares both inventories, streams only changed Chinese paths and verifies destination", async () => {
  const name = "results/中文 file.csv", unchanged = "results/steady.csv";
  const hash = crypto.createHash("sha256").update("changed").digest("hex"), steady = "b".repeat(64);
  let destinationReads = 0;
  const h = harness({ control(target) {
    const final = target.host === destination.host && ++destinationReads > 1;
    return JSON.stringify({ files: { [name]: { sha256: target.host === source.host || final ? hash : "c".repeat(64), size: 7 }, [unchanged]: { sha256: steady, size: 5 } }, cacheHits: 0, cacheRehash: 2, digestReads: 2, cacheQueries: 2 });
  } });
  const result = await h.api.syncServerToServerFpsyncCore({ source, destination, relativePaths: [name, unchanged], compression: "none", confirm: true, pathConfirmed: true, apiMode: true }, { report() {} });
  assert.equal(result.ok, true); assert.equal(h.controls.length, 3); assert.equal(destinationReads, 2);
  assertIndependentConnections(h);
  assert.match(h.calls[0].args.at(-1), /realpath -e/);
  assert.match(h.calls[0].args.at(-1), /pwd -P/);
  assert.equal(Buffer.concat(h.calls[0].child.input).toString("utf8"), name + "\0");
  assert.deepEqual(Buffer.concat(h.calls[1].child.input), h.data);
  assert.equal(h.sessions.size, 0); assert.equal(h.leases[0].held, false);
});

test("large file resumes its 8 MiB checkpoint through two authenticated local streams with compression", async () => {
  for (const compression of ["none", "gzip", "zstd"]) {
    const h = harness(), name = "weights/中文 model.bin";
    await h.api.transferPartitionedTar(source, destination, [name], 20000, () => {}, {
      compression, fileSizes: { [name]: 600 * 1024 * 1024 }, expectedFiles: { [name]: { size: 600 * 1024 * 1024, sha256: "a".repeat(64) } },
    });
    assert.equal(h.controls.length, 1); assert.equal(h.controls[0].target.host, destination.host);
    assert.equal(h.controls[0].request.remoteMutation, true);
    assert.equal(payload(h.controls[0].command).mode, "chunkStatus");
    assertIndependentConnections(h);
    const read = payload(h.calls[0].args.at(-1)), receive = payload(h.calls[1].args.at(-1));
    assert.equal(read.mode, "readChunks"); assert.equal(receive.mode, "receiveChunks");
    assert.equal(read.offset, 8 * 1024 * 1024); assert.equal(receive.offset, read.offset);
    assert.equal(read.root, source.remotePath); assert.equal(receive.root, destination.remotePath);
    assert.equal(read.entries[0].path, name); assert.equal(receive.entries[0].sha256, "a".repeat(64));
    if (compression === "gzip") assert.match(h.calls[1].args.at(-1), /gzip -dc/);
    if (compression === "zstd") assert.match(h.calls[1].args.at(-1), /zstd -dc/);
    assert.deepEqual(Buffer.concat(h.calls[1].child.input), h.data);
  }
});

test("relay pipe applies backpressure and completion waits for both close events", async () => {
  const h = harness({ auto: false, slowWriter: true });
  let complete = false;
  const pending = h.api.relayTarFilesCore(source, destination, ["results/file.csv"], 20000, { compression: "none" }).then(() => { complete = true; });
  const [reader, writer] = h.calls.map(call => call.child);
  reader.stdout.write(Buffer.alloc(4096, 65));
  assert.equal(reader.stdout.isPaused(), true);
  await tick(); reader.stdout.end();
  reader.emit("exit", 0); writer.emit("exit", 0); await tick();
  assert.equal(complete, false); assert.equal(h.sessions.size, 2);
  reader.close(0); await tick(); assert.equal(complete, false);
  writer.close(0); await pending; assert.equal(complete, true); assert.equal(h.sessions.size, 0);
});

test("destination launch throw stops its reader and holds the lease until reader close", async () => {
  const h = harness({ auto: false, throwWriter: true, killThrows: true });
  let settled = false;
  const pending = h.api.transferPartitionedTar(source, destination, ["results/file.csv"], 20000, null, { compression: "none" });
  pending.catch(() => { settled = true; }); await tick();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].child.killed, true);
  assert.equal(settled, false); assert.equal(h.leases[0].held, true);
  h.calls[0].child.close(null, "SIGTERM");
  await assert.rejects(pending, /destination spawn failed/);
  assert.equal(h.leases[0].held, false); assert.equal(h.sessions.size, 0);
});

test("writer failure kills its peer without direct retry and retains unknown remote outcome until recovery", async () => {
  const h = harness({ auto: false, autoKill: false }), states = new Map();
  h.api.setTransferSettlementTestContext({ globalState: { get: (key, fallback) => states.get(key) || fallback, update: async (key, value) => states.set(key, value) } });
  await h.api.beginTransferOperation("mac-relay", "test-instance", true, "a".repeat(64));
  const controller = { operationId: "mac-relay", onCancel: () => ({ dispose() {} }), updateProgress() {} };
  const pending = h.api.contextRun(controller, () => h.api.transferPartitionedTar(source, destination, ["results/file.csv"], 20000, null, { compression: "none" }));
  const rejected = assert.rejects(pending, /内存转发失败/);
  await tick(); const [reader, writer] = h.calls.map(call => call.child);
  writer.close(255); await tick(); assert.equal(reader.killed, true); assert.equal(h.leases[0].held, true);
  reader.close(null, "SIGTERM"); await rejected; await h.api.finishTransferOperation("mac-relay");
  const receipt = await h.api.listTransferOperationState();
  assert.equal(receipt.operations[0].status, "outcomeUnknown"); assert.equal(receipt.operations[0].childCount, 0);
  assert.equal(h.controls.length, 0); assert.equal(h.calls.length, 2); assert.equal(h.sessions.size, 0);
});

test("local stdin EPIPE stops both peers and cannot count a failed group as committed", async () => {
  const h = harness({ auto: false, autoKill: false }), reports = [];
  const pending = h.api.transferPartitionedTar(source, destination, ["results/file.csv"], 20000, value => reports.push(value), { compression: "none" });
  const rejected = assert.rejects(pending, /pipe broken/);
  await tick(); h.calls[1].child.stdin.emit("error", Error("pipe broken"));
  assert.ok(h.calls.every(call => call.child.killed));
  for (const call of h.calls) call.child.close(null, "SIGTERM");
  await rejected; assert.equal(reports.some(report => report.phase === "done"), false);
});

test("partitioned relays retain the two-group concurrency bound and report committed files once", async () => {
  const h = harness({ auto: false }), paths = Array.from({ length: 161 }, (_, i) => `results/${i}.csv`), reports = [];
  const pending = h.api.transferPartitionedTar(source, destination, paths, 20000, value => reports.push(value), {
    compression: "none", fileSizes: Object.fromEntries(paths.map(name => [name, 1])),
  });
  await tick(); assert.equal(h.calls.length, 4);
  for (const call of h.calls.slice(0, 2)) call.child.close(0);
  await tick(); assert.equal(h.calls.length, 6);
  assert.equal(h.calls.filter(call => !call.child.closed).length, 4);
  for (const call of h.calls) call.child.close(0);
  assert.equal(await pending, 3);
  const committed = reports.filter(report => report.phase === "done");
  assert.equal(committed.length, 3); assert.equal(committed.at(-1).completedFiles, 161);
  assert.equal(h.controls.length, 0); assert.equal(h.sessions.size, 0);
});

test("failed read-only source cannot obscure a destination with authoritative successful exit", async () => {
  const h = harness({ auto: false }), states = new Map();
  h.api.setTransferSettlementTestContext({ globalState: { get: (key, fallback) => states.get(key) || fallback, update: async (key, value) => states.set(key, value) } });
  await h.api.beginTransferOperation("read-failure", "test-instance", true, "b".repeat(64));
  const controller = { operationId: "read-failure", onCancel: () => ({ dispose() {} }), updateProgress() {} };
  const pending = h.api.contextRun(controller, () => h.api.relayTarFilesCore(source, destination, ["results/file.csv"], 20000, { compression: "none" }));
  const rejected = assert.rejects(pending, /内存转发失败/);
  h.calls[1].child.close(0); h.calls[0].child.close(255);
  await rejected; await h.api.finishTransferOperation("read-failure");
  const receipt = await h.api.listTransferOperationState();
  assert.equal(receipt.operations.length, 0); assert.equal(receipt.settledOperations[0].status, "settled");
});

test("invalid chunk checkpoint and missing confirmations launch no file stream", async () => {
  const h = harness({ control: () => JSON.stringify({ offset: 1, chunkBytes: 8 * 1024 * 1024 }) });
  await assert.rejects(h.api.transferChunkedServerFile(source, destination, "weights/model.bin", 20000, {
    compression: "none", expectedFiles: { "weights/model.bin": { size: 600 * 1024 * 1024, sha256: "a".repeat(64) } },
  }), /检查点无效/);
  await assert.rejects(h.api.syncServerToServerFpsyncCore({ source, destination, relativePaths: ["results/file.csv"], compression: "none", apiMode: true }, { report() {} }), error => error.apiCode === 2001);
  assert.equal(h.calls.length, 0); assert.equal(h.controls.length, 1);
});
