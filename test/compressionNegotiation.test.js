const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const original = Module._load;
Module._load = function (name, ...args) { return name === "vscode" ? { TreeItem: class {}, ProgressLocation: { Notification: 1 }, window: { withProgress: (_o, f) => f({ report() {} }) }, workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } } : original.call(this, name, ...args); };
const { __test: api } = require("../extension");
Module._load = original;
const source = { host: "source", username: "user", port: 22, remotePath: "/project" };
const target = { ...source, host: "target" };
const sample = { sampleBytes: 65536, sampleMs: 10, gzip: { bytes: 1000, cpuMs: 0.3, wallMs: 0.3 }, zstd: { bytes: 700, cpuMs: 0.1, wallMs: 0.1 } };
test.afterEach(() => { api.setCompressionProbeTransport(null); api.setRemoteBatchTransport(null); api.compressionHistory.rows.clear(); });

test("large files resume a verified block using one compressed stream with bounded frames", async () => {
  let statusCalls = 0, streams = 0;
  api.setRemoteBatchTransport(async (endpoint, command, paths, _timeout, options) => {
    assert.deepEqual(paths, []);
    assert.doesNotMatch(command, /tar --null|rm -rf|os\.unlink\(/);
    if (endpoint.host === target.host) {
      assert.equal(options.remoteMutation, true);
      assert.equal(options.stage, "核验分块检查点");
      statusCalls++; return JSON.stringify({ offset: 8 * 1024 * 1024, chunkBytes: 8 * 1024 * 1024 });
    }
    streams++;
    assert.match(command, /gzip -6 -c/);
    assert.match(command, /gzip -dc/);
    assert.match(command, /simple_sftp_staged_receive/);
    assert.equal(options.stage, "压缩分块传输");
    assert.ok(Buffer.byteLength(command, "utf8") < 24000);
    return JSON.stringify({ completed: true });
  });
  const name = "work/latest/model.pth";
  await api.transferChunkedServerFile(source, target, name, 5000, { compression: "gzip", expectedFiles: { [name]: { size: 256 * 1024 * 1024, sha256: "a".repeat(64) } } });
  assert.equal(statusCalls, 1);
  assert.equal(streams, 1);
  await assert.rejects(api.transferChunkedServerFile(source, target, name, 5000, { expectedFiles: { [name]: { size: 65 * 1024 ** 3, sha256: "a".repeat(64) } } }), /64GiB/);
});

test("auto negotiates zstd only with destination support and real sample benefit", async () => {
  api.setCompressionProbeTransport(async (_endpoint, command) => command.startsWith("command -v") ? "supported" : JSON.stringify(sample));
  const decision = await api.selectTransferCompression({}, source, target, ["one.csv"], {});
  assert.equal(decision.compression, "zstd");
  assert.equal(decision.measuredLink, false);
  api.setCompressionProbeTransport(async (_endpoint, command) => command.startsWith("command -v") ? "unavailable" : JSON.stringify(sample));
  assert.equal((await api.selectTransferCompression({}, source, target, ["one.csv"], {})).compression, "gzip");
});
test("large-file failure preserves checkpoint rejection, exit code and exact endpoint/file identity", async () => {
  let streams = 0;
  const name = "work/latest/model.pth";
  api.setRemoteBatchTransport(async (endpoint) => {
    if (endpoint.host === target.host) return JSON.stringify({ offset: 8 * 1024 * 1024, chunkBytes: 8 * 1024 * 1024 });
    streams++;
    throw Object.assign(new Error("ValueError: stale or invalid chunk offset"), { exitCode: 1, stage: "压缩分块传输" });
  });
  await assert.rejects(api.transferChunkedServerFile(source, target, name, 5000,
    { compression: "gzip", expectedFiles: { [name]: { size: 256 * 1024 * 1024, sha256: "a".repeat(64) } } }), error => {
      assert.equal(error.exitCode, 1);
      assert.equal(error.stage, "压缩分块传输");
      assert.match(error.message, /work\/latest\/model\.pth.*source → target.*stale or invalid chunk offset/);
      return true;
    });
  assert.equal(streams, 1, "checkpoint failure must not replay or bypass the rejected receiver");
});
test("explicit choices bypass sampling, but explicit zstd still requires both peers", async () => {
  api.setCompressionProbeTransport(() => { throw new Error("no tools"); });
  assert.equal((await api.selectTransferCompression({ compression: "none" }, source, target, ["one.bin"], {})).compression, "none");
  await assert.rejects(api.selectTransferCompression({ compression: "zstd" }, source, target, ["one.bin"], {}));
  await assert.rejects(api.selectTransferCompression({ compression: "zstd" }, source, target, ["one.bin"], {}, true), /不支持 zstd/);
});
test("unavailable sampling safely falls back while cancellation does not start a transfer", async () => {
  api.setCompressionProbeTransport(async () => { throw new Error("missing python"); });
  assert.equal((await api.selectTransferCompression({}, source, target, ["one.csv"], {})).reason, "sample-unavailable");
  await assert.rejects(api.selectTransferCompression({ token: { isCancellationRequested: true } }, source, target, ["one.csv"], {}), /取消/);
});
test("measured link cost selects none and local downloads limit candidates to gzip", async () => {
  api.compressionHistory.record(api.compressionHistory.key(source, target), 1e9, 1000);
  api.setCompressionProbeTransport(async (_endpoint, command) => command.startsWith("command -v") ? "supported" : JSON.stringify({ ...sample, gzip: { bytes: 1000, cpuMs: 15, wallMs: 15 }, zstd: { bytes: 700, cpuMs: 10, wallMs: 10 } }));
  const decision = await api.selectTransferCompression({}, source, target, ["one.csv"], {});
  assert.equal(decision.compression, "none");
  assert.equal(decision.measuredLink, true);
  api.compressionHistory.rows.clear();
  api.setCompressionProbeTransport(async (_endpoint, command) => command.startsWith("command -v") ? "supported" : JSON.stringify(sample));
  assert.equal((await api.selectTransferCompression({}, source, target, ["one.csv"], {}, true)).compression, "gzip");
});
test("full cross-Plan pipeline uses the sampled encoder and keeps hash authority", async () => {
  const files = ["work/a/one.csv", "work/b/two.csv"];
  let inspections = 0, packed = 0;
  api.setCompressionProbeTransport(async (_endpoint, command) => command.startsWith("command -v") ? "supported" : JSON.stringify(sample));
  api.setRemoteBatchTransport(async (endpoint, command, paths) => {
    if (command.includes("tar --null")) {
      packed++;
      assert.match(command, /zstd -T2 -6 -c/);
      assert.match(command, /zstd -dc/);
      assert.match(command, /SIMPLE_COMPRESSION_WIRE/);
      assert.match(command, /simple_sftp_staged_receive/);
      assert.doesNotMatch(command, /rm -rf|os\.rmdir\(|os\.unlink\(/);
      assert.deepEqual(paths, files);
      return "";
    }
    inspections++;
    return JSON.stringify({ files: Object.fromEntries(paths.map(p => [p, { sha256: endpoint.host === "target" && inspections <= 2 ? "b".repeat(64) : "a".repeat(64), size: 10000 }])) });
  });
  const result = await api.syncServerToServerFpsyncCore({ source, destination: target, relativePaths: files, singleStream: true, confirm: true, pathConfirmed: true }, { report() {} });
  assert.equal(packed, 1);
  assert.equal(result.compression, "zstd");
  assert.equal(result.verification, "sha256");
  assert.equal(result.compressionDecision.sampleBytes, 65536);
});
test("manifest argument bytes remain bounded even when file contents are tiny", () => {
  const files = Array.from({ length: 100 }, (_, i) => `${"long/".repeat(400)}${i}.csv`);
  const sizes = Object.fromEntries(files.map(name => [name, 1]));
  const groups = api.partitionTransferPaths(files, 5000, 2, sizes, 128 * 1024 * 1024);
  assert.ok(groups.length > 1);
  assert.deepEqual(groups.flat(), files);
  assert.ok(groups.every(group => group.reduce((n, name) => n + Buffer.byteLength(name) * 2 + 160, 0) <= 48000));
});

test("LAN archives group up to 512 MiB without allocating entire file contents", async () => {
  const files = Array.from({ length: 6 }, (_, index) => `work/current/weight-${index}.pth`);
  const packed = [], progress = [];
  api.setRemoteBatchTransport(async (_endpoint, command, paths) => {
    assert.match(command, /tar --null/);
    packed.push([...paths]);
    if (paths.length > 1) await new Promise(setImmediate);
    return "";
  });
  const partitions = await api.transferPartitionedTar(source, target, files, 5000, row=>progress.push(row), {
    compression: "none", singleStream: true,
    fileSizes: Object.fromEntries(files.map(file => [file, 100 * 1024 * 1024])),
    expectedFiles: Object.fromEntries(files.map(file => [file, {size:100 * 1024 * 1024,sha256:"a".repeat(64)}])),
  });
  assert.equal(partitions,2);
  assert.deepEqual(packed.map(group=>group.length).sort((a,b)=>a-b),[1,5]);
  assert.ok(packed.every(group=>group.length * 100 * 1024 * 1024 <= 512 * 1024 * 1024));
  assert.deepEqual(progress.filter(row=>row.phase==='done').map(row=>row.completedFiles),[1,6],
    'out-of-order parallel groups contribute their actual file counts once');
  assert.equal(progress.at(-1).completed,2);assert.equal(progress.at(-1).totalFiles,6);
});
