const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  return request === "vscode" ? {
    TreeItem: class {},
    ProgressLocation: { Notification: 1 },
    window: { withProgress: (_options, operation) => operation({ report: () => undefined }) },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  } : originalLoad.call(this, request, ...args);
};
const { __test } = require("../extension.js");
Module._load = originalLoad;

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function endpoint(host) {
  return { host, user: "research", remotePath: "/projects/demo", port: 22 };
}

function hashesFor(names, overrides = {}) {
  return Object.fromEntries(names.map((name) => [name, overrides[name] || sha256(name)]));
}

function installTransport(handler) {
  __test.setRemoteBatchTransport(handler);
}

test.afterEach(() => {
  __test.setRemoteBatchTransport(null);
});

test("first packed group reports before the batch finishes and completion waits for verification", async () => {
  const messages = [];
  const reports = [];
  const names = ["runs/a.log", "runs/last_checkpoint.pth", "runs/steady.bin"];
  let tarCalls = 0;
  let releaseTar;
  const tarGate = new Promise((resolve) => { releaseTar = resolve; });
  let sawStartBeforeRelease = false;
  let packedStarted;
  const started = new Promise((resolve) => { packedStarted = resolve; });
  installTransport(async (source, command, paths) => {
    if (/tar --null -T - -cvf -/.test(command)) {
      tarCalls += 1;
      if (!sawStartBeforeRelease) sawStartBeforeRelease = messages.some((message) => message.includes("正在流处理（打包、传输与解包）"));
      packedStarted();
      await tarGate;
      return "";
    }
    const requested = paths.filter(Boolean);
    if (source.host === "target-b" && !messages.some((message) => message.includes("正在校验目标 Worker"))) {
      return JSON.stringify({ files: Object.fromEntries(requested.map((name) => [name, sha256(`old-${name}`)])), cacheHits: 0, cacheRehash: requested.length, digestReads: requested.length, cacheQueries: requested.length });
    }
    return JSON.stringify({ files: hashesFor(requested), cacheHits: 0, cacheRehash: requested.length, digestReads: requested.length, cacheQueries: requested.length });
  });
  const pending = __test.syncServerToServerFpsyncCore({
    source: endpoint("source-a"),
    destination: endpoint("target-b"),
    relativePaths: names,
    confirm: true,
    pathConfirmed: true,
    timeoutMs: 1000,
  }, { report: (event) => { messages.push(event.message); reports.push(event); } });
  await started;
  assert.equal(sawStartBeforeRelease, true);
  assert.equal(messages.some((message) => message.startsWith("完成：")), false);
  assert.equal(reports.reduce((sum, event) => sum + (event.increment || 0), 0), 0);
  assert.ok(tarCalls >= 1 && tarCalls <= 4);
  releaseTar();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.transferredFiles, 3);
  assert.equal(result.verification, "sha256");
  assert.match(messages.at(-1), /^完成：传输 3\/3 个文件，SHA256 校验通过 · 清单 \d+ ms · 流处理 \d+ ms · 校验 \d+ ms$/);
  assert.equal(result.timing.streamPhase, "pack+network+unpack");
  assert.ok(result.timing.inventoryMs >= 0 && result.timing.streamMs >= 0 && result.timing.verifyMs >= 0);
  assert.equal(messages.some((message) => message.includes("正在流处理（打包、传输与解包）")), true);
  assert.equal(messages.some((message) => /流处理结束（\d+ ms，含打包、传输与解包）/.test(message)), true);
  const increments = reports.map((event) => event.increment || 0);
  assert.equal(increments.every((value) => value >= 0), true);
  assert.equal(increments.reduce((sum, value) => sum + value, 0), 100);
  const startAt = messages.findIndex((message) => message.includes("正在流处理（打包、传输与解包）"));
  const verifyAt = messages.findIndex((message) => message.includes("正在校验目标 Worker"));
  const doneAt = messages.findIndex((message) => message.startsWith("完成："));
  assert.ok(startAt >= 0 && startAt < verifyAt && verifyAt < doneAt);
  assert.equal(reports[verifyAt].increment > 0, true);
  assert.equal(reports[doneAt].increment > 0, true);
});

test("transfer keeps at most two live groups for 33 and 355 files", async () => {
  for (const count of [1, 33, 355]) {
    let live = 0;
    let maxLive = 0;
    const events = [];
    installTransport(async () => {
      live += 1;
      maxLive = Math.max(maxLive, live);
      await new Promise((resolve) => setTimeout(resolve, 15));
      live -= 1;
      return "";
    });
    const paths = Array.from({ length: count }, (_, index) => `runs/${index}.log`);
    const partitions = await __test.transferPartitionedTar(endpoint("source-a"), endpoint("target-b"), paths, 1000, (event) => events.push(event));
    const expected = count <= 80 ? 1 : 2;
    assert.equal(partitions, expected);
    assert.ok(maxLive >= 1 && maxLive <= 2);
    assert.equal(events[0].phase, "start");
    assert.equal(events.filter((event) => event.phase === "start").length, expected);
    assert.equal(events.some((event) => !event.groupFiles), false);
  }
});

test("one group failure settles live streams and skips later groups", async () => {
  const paths = Array.from({ length: 200 }, (_, index) => `runs/${index}.log`);
  let started = 0;
  const events = [];
  installTransport(async () => {
    const mine = ++started;
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (mine === 1) {
      const error = new Error("跨 Worker 无压缩打包传输失败（退出码 9）：tar: group failed");
      error.exitCode = 9;
      error.stage = "无压缩打包传输";
      throw error;
    }
    return "";
  });
  await assert.rejects(__test.transferPartitionedTar(endpoint("source-a"), endpoint("target-b"), paths, 1000, (event) => events.push(event)), /group failed/);
  assert.ok(started <= 4);
  assert.equal(events.some((event) => event.phase === "done"), false);
});

test("a throwing progress callback rejects after live workers settle", async () => {
  const paths = Array.from({ length: 200 }, (_, index) => `runs/${index}.log`);
  let started = 0;
  let finished = 0;
  installTransport(async () => {
    started += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    finished += 1;
    return "";
  });
  await assert.rejects(__test.transferPartitionedTar(endpoint("source-a"), endpoint("target-b"), paths, 1000, (event) => {
    if (event.phase === "done") throw new Error("progress callback failed");
  }), /progress callback failed/);
  assert.equal(finished, started);
  assert.ok(started >= 1 && started <= 4);
});

test("verification mismatch and persistent checkpoint change do not report success", async () => {
  const names = ["runs/last_checkpoint.pth"];
  const messages = [];
  installTransport(async (_source, command, paths) => {
    if (/tar --null/.test(command)) return "";
    const found = hashesFor(paths);
    if (messages.some((message) => message.includes("正在校验目标 Worker"))) found[names[0]] = sha256("other-version");
    return JSON.stringify({ files: found, cacheHits: 0, cacheRehash: paths.length, digestReads: paths.length, cacheQueries: paths.length });
  });
  await assert.rejects(__test.syncServerToServerFpsyncCore({
    source: endpoint("source-a"),
    destination: endpoint("target-b"),
    relativePaths: names,
    confirm: true,
    pathConfirmed: true,
    timeoutMs: 1000,
  }, { report: (event) => messages.push(event.message) }), /SHA256 不一致/);
  assert.equal(messages.some((message) => message.startsWith("完成：")), false);

  messages.length = 0;
  installTransport(async (_source, command) => {
    if (/python3 -c/.test(command)) {
      const error = new Error("跨 Worker 内容清单失败（退出码 1）：ValueError: file changed during batch sync: runs/last_checkpoint.pth");
      error.exitCode = 1;
      error.stage = "内容清单";
      throw error;
    }
    throw new Error("tar must not start");
  });
  await assert.rejects(__test.syncServerToServerFpsyncCore({
    source: endpoint("source-a"),
    destination: endpoint("target-b"),
    relativePaths: names,
    confirm: true,
    pathConfirmed: true,
    timeoutMs: 1000,
  }, { report: (event) => messages.push(event.message) }), (error) => error.exitCode === 1 && /file changed during batch sync/.test(error.message) && /内容清单/.test(error.message));
  assert.equal(messages.some((message) => message.startsWith("完成：")), false);
  assert.equal(messages.some((message) => message.includes("正在流处理（打包、传输与解包）")), false);
});

test("diagnostic ring handles split UTF-8, malformed telemetry and unterminated bounded errors", () => {
  const log = __test.transferErrorLog(["work/latest/model.pth"]);
  const input = Buffer.from('work/latest/model.pth\nSIMPLE_PROGRESS {"phase":"unpacking","processedBytes":10}\nValueError: 检查点偏移无效\nSIMPLE_COMPRESSION_WIRE 10\nSIMPLE_PROGRESS broken\n', "utf8");
  for (const byte of input) log.receive(Buffer.from([byte]));
  assert.equal(log.text(), "ValueError: 检查点偏移无效\nSIMPLE_PROGRESS broken");
  const oversized = __test.transferErrorLog();
  oversized.receive(Buffer.from("x".repeat(100000)));
  assert.ok(oversized.text().length <= 4096);
  const progressOnly = __test.transferErrorLog();
  progressOnly.receive(Buffer.from("SIMPLE_CHUNK_VERIFIED 10\nSIMPLE_STAGE_COMMITTED .simple-sftp-stage-0f\n"));
  assert.equal(progressOnly.text(), "");
});

test("nonzero pack exit keeps the stage, stderr, and exit code", async () => {
  const childProcess = require("node:child_process");
  const realSpawn = childProcess.spawn;
  childProcess.spawn = () => {
    const child = new (require("node:events").EventEmitter)();
    const handlers = {};
    return Object.assign(child, {
      stdout: { on() {} },
      stderr: { on(event, fn) { if (event === "data") handlers.stderr = fn; } },
      stdin: { on() {}, end() { queueMicrotask(() => { if (handlers.stderr) {
        handlers.stderr(Buffer.from("tar: refused\n"));
        for (let index = 0; index < 1000; index++) handlers.stderr(Buffer.from(`SIMPLE_PROGRESS {"phase":"unpacking","processedBytes":${index},"processedFiles":0}\nSIMPLE_CHUNK_VERIFIED ${index}\nSIMPLE_COMPRESSION_WIRE ${index}\n`));
      } child.emit("close", 23); }); } },
      kill() {},
    });
  };
  const extensionPath = require.resolve("../extension.js");
  delete require.cache[extensionPath];
  Module._load = function (request, ...args) {
    return request === "vscode" ? {
      TreeItem: class {},
      ProgressLocation: { Notification: 1 },
      window: { withProgress: (_options, operation) => operation({ report: () => undefined }) },
      workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    } : originalLoad.call(this, request, ...args);
  };
  try {
    const fresh = require("../extension.js");
    await assert.rejects(fresh.__test.transferPartitionedTar(endpoint("source-a"), endpoint("target-b"), ["runs/steady.bin"], 0, () => {}), (error) => {
      assert.doesNotMatch(error.message + error.stderr, /SIMPLE_PROGRESS|SIMPLE_CHUNK_VERIFIED|SIMPLE_COMPRESSION_WIRE/);
      assert.ok(error.message.length < 5000);
      return error.exitCode === 23 && error.stage === "压缩打包传输" && /tar: refused/.test(error.stderr) && /压缩打包传输失败（退出码 23）/.test(error.message);
    });
  } finally {
    childProcess.spawn = realSpawn;
    delete require.cache[extensionPath];
    Module._load = originalLoad;
  }
});

function probeHash(mode, script, args, stdin = "", cacheDir) {
  const python = process.platform === "win32" ? "python" : "python3";
  const run = spawnSync(python, [path.join(__dirname, "hash_probe.py"), mode, ...args], {
    input: script,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
    env: {
      ...process.env,
      SIMPLE_SFTP_HASH_STDIN: stdin,
      SIMPLE_SFTP_HASH_CACHE_DIR: cacheDir || path.join(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "simple-sftp-probe-")), "empty-cache"),
    },
  });
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
  return run;
}

test("stable files hash without a per-file sleep and a changing file stays bounded", () => {
  const root = path.resolve(__dirname, "..");
  const names = ["package.json", "readme.md"];
  const expected = Object.fromEntries(names.map((name) => [name, { sha256: sha256(fs.readFileSync(path.join(root, name))), size: fs.statSync(path.join(root, name)).size }]));
  const stable = probeHash("stable", __test.batchFileHashScript(), [root, "2", "0.01"], `${names.join("\n")}\n`);
  assert.deepEqual(JSON.parse(stable.stdout).files, expected);
  assert.match(stable.stderr, /sleeps=0/);
  const raced = probeHash("race-read", __test.batchFileHashScript(), [root, "2", "0.01"], "package.json\n");
  assert.deepEqual(JSON.parse(raced.stdout).files["package.json"], expected["package.json"]);
  assert.match(raced.stderr, /sleeps=[1-9]/);
  const changing = probeHash("changing-stat", __test.batchFileHashScript(), [root, "0.05", "0.01"], "package.json\n");
  assert.match(changing.stdout, /rejected ValueError: file changed during batch sync: package\.json/);
  assert.match(changing.stderr, /sleeps=[1-9]/);
  const scope = probeHash("stable", __test.scopeInventoryScript(), [root, "package.json", "0", "0", "2", "0.01"]);
  assert.equal(JSON.parse(scope.stdout).files["package.json"].sha256, expected["package.json"].sha256);
  assert.match(scope.stderr, /sleeps=0/);
});
