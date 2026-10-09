const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { chooseCompression, chooseSampleFiles, CompressionHistory, MAX_SAMPLE_BYTES } = require("../compression-policy");
const sample = (bytes, cpuMs = 0.5) => ({ sampleBytes: 65536, sampleMs: 10, gzip: { bytes, cpuMs, wallMs: cpuMs } });

test("compressible text uses gzip and low-benefit data stays uncompressed", () => {
  assert.equal(chooseCompression(sample(1000), ["gzip"]).compression, "gzip");
  assert.equal(chooseCompression(sample(65570), ["gzip"]).compression, "none");
  assert.equal(chooseCompression(sample(62000), ["gzip"]).compression, "none");
});
test("actual throughput and CPU cost can reverse a compression decision", () => {
  const evidence = sample(5000, 15);
  assert.equal(chooseCompression(evidence, ["gzip"], 1024 * 1024, true).compression, "gzip");
  const fast = chooseCompression(evidence, ["gzip"], 1024 * 1024 * 1024, true);
  assert.equal(fast.compression, "none");
  assert.equal(fast.measuredLink, true);
  assert.equal(chooseCompression(sample(5000, 500), ["gzip"]).compression, "none");
});
test("zstd only participates after both-endpoint negotiation and wins by estimated cost", () => {
  const evidence = { ...sample(3000, 2), zstd: { bytes: 2000, cpuMs: 0.3, wallMs: 0.3 } };
  assert.equal(chooseCompression(evidence, ["gzip"]).compression, "gzip");
  assert.equal(chooseCompression(evidence, ["gzip", "zstd"]).compression, "zstd");
});
test("malformed or excessive sample data never widens memory bounds", () => {
  for (const evidence of [null, {}, { ...sample(1), sampleBytes: MAX_SAMPLE_BYTES + 1 }, { ...sample(1), sampleMs: 99999 }, { ...sample(1), gzip: {} }])
    assert.equal(chooseCompression(evidence, ["gzip"]).compression, "gzip");
  assert.ok(chooseSampleFiles(Array.from({ length: 5000 }, (_, i) => `run/${i}.csv`)).length <= 8);
});
test("link history is endpoint-specific, bounded and expires without sidecar files", () => {
  let now = 1;
  const history = new CompressionHistory(() => now);
  const source = { host: "source", port: 22, username: "user", remotePath: "/project" };
  const first = history.key(source, { host: "one" }), second = history.key(source, { host: "two" });
  assert.notEqual(first, second);
  for (let i = 0; i < 1000; i++) history.record(`${i}`, 65536, 100);
  assert.equal(history.rows.size, 64);
  history.record(first, 65536, 100);
  assert.equal(history.get(first).bytesPerSecond, 655360);
  now += history.ttlMs + 1;
  assert.equal(history.get(first), null);
});
test("real gzip sampler is bounded, read-only and closes all file descriptors", () => {
  const run = spawnSync("python", ["-B", "-X", "utf8", path.join(__dirname, "compression_sample_probe.py")], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /bounded sample verified/);
});
