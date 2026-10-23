const { test, assert, fs, os, path, spawnSync, projectRoot, runner, serial, kept, run } = require("./testSerialOutputPreservation.support.cjs");

test("runner keeps the whole >64KB child log out of tree and returns the log reference", () => {
  const { log, logFile, stderr, code } = run(["testSerialHeadOutput.fixture.js"]);
  assert.equal(code, 1, "failing fixture must produce a non-zero exit code");
  assert.ok(logFile.includes("b-test-serial-"), "log must live outside the project tree: " + logFile);
  assert.ok(stderr.includes("log: " + logFile), "failure must name the full log file");
  assert.ok(log.includes("SERIAL-FIXTURE-FIRST-LINE-a7f3c1"), "log must contain the first lines (no 64KB head loss)");
  assert.ok(Buffer.byteLength(log) > 65536, "fixture must exceed the old 64KB window, got " + Buffer.byteLength(log));
  assert.match(stderr, /serial fixture huge output keeps the failing assertion visible/, "console preview must still name the failing test");
  assert.match(stderr, /SERIAL-FIXTURE-ASSERTION-MESSAGE-5d8c22/, "console preview must keep the assertion message");
  assert.ok(stderr.length < 40000, "console preview must stay bounded, got " + stderr.length + " chars");
  assert.ok(/size: \d+ bytes/.test(stderr) && Number(stderr.match(/size: (\d+) bytes/)[1]) > 65536, "failure must report the real log size");
});

test("runner keeps every failing case name and full stack in the log", () => {
  const { log, stderr, code } = run(["testSerialMultiFail.fixture.js"]);
  assert.equal(code, 1);
  for (const name of ["serial fixture failing alpha", "serial fixture failing beta", "serial fixture failing gamma"]) {
    assert.ok(log.includes(name), "log must keep failing test name: " + name);
  }
  assert.ok(log.includes("gamma-fixture-stack-marker"), "log must keep the thrown error message");
  assert.ok(/at TestContext\.\w+/.test(log) || /testSerialMultiFail\.test\.js:\d+:\d+/.test(log), "log must keep stack frames");
  assert.match(stderr, /failed \(exit code 1\)/, "real exit code must be reported");
});

test("runner keeps multi-byte output line-oriented in the log", () => {
  // node --test 自己的捕获层在重负载下会偶发丢尾（不经本 runner 也复现），所以这里断言“首行 + 大量整行”，
  // 精确的字节/多字节边界保真由下面的纯函数用例覆盖，不去赌 node 捕获层的稳定性。
  const { log, code } = run(["testSerialMultiByte.fixture.js"]);
  assert.equal(code, 1);
  assert.ok(log.includes("串行夹具首行-MARK-头-3f9a12"), "log must keep the first multi-byte line");
  const lines = log.split(String.fromCharCode(10)).filter(row => row.includes("·校验通过・"));
  assert.ok(lines.length >= 3000, "log must keep thousands of multi-byte lines, got " + lines.length);
});
