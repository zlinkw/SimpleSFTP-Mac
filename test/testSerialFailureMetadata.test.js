const { test, assert, fs, os, path, spawnSync, projectRoot, runner, serial, kept, run } = require("./testSerialOutputPreservation.support.cjs");

test("runner reports timeout with the real limit and keeps printed output in the log", () => {
  const { log, stdout, stderr, code } = run(["testSerialTimeout.fixture.js"], { SIMPLESFTP_TEST_SERIAL_TIMEOUT_MS: "1200" });
  assert.ok(stdout.split(String.fromCharCode(10))[0].includes("limit=1200ms"), "shortened limit must be announced: " + stdout.split(String.fromCharCode(10))[0]);
  assert.notEqual(code, 0, "a hanging fixture must not be reported as passing");
  assert.match(stderr, /testSerialTimeout\.test\.js/);
  assert.match(stderr, /(1\.2 second limit|killed by SIGKILL|exit code)/, "timeout/kill reason must be explicit: " + stderr.slice(0, 200));
  for (const row of ["exitCode: ", "signal: ", "limitMs: 1200"]) {
    assert.ok(stderr.includes(row), "超时失败也必须独立列出 " + row + "：" + stderr.split(String.fromCharCode(10)).slice(0, 5).join(" | "));
  }
  assert.match(stderr, /exitCode: (null|\d+)/, "exitCode 必须是真实值或 null");
  assert.match(stderr, /signal: (null|SIGKILL|SIGTERM)/, "signal 必须是真实值或 null");
  assert.ok(log.includes("SERIAL-FIXTURE-TIMEOUT-MARKER-4c07aa"), "output printed before the kill must reach the log");
});

test("failure metadata lists exitCode, signal and limitMs independently", () => {
  const { stderr, logFile } = run(["testSerialMultiFail.fixture.js"]);
  const lines = stderr.split(String.fromCharCode(10));
  assert.ok(lines.some(row => row === "exitCode: 1"), "exitCode 必须独立成行：" + lines.slice(0, 6).join(" | "));
  assert.ok(lines.some(row => row === "signal: null"), "未收到信号时 signal 要显式写 null：" + lines.slice(0, 6).join(" | "));
  assert.ok(lines.some(row => row === "limitMs: 20000"), "生效时限要显式写出：" + lines.slice(0, 6).join(" | "));
  assert.ok(stderr.includes("log: " + logFile), "必须给出完整日志路径");
  assert.ok(/size: \d+ bytes/.test(stderr), "必须给出日志真实字节数");
});

test("spawn failure keeps the system code and log path without inventing an exit code", () => {
  const message = serial.failureReport("x.test.js", "spawn failed: Permission denied", {
    code: null, signal: null, limitMs: 20000, logFile: "/tmp/x.test.js.log", systemCode: "EACCES", size: 0, previewText: "",
  });
  const rows = message.split(String.fromCharCode(10));
  for (const row of ["x.test.js: spawn failed: Permission denied", "exitCode: null", "signal: null", "limitMs: 20000",
    "log: /tmp/x.test.js.log", "spawnSystemCode: EACCES", "size: 0 bytes"]) {
    assert.ok(rows.includes(row), "缺少失败元数据行 " + row + "：" + message);
  }
});
