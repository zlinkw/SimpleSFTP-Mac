const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Readable } = require("node:stream");

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  return request === "vscode" ? {
    TreeItem: class {},
    ProgressLocation: { Notification: 1 },
    window: {
      withProgress: (_options, operation) => operation({ report: () => undefined }),
      showErrorMessage: () => undefined,
    },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    },
  } : originalLoad.call(this, request, ...args);
};
const { __test } = require("../extension.js");
Module._load = originalLoad;

const BLOCK = 512;

test("wrapper memory review accepts TSV JSONL YAML and binary results without disk output", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mapped-wrapper-review-"));
  const bodies = [Buffer.from('label\tnote\n案例\t保留\n'), Buffer.from('{"value":null}\n'), Buffer.from('model: same\n'), Buffer.from([0, 255, 2, 9])];
  const entries = ['a.tsv', 'a.jsonl', 'a.yaml', 'mask.npz'].map((name, index) => ({ remotePath: 'work_dirs/case/attempts/run/' + name,
    localRelativePath: 'unused/' + name, bytes: bodies[index].length, sha256: require('crypto').createHash('sha256').update(bodies[index]).digest('hex') }));
  __test.setMappedDownloadTransport(() => tarStream(bodies.map((body, index) => ({ name: 'mapped/' + index, body }))));
  try {
    const result = await __test.createLocalApiMethods()['sync.downloadMappedPaths'](baseParams(root, entries,
      { memoryOnly: true, metricsOnly: true, wrapperResults: true, compression: 'none' }));
    assert.equal(result.memoryOnly, true);
    assert.deepEqual(result.entries.map(entry => Buffer.from(entry.dataBase64, 'base64')), bodies);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { __test.setMappedDownloadTransport(null); }
});

test("wrapper memory review still refuses weights code state missing hashes and oversized files", () => {
  const base = { remotePath: 'work_dirs/case/attempts/run/a.yaml', localRelativePath: 'unused/a.yaml', bytes: 1, sha256: 'a'.repeat(64) };
  const options = entries => ({ entries, memoryOnly: true, metricsOnly: true, wrapperResults: true });
  for (const remotePath of ['weights/a.yaml', 'a.pth', 'a.py', 'a.pid', 'a.lock', 'code_backup/a.yaml', '.runtime/a.yaml', 'clean_dir/a.yaml'])
    assert.throws(() => __test.normalizeMappedDownloadEntries(options([{ ...base, remotePath }])), /拒绝|状态|权重|检查点/);
  for (const fault of [{ sha256: '' }, { bytes: null }, { bytes: 4 * 1024 * 1024 + 1 }])
    assert.throws(() => __test.normalizeMappedDownloadEntries(options([{ ...base, ...fault }])), /上限|大小|SHA256/);
  assert.throws(() => __test.normalizeMappedDownloadEntries({ ...options([base]), memoryOnly: false }), /csv\/json/,
    'the new wrapper flag must not broaden disk download permissions');
});

test("large memory metric batches keep SSH arguments bounded and send the manifest via stdin", async () => {
  const body = "case,seed,value\nA,42,0.9\n";
  const sha256 = require("crypto").createHash("sha256").update(body).digest("hex");
  const entries = Array.from({ length: 128 }, (_, index) => ({
    remotePath: `work_dirs/${"long-experiment-name-".repeat(10)}/${index}/attempts/run-b/test_results/formal_result_rows.csv`,
    localRelativePath: `unused/${index}.csv`, bytes: Buffer.byteLength(body), sha256,
  }));
  const plan = __test.normalizeMappedDownloadEntries({ entries, memoryOnly: true, metricsOnly: true, compression: "none" });
  let request;
  const output = __test.openMappedDownloadStream({ sftp: server(), plan, localPath: "C:/workspace",
    spawnImpl: (_command, args, options) => {
      assert.ok(args.join(" ").length < 16000, "Windows SSH command must not grow with the file manifest");
      assert.equal(options.stdio[0], "pipe");
      const proc = fakeSsh([Buffer.alloc(1024)], 0);
      proc.stdin.on("data", chunk => { request = JSON.parse(chunk.toString("utf8")); });
      return proc;
    },
  });
  for await (const _chunk of output) { /* consume the transport */ }
  await output.sshExit;
  assert.equal(request.root, server().remotePath);
  assert.equal(request.files.length, 128);
  assert.deepEqual(request.files.map(file => file.remotePath), entries.map(file => file.remotePath));
  assert.ok(request.files.every(file => file.sha256 === sha256));
});

test("synchronous SSH spawn failure releases the controller and permits a fresh attempt", async () => {
  const plan = __test.normalizeMappedDownloadEntries({ compression: "none", entries: [{ remotePath: "results/a.csv", localRelativePath: "out/a.csv" }] });
  assert.throws(() => __test.openMappedDownloadStream({ sftp: server(), plan, transferId: "spawn-failed-regression",
    spawnImpl: () => { throw Object.assign(new Error("spawn ENAMETOOLONG"), { code: "ENAMETOOLONG" }); },
  }), /ENAMETOOLONG/);
  const status = await __test.createLocalApiMethods()["transfers.list"]();
  assert.equal(status.transfers.some(transfer => transfer.id === "spawn-failed-regression"), false);
  const retry = __test.openMappedDownloadStream({ sftp: server(), plan, transferId: "spawn-fresh-regression",
    spawnImpl: () => fakeSsh([Buffer.alloc(1024)], 0),
  });
  for await (const _chunk of retry) { /* drain the fresh attempt */ }
  await retry.sshExit;
});

test("oversized mapped manifests are refused before allocating a controller or launching SSH", async () => {
  const plan = __test.normalizeMappedDownloadEntries({ entries: [{ remotePath: "results/a.csv", localRelativePath: "out/a.csv" }] });
  const huge = { ...plan, entries: [{ ...plan.entries[0], remotePath: "x".repeat(1024 * 1024) + ".csv" }] };
  let launches = 0;
  assert.throws(() => __test.openMappedDownloadStream({ sftp: server(), plan: huge, transferId: "manifest-limit-regression",
    spawnImpl: () => { launches++; },
  }), /1 MiB/);
  assert.equal(launches, 0);
  const status = await __test.createLocalApiMethods()["transfers.list"]();
  assert.equal(status.transfers.some(transfer => transfer.id === "manifest-limit-regression"), false);
});

test("memory-only metrics return verified bytes without raw files or staging directories", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mapped-memory-"));
  const body = "case,seed,value\n样例,42,0.91\n";
  const sha256 = require("crypto").createHash("sha256").update(body).digest("hex");
  __test.setMappedDownloadTransport(() => tarStream([{ name: "mapped/0", body }]));
  try {
    const result = await __test.createLocalApiMethods()["sync.downloadMappedPaths"](baseParams(root, [
      { remotePath: "work_dirs/run-b/test_results/formal_result_rows.csv", localRelativePath: "unused/raw.csv", bytes: Buffer.byteLength(body), sha256 },
    ], { memoryOnly: true, metricsOnly: true, compression: "none" }));
    assert.equal(result.memoryOnly, true);
    assert.equal(Buffer.from(result.entries[0].dataBase64, "base64").toString("utf8"), body);
    assert.equal(result.entries[0].sha256, sha256);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { __test.setMappedDownloadTransport(null); }
});

test("memory-only metrics reject missing evidence and oversized batches before transport", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mapped-memory-limit-"));
  let calls = 0;
  __test.setMappedDownloadTransport(() => { calls++; return tarStream([]); });
  try {
    const method = __test.createLocalApiMethods()["sync.downloadMappedPaths"];
    const base = { remotePath: "metrics.csv", localRelativePath: "unused/raw.csv", bytes: 5, sha256: "a".repeat(64) };
    for (const fault of [{ sha256: "" }, { bytes: null }, { bytes: 4 * 1024 * 1024 + 1 }, { remotePath: "weights.pth" }]) {
      await assert.rejects(method(baseParams(root, [{ ...base, ...fault }], { memoryOnly: true, metricsOnly: true, compression: "none" })), /指标|上限|SHA256|大小|权重|检查点/);
    }
    await assert.rejects(method(baseParams(root, [{ ...base, bytes: 3 * 1024 * 1024 }, { ...base, remotePath: "other.csv", localRelativePath: "unused/other.csv", bytes: 3 * 1024 * 1024 }], { memoryOnly: true, metricsOnly: true })), /批次|总大小|上限/);
    assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(root), []);
  } finally { __test.setMappedDownloadTransport(null); }
});

test("memory-only cross-Plan metrics use one gzip stream without publishing raw files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mapped-memory-gzip-"));
  const bodies = ["case,seed,value\n样例,42,0.9\n", "case,seed,value\n另一个,43,0.8\n"];
  const entries = bodies.map((body, index) => ({ remotePath: `work_dirs/plan-${index}/test_results/metrics.csv`, localRelativePath: `unused/${index}.csv`,
    bytes: Buffer.byteLength(body), sha256: require("crypto").createHash("sha256").update(body).digest("hex") }));
  const params = baseParams(root, entries, { memoryOnly: true, metricsOnly: true, compression: "auto" });
  const plan = __test.normalizeMappedDownloadEntries(params);
  let streams = 0;
  try {
    __test.setMappedDownloadTransport(async () => {
      streams++;
      const chunks = [];
      for await (const chunk of tarStream(bodies.map((body, index) => ({ name: `mapped/${index}`, body })))) chunks.push(chunk);
      return __test.openMappedDownloadStream({ sftp: server(), plan, localPath: root,
        spawnImpl: () => fakeSsh([require("node:zlib").gzipSync(Buffer.concat(chunks))], 0) });
    });
    const result = await __test.createLocalApiMethods()["sync.downloadMappedPaths"](params);
    assert.equal(streams, 1); assert.equal(result.compression, "gzip");
    assert.deepEqual(result.entries.map(file => Buffer.from(file.dataBase64, "base64").toString("utf8")), bodies);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { __test.setMappedDownloadTransport(null); }
});

test("memory-only metrics reject corrupt content, incomplete tar and failed SSH without publishing bytes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mapped-memory-failure-"));
  const method = __test.createLocalApiMethods()["sync.downloadMappedPaths"];
  const body = "metric,value\nAUC,0.9\n";
  const entry = { remotePath: "metrics.csv", localRelativePath: "unused/raw.csv", bytes: Buffer.byteLength(body), sha256: require("crypto").createHash("sha256").update(body).digest("hex") };
  try {
    __test.setMappedDownloadTransport(() => tarStream([{ name: "mapped/0", body: body.replace("0.9", "0.1") }]));
    await assert.rejects(method(baseParams(root, [entry], { memoryOnly: true, metricsOnly: true, compression: "none" })), /SHA256/);
    __test.setMappedDownloadTransport(() => Readable.from([tarHeader("mapped/0", entry.bytes), Buffer.from(body)]));
    await assert.rejects(method(baseParams(root, [entry], { memoryOnly: true, metricsOnly: true, compression: "none" })), /尾部|中断|tar/);
    __test.setMappedDownloadTransport(() => { const stream = tarStream([{ name: "mapped/0", body }]); stream.sshExit = Promise.resolve().then(() => { throw new Error("SSH failed"); }); stream.sshExit.catch(() => {}); return stream; });
    await assert.rejects(method(baseParams(root, [entry], { memoryOnly: true, metricsOnly: true, compression: "none" })), /SSH failed/);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { __test.setMappedDownloadTransport(null); }
});

test("cancelled memory-only metrics release the stream and never create a raw cache", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mapped-memory-cancel-"));
  const body = "metric,value\nAUC,0.9\n";
  const token = { isCancellationRequested: false, onCancellationRequested(fn) { this.listener = fn; } };
  try {
    __test.setMappedDownloadTransport(() => {
      token.isCancellationRequested = true; token.listener?.();
      return tarStream([{ name: "mapped/0", body }]);
    });
    await assert.rejects(__test.createLocalApiMethods()["sync.downloadMappedPaths"](baseParams(root, [{ remotePath: "metrics.csv", localRelativePath: "unused/raw.csv",
      bytes: Buffer.byteLength(body), sha256: require("crypto").createHash("sha256").update(body).digest("hex") }], { memoryOnly: true, metricsOnly: true, compression: "none", token })), /取消/);
    assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(__test.listActiveTransfers().some(transfer => transfer.operation === "映射批量下载"), false);
  } finally { __test.setMappedDownloadTransport(null); }
});

function keep(dir) {
  fs.writeFileSync(path.join(dir, "KEEP.txt"), "mapped-batch-download fixture; left in place\n");
}

function tarHeader(name, size) {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(name, 0, "utf8");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("        ", 148, "ascii");
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const sum = header.reduce((total, value) => total + value, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

function fakeSsh(chunks, exitCode, { holdClose = false, stderr = "", onSpawn } = {}) {
  const { PassThrough } = require("node:stream");
  const stdout = new PassThrough();
  const stderrStream = new PassThrough();
  const handlers = {};
  const proc = {
    stdin: new PassThrough(),
    stdout,
    stderr: stderrStream,
    killed: false,
    kill() { this.killed = true; },
    on(event, listener) { handlers[event] = listener; return this; },
  };
  queueMicrotask(() => {
    if (onSpawn) onSpawn(proc);
    for (const chunk of chunks) stdout.write(chunk);
    stdout.end();
    if (stderr) stderrStream.write(stderr);
    const close = () => { if (handlers.close) handlers.close(exitCode, null); };
    if (!holdClose) setImmediate(close);
  });
  proc.emitClose = (code) => { if (handlers.close) handlers.close(code, null); };
  return proc;
}

function tarStream(files) {
  const parts = [];
  for (const file of files) {
    const body = Buffer.from(file.body);
    parts.push(tarHeader(file.name, body.length));
    parts.push(body);
    const padding = (BLOCK - (body.length % BLOCK)) % BLOCK;
    if (padding) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Readable.from(parts);
}

function server() {
  return { id: "worker-a", host: "worker-a", user: "research", remotePath: "/projects/demo", port: 22 };
}

function baseParams(root, entries, extra = {}) {
  return {
    localPath: root,
    server: server(),
    entries,
    confirm: true,
    pathConfirmed: true,
    timeoutMs: 1000,
    compression: "none",
    ...extra,
  };
}

test.afterEach(() => {
  __test.setMappedDownloadTransport(null);
});

test("mapped download writes distinct local paths from one tar stream", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-mapped-"));
  keep(root);
  let calls = 0;
  __test.setMappedDownloadTransport((request) => {
    calls += 1;
    assert.equal(request.entries.length, 3);
    assert.deepEqual(request.entries.map((entry) => entry.archiveName), ["mapped/0", "mapped/1", "mapped/2"]);
    assert.match(request.remoteCommand, /python3 -c/);
    assert.match(request.remoteCommand, /tarfile\.open/);
    assert.match(request.remoteCommand, /GNU_FORMAT/);
    assert.doesNotMatch(request.remoteCommand, /-czf|mode='w:gz'/);
    return tarStream([
      { name: "mapped/0", body: "alpha" },
      { name: "mapped/1", body: "beta-file" },
      { name: "mapped/2", body: "gamma" },
    ]);
  });
  const method = __test.createLocalApiMethods()["sync.downloadMappedPaths"];
  const result = await method(baseParams(root, [
    { remotePath: "simple_cluster/results/run-a/metrics.csv", localRelativePath: "experiments/results/formal/run-a.csv" },
    { remotePath: "simple_cluster/results/run-b/summary.json", localRelativePath: "experiments/results/formal/nested/run-b.json" },
    { remotePath: "work_dirs/other/log.txt", localRelativePath: "notes/other.txt" },
  ]));
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.fileCount, 3);
  assert.equal(result.streamCount, 1);
  assert.equal(result.sshCount, 1);
  assert.equal(result.byteCount, "alpha".length + "beta-file".length + "gamma".length);
  assert.equal(fs.readFileSync(path.join(root, "experiments", "results", "formal", "run-a.csv"), "utf8"), "alpha");
  assert.equal(fs.readFileSync(path.join(root, "experiments", "results", "formal", "nested", "run-b.json"), "utf8"), "beta-file");
  assert.equal(fs.readFileSync(path.join(root, "notes", "other.txt"), "utf8"), "gamma");
  assert.equal(result.entries[0].remotePath.includes("run-a"), true);
  assert.equal(result.entries[0].localRelativePath.includes("run-a.csv"), true);
});

test("mapped download rejects unsafe entries before opening a stream", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-mapped-reject-"));
  keep(root);
  let calls = 0;
  __test.setMappedDownloadTransport(() => { calls += 1; return tarStream([]); });
  const method = __test.createLocalApiMethods()["sync.downloadMappedPaths"];
  const good = { remotePath: "results/a.csv", localRelativePath: "out/a.csv" };
  await assert.rejects(method(baseParams(root, [{ remotePath: "/etc/passwd", localRelativePath: "out/a.csv" }])), /相对文件路径/);
  await assert.rejects(method(baseParams(root, [{ remotePath: "results/../secret.csv", localRelativePath: "out/a.csv" }])), /越界/);
  await assert.rejects(method(baseParams(root, [good, { remotePath: "results/b.csv", localRelativePath: "out/A.csv" }])), /本机路径重复/);
  await assert.rejects(method(baseParams(root, [{ remotePath: "weights/model.pt", localRelativePath: "out/model.pt" }], { metricsOnly: true })), /权重/);
  await assert.rejects(method(baseParams(root, [{ remotePath: "results/a.csv", localRelativePath: "out/a.csv", bytes: 999 }], { maxFileBytes: 10 })), /单文件上限/);
  await assert.rejects(method({ ...baseParams(root, [good]), confirm: false }), (error) => error.apiCode === 2001);
  assert.equal(calls, 0);
});

test("mapped download blocks an existing symlink before any write", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-mapped-link-"));
  keep(root);
  const outside = path.join(path.dirname(root), `outside-dir-${path.basename(root)}`);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "a.csv"), "untouched");
  fs.symlinkSync(outside, path.join(root, "out"), "junction");
  let calls = 0;
  __test.setMappedDownloadTransport(() => { calls += 1; return tarStream([{ name: "mapped/0", body: "nope" }]); });
  const method = __test.createLocalApiMethods()["sync.downloadMappedPaths"];
  await assert.rejects(method(baseParams(root, [
    { remotePath: "results/a.csv", localRelativePath: "out/a.csv" },
  ], { overwrite: true })), /符号链接/);
  assert.equal(calls, 0);
  assert.equal(fs.readFileSync(path.join(outside, "a.csv"), "utf8"), "untouched");
});

test("mapped download refuses an untrusted tar path and does not create it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-mapped-tar-"));
  keep(root);
  __test.setMappedDownloadTransport(() => tarStream([
    { name: "results/a.csv", body: "escaped" },
  ]));
  const method = __test.createLocalApiMethods()["sync.downloadMappedPaths"];
  await assert.rejects(method(baseParams(root, [
    { remotePath: "results/a.csv", localRelativePath: "safe/a.csv" },
  ])), /映射校验/);
  assert.equal(fs.existsSync(path.join(root, "results", "a.csv")), false);
  assert.equal(fs.existsSync(path.join(root, "safe", "a.csv")), false);
});

test("mapped download reports a truncated stream without claiming completion", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-mapped-fail-"));
  keep(root);
  __test.setMappedDownloadTransport(() => tarStream([
    { name: "mapped/0", body: "only-one" },
  ]));
  const method = __test.createLocalApiMethods()["sync.downloadMappedPaths"];
  const error = await method(baseParams(root, [
    { remotePath: "results/a.csv", localRelativePath: "out/a.csv" },
    { remotePath: "results/b.csv", localRelativePath: "out/b.csv" },
  ])).then(() => { throw new Error("expected rejection"); }, (value) => value);
  assert.match(String(error.message), /阶段：解包/);
  assert.equal(error.ok, undefined);
  assert.equal(fs.existsSync(path.join(root, "out", "a.csv")), false);
  assert.equal(fs.readFileSync(error.partialResiduals[0], "utf8"), "only-one");
  assert.equal(fs.existsSync(path.join(root, "out", "b.csv")), false);
});

test("mapped download cancel stops before claiming the batch finished", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-mapped-cancel-"));
  keep(root);
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(listener) { this.listener = listener; },
  };
  __test.setMappedDownloadTransport(() => {
    token.isCancellationRequested = true;
    if (token.listener) token.listener();
    return tarStream([
      { name: "mapped/0", body: "first" },
      { name: "mapped/1", body: "second" },
    ]);
  });
  const method = __test.createLocalApiMethods()["sync.downloadMappedPaths"];
  await assert.rejects(method(baseParams(root, [
    { remotePath: "results/a.csv", localRelativePath: "out/a.csv" },
    { remotePath: "results/b.csv", localRelativePath: "out/b.csv" },
  ], { token })), /取消/);
});

test("mapped download overwrites an existing regular file only after overwrite is set", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-mapped-overwrite-"));
  keep(root);
  fs.mkdirSync(path.join(root, "out"));
  fs.writeFileSync(path.join(root, "out", "a.csv"), "old");
  __test.setMappedDownloadTransport(() => tarStream([{ name: "mapped/0", body: "new" }]));
  const method = __test.createLocalApiMethods()["sync.downloadMappedPaths"];
  const entries = [{ remotePath: "results/a.csv", localRelativePath: "out/a.csv" }];
  await assert.rejects(method(baseParams(root, entries)), /未确认覆盖/);
  assert.equal(fs.readFileSync(path.join(root, "out", "a.csv"), "utf8"), "old");
  const result = await method(baseParams(root, entries, { overwrite: true }));
  assert.equal(result.fileCount, 1);
  assert.equal(fs.readFileSync(path.join(root, "out", "a.csv"), "utf8"), "new");
});

test("interrupted SSH stream settles while the reader is waiting for bytes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-mapped-hang-"));
  keep(root);
  fs.mkdirSync(path.join(root, "out"));
  fs.writeFileSync(path.join(root, "out", "a.csv"), "last-good");
  const header = tarHeader("mapped/0", 8);
  const { PassThrough } = require("node:stream");
  const stdout = new PassThrough();
  const plan = __test.normalizeMappedDownloadEntries({
    compression: "none",
    entries: [{ remotePath: "results/a.csv", localRelativePath: "out/a.csv" }],
  });
  const sftp = { host: "worker-a", username: "research", remotePath: "/projects/demo", port: 22 };
  const method = __test.createLocalApiMethods()["sync.downloadMappedPaths"];
  __test.setMappedDownloadTransport(() => __test.openMappedDownloadStream({
    sftp,
    plan,
    localPath: root,
    timeoutMs: 5000,
    spawnImpl: () => {
      const handlers = {};
      queueMicrotask(() => {
        stdout.write(header);
        setTimeout(() => { if (handlers.close) handlers.close(73, null); }, 30);
      });
      return {
        stdin: new PassThrough(),
        stdout,
        stderr: new PassThrough(),
        kill() {},
        on(event, listener) { handlers[event] = listener; return this; },
      };
    },
  }));
  const started = Date.now();
  const error = await method(baseParams(root, [
    { remotePath: "results/a.csv", localRelativePath: "out/a.csv" },
  ], { overwrite: true })).then(() => { throw new Error("expected rejection"); }, (value) => value);
  assert.ok(Date.now() - started < 3000);
  assert.equal(error.stage, "transfer");
  assert.match(String(error.message), /73/);
  assert.equal(fs.readFileSync(path.join(root, "out", "a.csv"), "utf8"), "last-good");
  assert.ok(Array.isArray(error.partialResiduals) && error.partialResiduals.length === 1);
  assert.equal(fs.existsSync(error.partialResiduals[0]), true);
});

test("nonzero SSH exit after a valid tar rejects with transfer stage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-mapped-ssh-"));
  keep(root);
  const payload = tarStream([{ name: "mapped/0", body: "kept-out" }]);
  const chunks = [];
  for await (const chunk of payload) chunks.push(chunk);
  const method = __test.createLocalApiMethods()["sync.downloadMappedPaths"];
  let sshCalls = 0;
  const started = Date.now();
  const plan = __test.normalizeMappedDownloadEntries({
    compression: "none",
    entries: [{ remotePath: "results/a.csv", localRelativePath: "out/a.csv" }],
  });
  const sftp = { host: "worker-a", username: "research", remotePath: "/projects/demo", port: 22 };
  __test.setMappedDownloadTransport(() => __test.openMappedDownloadStream({
    sftp,
    plan,
    localPath: root,
    timeoutMs: 1000,
    spawnImpl: () => {
      sshCalls += 1;
      return fakeSsh(chunks, 73, { stderr: "remote file missing\n" });
    },
  }));
  await assert.rejects(method(baseParams(root, [
    { remotePath: "results/a.csv", localRelativePath: "out/a.csv" },
  ])), (error) => error.stage === "transfer" && /73/.test(String(error.message)));
  assert.equal(sshCalls, 1);
  assert.ok(Date.now() - started < 5000);
  assert.equal(fs.existsSync(path.join(root, "out", "a.csv")), false);
});

test("success waits for SSH exit after the tar trailer", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-mapped-wait-"));
  keep(root);
  const payload = tarStream([{ name: "mapped/0", body: "ready" }]);
  const chunks = [];
  for await (const chunk of payload) chunks.push(chunk);
  let proc;
  __test.setMappedDownloadTransport(() => {
    throw new Error("use spawn");
  });
  const plan = __test.normalizeMappedDownloadEntries({
    compression: "none",
    entries: [{ remotePath: "results/a.csv", localRelativePath: "out/a.csv" }],
  });
  const sftp = { host: "worker-a", username: "research", remotePath: "/projects/demo", port: 22 };
  __test.setMappedDownloadTransport(() => __test.openMappedDownloadStream({
    sftp,
    plan,
    localPath: root,
    timeoutMs: 5000,
    spawnImpl: () => {
      proc = fakeSsh(chunks, 0, { holdClose: true });
      return proc;
    },
  }));
  const method = __test.createLocalApiMethods()["sync.downloadMappedPaths"];
  let settled = false;
  const pending = method(baseParams(root, [
    { remotePath: "results/a.csv", localRelativePath: "out/a.csv" },
  ])).then((result) => { settled = true; return result; });
  try {
    const deadline = Date.now() + 1500;
    let staged = [];
    while (Date.now() < deadline) {
      if (fs.existsSync(path.join(root, "out"))) staged = fs.readdirSync(path.join(root, "out")).filter((name) => name.includes(".simple-sftp-partial-"));
      if (staged.length === 1 && fs.readFileSync(path.join(root, "out", staged[0]), "utf8") === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(settled, false);
    assert.equal(fs.existsSync(path.join(root, "out", "a.csv")), false);
    assert.equal(staged.length, 1);
    assert.equal(fs.readFileSync(path.join(root, "out", staged[0]), "utf8"), "ready");
  } finally {
    if (proc) proc.emitClose(0);
  }
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.fileCount, 1);
});

test("API cancel during the real SSH stream kills that one child", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-mapped-live-cancel-"));
  keep(root);
  const { PassThrough } = require("node:stream");
  const stdout = new PassThrough();
  let killed = 0;
  let sshCalls = 0;
  let sshProc;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(listener) {
      this.listener = listener;
      if (this.ready) this.ready();
    },
  };
  const operationId = `mapped-cancel-${Date.now()}`;
  const plan = __test.normalizeMappedDownloadEntries({
    compression: "none",
    entries: [
      { remotePath: "results/a.csv", localRelativePath: "out/a.csv" },
      { remotePath: "results/b.csv", localRelativePath: "out/b.csv" },
    ],
  });
  const sftp = { host: "worker-a", username: "research", remotePath: "/projects/demo", port: 22 };
  __test.setMappedDownloadTransport(() => __test.openMappedDownloadStream({
    sftp,
    plan,
    localPath: root,
    timeoutMs: 5000,
    token,
    spawnImpl: () => {
      sshCalls += 1;
      const handlers = new Map();
      sshProc = {
        stdin: new PassThrough(),
        stdout,
        stderr: new PassThrough(),
        kill() { killed += 1; },
        on(event, listener) {
          const listeners = handlers.get(event) || [];
          listeners.push(listener); handlers.set(event, listeners);
          return this;
        },
        once(event, listener) { return this.on(event, listener); },
      };
      sshProc.emitClose = (code = null, signal = "SIGTERM") => { for (const listener of handlers.get("close") || []) listener(code, signal); };
      return sshProc;
    },
  }));
  const methods = __test.createLocalApiMethods();
  const method = methods["sync.downloadMappedPaths"];
  const pending = method(baseParams(root, [
    { remotePath: "results/a.csv", localRelativePath: "out/a.csv" },
    { remotePath: "results/b.csv", localRelativePath: "out/b.csv" },
  ], { token, _operationId: operationId }));
  await new Promise((resolve) => { token.ready = resolve; });
  const cancellation = await methods["transfers.cancel"]({ operationId });
  assert.equal(cancellation.status, "cancelling");
  assert.equal(cancellation.settled, false);
  assert.equal(sshCalls, 1);
  assert.equal(killed, 1);
  assert.equal(__test.listActiveTransfers().some((transfer) => transfer.operation === "映射批量下载"), true);
  const beforeExit = await methods["transfers.list"]({});
  assert.equal(beforeExit.settledOperations.some((row) => row.operationId === operationId), false);
  const rejected = assert.rejects(pending, /取消|阶段：transfer/);
  sshProc.emitClose();
  await rejected;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(__test.listActiveTransfers().some((transfer) => transfer.operation === "映射批量下载"), false);
  const afterExit = await methods["transfers.list"]({});
  assert.equal(afterExit.settledOperations.some((row) => row.operationId === operationId && row.status === "settled"), true);
});

test("ancestor junction swapped after the first file is rejected before the second write", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-mapped-swap-"));
  keep(root);
  const outside = path.join(path.dirname(root), `outside-${path.basename(root)}`);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "b.csv"), "outside-original");
  const payload = tarStream([
    { name: "mapped/0", body: "first" },
    { name: "mapped/1", body: "second" },
  ]);
  payload.sshExit = Promise.resolve({ sshCode: 0 });
  __test.setMappedDownloadTransport(() => payload);
  const method = __test.createLocalApiMethods()["sync.downloadMappedPaths"];
  const originalRename = fs.renameSync;
  fs.renameSync = function patched(from, to) {
    const result = originalRename.call(fs, from, to);
    if (String(to).endsWith(`${path.sep}a.csv`)) {
      const nested = path.join(root, "nested");
      originalRename(nested, `${nested}-moved`);
      fs.symlinkSync(outside, nested, "junction");
    }
    return result;
  };
  try {
    await assert.rejects(method(baseParams(root, [
      { remotePath: "results/a.csv", localRelativePath: "nested/a.csv" },
      { remotePath: "results/b.csv", localRelativePath: "nested/b.csv" },
    ])), /符号链接|越出项目根目录/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(path.join(outside, "b.csv"), "utf8"), "outside-original");
  assert.equal(fs.existsSync(path.join(outside, "a.csv")), false);
});

test("truncated stream keeps the previous destination and reports the partial sibling", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-mapped-preserve-"));
  keep(root);
  fs.mkdirSync(path.join(root, "out"));
  fs.writeFileSync(path.join(root, "out", "a.csv"), "last-good");
  const header = tarHeader("mapped/0", 4);
  const { Readable } = require("node:stream");
  __test.setMappedDownloadTransport(() => Readable.from([header, Buffer.from("no")]));
  const method = __test.createLocalApiMethods()["sync.downloadMappedPaths"];
  const error = await method(baseParams(root, [
    { remotePath: "results/a.csv", localRelativePath: "out/a.csv" },
  ], { overwrite: true })).then(() => { throw new Error("expected rejection"); }, (value) => value);
  assert.match(String(error.message), /阶段：解包/);
  assert.equal(fs.readFileSync(path.join(root, "out", "a.csv"), "utf8"), "last-good");
  assert.ok(Array.isArray(error.partialResiduals) && error.partialResiduals.length === 1);
  assert.equal(fs.existsSync(error.partialResiduals[0]), true);
  assert.equal(fs.existsSync(error.partialResiduals[0]), true);
  assert.equal(path.basename(error.partialResiduals[0]).includes(".simple-sftp-partial-"), true);
});

test("remote mapped script checks the file list before writing a tar", () => {
  const script = __test.createMappedDownloadScript("/projects/demo", __test.normalizeMappedDownloadEntries({
    entries: [{ remotePath: "results/a.csv", localRelativePath: "out/a.csv" }],
  }));
  assert.match(script, /os\.path\.islink/);
  assert.match(script, /maxFileBytes/);
  assert.match(script, /SystemExit\(73\)/);
  assert.match(script, /mode='w\|'/);
  assert.doesNotMatch(script, /os\.walk/);
});

test("cross-Plan metrics download uses one gzip stream and waits for decompression before publishing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-mapped-gzip-"));
  keep(root);
  const entries = [
    { remotePath: "results/plan-a/raw.csv", localRelativePath: "out/a.csv" },
    { remotePath: "results/plan-b/raw.csv", localRelativePath: "out/b.csv" },
  ];
  const params = baseParams(root, entries, { compression: "auto" });
  const plan = __test.normalizeMappedDownloadEntries(params);
  let streams = 0;
  __test.setMappedDownloadTransport(async ({ remoteCommand }) => {
    assert.match(remoteCommand, /gzip\.GzipFile/);
    const chunks = [];
    for await (const chunk of tarStream([{ name: "mapped/0", body: "latest-a" }, { name: "mapped/1", body: "latest-b" }])) chunks.push(chunk);
    streams++;
    return __test.openMappedDownloadStream({
      sftp: server(), plan, localPath: root,
      spawnImpl: () => fakeSsh([require("node:zlib").gzipSync(Buffer.concat(chunks))], 0),
    });
  });
  const result = await __test.createLocalApiMethods()["sync.downloadMappedPaths"](params);
  assert.equal(streams, 1);
  assert.equal(result.compression, "gzip");
  assert.equal(result.fileCount, 2);
  assert.equal(fs.readFileSync(path.join(root, "out/a.csv"), "utf8"), "latest-a");
  assert.equal(fs.readFileSync(path.join(root, "out/b.csv"), "utf8"), "latest-b");
});

test("a truncated gzip footer fails without replacing the current metrics file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-mapped-gzip-truncated-"));
  keep(root);
  fs.mkdirSync(path.join(root, "out"));
  fs.writeFileSync(path.join(root, "out/a.csv"), "last-good", "utf8");
  const params = baseParams(root, [{ remotePath: "results/a.csv", localRelativePath: "out/a.csv" }], { compression: "gzip", overwrite: true });
  const plan = __test.normalizeMappedDownloadEntries(params);
  __test.setMappedDownloadTransport(async () => {
    const chunks = [];
    for await (const chunk of tarStream([{ name: "mapped/0", body: "new" }])) chunks.push(chunk);
    const compressed = require("node:zlib").gzipSync(Buffer.concat(chunks));
    return __test.openMappedDownloadStream({
      sftp: server(), plan, localPath: root,
      spawnImpl: () => fakeSsh([compressed.subarray(0, compressed.length - 8)], 0),
    });
  });
  await assert.rejects(__test.createLocalApiMethods()["sync.downloadMappedPaths"](params), /unexpected end|打包流|解包/);
  assert.equal(fs.readFileSync(path.join(root, "out/a.csv"), "utf8"), "last-good");
});
