const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { spawnSync } = require("node:child_process");
const zlib = require("node:zlib");
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  return request === "vscode" ? {
    TreeItem: class {}, ProgressLocation: { Notification: 1 },
    window: { withProgress: (_options, work) => work({ report() {} }) },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  } : originalLoad.call(this, request, ...args);
};
const { __test } = require("../extension.js");
Module._load = originalLoad;
test.afterEach(() => __test.setRemoteBatchTransport(null));

test("cross-Plan paths use one gzip archive and preserve verification", async () => {
  const files = Array.from({ length: 120 }, (_, index) => `work_dirs/${index % 2 ? "ebmc" : "cpsc"}/attempts/current/${index}.log`);
  let copies = 0;
  // Force different destination hashes on the initial inspection only.
  let inspections = 0;
  const handler = async (target, command, requested) => {
    if (/tar --null -T - -cvf -/.test(command)) {
      copies++; assert.match(command, /gzip -dc/); assert.match(command, /pigz -p 2 -6 -c/);
      assert.deepEqual(requested, files.slice().sort()); return "";
    }
    inspections++;
    return JSON.stringify({ files: Object.fromEntries(requested.map(file => [file,
      target.host === "destination" && inspections <= 2 ? "b".repeat(64) : "a".repeat(64)])) });
  };
  __test.setRemoteBatchTransport(handler);
  const result = await __test.syncServerToServerFpsyncCore({
    source: { host: "source", user: "researcher", remotePath: "/project" },
    destination: { host: "destination", user: "researcher", remotePath: "/project" },
    relativePaths: files, compression: "auto", singleStream: true, confirm: true, pathConfirmed: true,
  }, { report() {} });
  assert.equal(copies, 1); assert.equal(result.partitions, 1);
  assert.equal(result.compression, "gzip"); assert.equal(result.verification, "sha256");
});

test("production packing really produces a smaller gzip tar stream without writing archives", () => {
  const git = spawnSync("git", ["--exec-path"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  const shell = process.platform === "win32" ? path.resolve(git.stdout.trim(), "../../..", "bin/bash.exe") : "bash";
  if (process.platform === "win32") assert.ok(fs.existsSync(shell), "Git Bash is required for the stream gate");
  const options = { cwd: path.resolve(__dirname, ".."), input: Buffer.from("readme.md\0package.json\0"), timeout: 10000, windowsHide: true };
  const compressed = spawnSync(shell, ["-c", `set -o pipefail; ${__test.tarPackingCommand("gzip")}`], options);
  assert.equal(compressed.status, 0, compressed.stderr.toString());
  assert.equal(compressed.stdout[0], 0x1f); assert.equal(compressed.stdout[1], 0x8b);
  const raw = zlib.gunzipSync(compressed.stdout);
  const uncompressed = spawnSync(shell, ["-c", `set -o pipefail; ${__test.tarPackingCommand("none")}`], options);
  assert.equal(uncompressed.status, 0, uncompressed.stderr.toString());
  assert.deepEqual(raw, uncompressed.stdout);
  assert.ok(compressed.stdout.length < raw.length);
});

test("none is explicit, invalid compression is rejected, extraction propagates pipeline failures", () => {
  assert.equal(__test.transferCompression({ compression: "none" }), "none");
  assert.throws(() => __test.transferCompression({ compression: "shell;bad" }), /compression/);
  const endpoint = __test.directSyncTarget({ host: "source", user: "researcher", remotePath: "/project" }, "来源");
  const target = { ...endpoint, host: "destination" };
  const none = __test.directTarBatchCommand(endpoint, target, { compression: "none" });
  assert.doesNotMatch(none, /gzip|pigz/);
  assert.equal((__test.directTarBatchCommand(endpoint, target).match(/bash -o pipefail -c/g) || []).length, 2);
});
