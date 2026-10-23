const { test, assert, fs, os, path, spawnSync, projectRoot, runner, serial, kept, run } = require("./testSerialOutputPreservation.support.cjs");

test("configured log dir is only a parent: the second run keeps the old log bytes and gets its own run dir", () => {
  const parent = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "b-test-serial-parent-")), "logs");
  const first = run(["testSerialMultiFail.fixture.js"], {}, parent);
  const original = fs.readFileSync(first.logFile);
  const second = run(["testSerialMultiFail.fixture.js"], {}, parent);
  kept.push(path.dirname(parent));
  assert.equal(second.logs, first.logs, "配置父目录本身不变");
  assert.notEqual(second.runDir, first.runDir, "第二次执行必须落在新的 run 目录：" + first.runDir + " vs " + second.runDir);
  assert.notEqual(second.logFile, first.logFile, "两次执行的日志路径必须不同");
  assert.deepEqual(fs.readFileSync(first.logFile), original, "旧失败日志字节必须原样保留，不得被第二次执行覆盖");
  assert.ok(original.length > 200, "旧日志本身必须非空");
  assert.ok(second.log.includes("serial fixture failing gamma"), "新日志也必须完整写入");
});

test("logDirectory always opens a fresh run directory under the configured parent", () => {
  const saved = process.env.SIMPLESFTP_TEST_SERIAL_LOG_DIR;
  const parent = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "b-test-serial-dir-")), "configured");
  kept.push(path.dirname(parent));
  try {
    process.env.SIMPLESFTP_TEST_SERIAL_LOG_DIR = parent;
    const first = serial.logDirectory();
    const second = serial.logDirectory();
    assert.notEqual(first, parent, "配置目录本身不能当 run 目录用");
    assert.notEqual(first, second, "连续两次必须各得一个独立 run 目录");
    assert.ok(first.startsWith(parent + path.sep) && second.startsWith(parent + path.sep), "run 目录必须落在配置父目录内");
    assert.ok(fs.statSync(first).isDirectory() && fs.statSync(second).isDirectory(), "run 目录必须已创建");
    const nested = path.join(parent, "nested", "deeper");
    process.env.SIMPLESFTP_TEST_SERIAL_LOG_DIR = nested;
    assert.ok(serial.logDirectory().startsWith(nested + path.sep), "不存在的父目录要先递归创建");
    delete process.env.SIMPLESFTP_TEST_SERIAL_LOG_DIR;
    assert.ok(serial.logDirectory().startsWith(os.tmpdir()), "未配置时仍落在系统临时目录");
  } finally {
    if (saved === undefined) delete process.env.SIMPLESFTP_TEST_SERIAL_LOG_DIR;
    else process.env.SIMPLESFTP_TEST_SERIAL_LOG_DIR = saved;
  }
});

test("runner still counts passing files the same way and ignores the fixture suffix", () => {
  // 同时锁住另一类伪报通过：本测试跑在 node --test 下，NODE_TEST_CONTEXT 会被子进程继承；
  // runner 若不过滤，node 会打印 “skipping running files.” 并以 0 用例、退出码 0 伪报通过。
  const { stdout, stderr, code } = run(["testSerialPassing.fixture.js"]);
  assert.equal(code, 0, "passing fixture must exit 0, stderr: " + stderr.slice(0, 300));
  assert.match(stdout, /1 files, 2 passed/, "summary line must be unchanged: " + stdout.trim());
  assert.ok(stdout.includes("logs="), "runner must announce where the full logs live: " + stdout.split(String.fromCharCode(10))[0]);
});

test("timeout limit may only be shortened, never raised above 20000ms", () => {
  const saved = process.env.SIMPLESFTP_TEST_SERIAL_TIMEOUT_MS;
  try {
    for (const [value, expected] of [[undefined, 20000], ["", 20000], ["   ", 20000], ["not-a-number", 20000],
      ["99999999", 20000], ["1e9", 20000], ["20000", 20000], ["19999.7", 19999], ["300", 300], ["100", 250], ["-5", 250], ["0", 250]]) {
      if (value === undefined) delete process.env.SIMPLESFTP_TEST_SERIAL_TIMEOUT_MS;
      else process.env.SIMPLESFTP_TEST_SERIAL_TIMEOUT_MS = String(value);
      assert.equal(serial.timeoutLimit(), expected, "env " + JSON.stringify(value) + " must clamp to " + expected + "ms");
    }
    assert.equal(serial.DEFAULT_TIMEOUT_MS, 20000, "default limit must stay 20000ms");
    assert.ok(serial.MIN_TIMEOUT_MS >= 250 && serial.MIN_TIMEOUT_MS <= 1000, "lower bound must stay sane: " + serial.MIN_TIMEOUT_MS);
  } finally {
    if (saved === undefined) delete process.env.SIMPLESFTP_TEST_SERIAL_TIMEOUT_MS;
    else process.env.SIMPLESFTP_TEST_SERIAL_TIMEOUT_MS = saved;
  }
});

test("preview decoding never splits a multi-byte code point", () => {
  const text = "隔离与只读并发互不阻断·校验通过・漢字混じりの充填・";
  const payload = Buffer.from(text.repeat(4000) + String.fromCharCode(10), "utf8");
  assert.ok(payload.length > 65536, "fixture payload must exceed the old 64KB window");
  for (const cut of [1, 2, payload.length % 3, 65533, payload.length - 1]) {
    const decoded = serial.decodeFromBoundary(payload.subarray(cut));
    assert.equal(decoded.includes(String.fromCharCode(0xfffd)), false, "cut " + cut + " must not fabricate a replacement character");
  }
  const shown = serial.preview(payload.subarray(0, 4096), payload.subarray(payload.length - 16384));
  assert.equal(shown.includes(String.fromCharCode(0xfffd)), false, "preview must stay free of replacement characters");
  assert.ok(shown.includes(text.slice(0, 6)), "preview must keep readable head text");
  assert.ok(shown.includes("[…完整原文见日志文件…]"), "preview must mark the elided middle");
});

test("pass count is read from the last summary line in the log tail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b-test-serial-tail-"));
  kept.push(dir);
  const file = path.join(dir, "sample.log");
  fs.writeFileSync(file, "pass 7 (stale line inside a test name)\n" + "x".repeat(70000) + String.fromCharCode(10) + "ℹ pass 3" + String.fromCharCode(10));
  assert.equal(serial.tailNumber(file, /pass (\d+)/g), 3, "must take the trailing summary, not the first occurrence");
  fs.writeFileSync(file, "no summary at all" + String.fromCharCode(10));
  assert.equal(serial.tailNumber(file, /pass (\d+)/g), 0, "missing summary must count as zero");
  assert.equal(serial.tailNumber(path.join(dir, "missing.log"), /pass (\d+)/g), 0, "missing log must not throw");
});
