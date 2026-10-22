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
// Linux 门禁无 AppData 写权限：把租约根指到本测试进程的临时目录（仅改环境变量，不改生产代码）。
process.env.APPDATA = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "simple-sftp-gate-lease-"));
const { __test } = require("../extension.js");
Module._load = originalLoad;
const { createTransferHarness } = require("./_helpers/supportedHostPlatform");

test("cross-Plan paths use one gzip archive and preserve verification", async () => {
  const files = Array.from({ length: 120 }, (_, index) => `work_dirs/${index % 2 ? "ebmc" : "cpsc"}/attempts/current/${index}.log`);
  let copies = 0;
  // Force different destination hashes on the initial inspection only.
  let destinationInspections = 0;
  // 隔离夹具：win32 批量命令通道作为沙箱内显式事实注入（非真实进程平台），
  // 真实 macOS 内存转发分支由 macRelay 专项覆盖，真实 Windows 通道由 host_windows 在真机执行。
  const { sandbox } = createTransferHarness({
    platform: "win32",
    batch: async (target, command, requested) => {
      assert.match(command, /tar --null -T - -cvf -/);
      copies++; assert.match(command, /gzip -dc/); assert.match(command, /pigz -p 2 -6 -c/);
      // 夹具在隔离 vm realm 内构造数组，比较前规范化为宿主 realm 数组（仅去 realm 差异，不改断言语义）。
      assert.deepEqual(Array.from(requested), files.slice().sort()); return "";
    },
    fpsync: { inspect: async (target, paths) => {
      destinationInspections += target.host === "destination" ? 1 : 0;
      const hash = target.host === "destination" && destinationInspections === 1 ? "b".repeat(64) : "a".repeat(64);
      return { files: Object.fromEntries(paths.map(file => [file, hash])) };
    } },
  });
  const result = await sandbox.syncServerToServerFpsyncCore({
    source: { host: "source", port: 22, username: "researcher", remotePath: "/project" },
    destination: { host: "destination", port: 22, username: "researcher", remotePath: "/project" },
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
