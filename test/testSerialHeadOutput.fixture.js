// regression fixture for scripts/test-serial.js（不是 *.test.js，不会被 serial runner 自己扫到）：
// 验证子进程输出前段不会因任何截断而丢失（含 >64KB 输出、失败名与断言栈）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const FIRST = "SERIAL-FIXTURE-FIRST-LINE-a7f3c1";
const LAST = "SERIAL-FIXTURE-LAST-LINE-9b41de";
test("serial fixture huge output keeps the failing assertion visible", () => {
  console.log(FIRST);
  for (let index = 0; index < 4200; index++) console.log("SERIAL-FIXTURE-FILLER-" + index + "-" + "x".repeat(48));
  console.log(LAST);
  console.error("SERIAL-FIXTURE-STDERR-TAIL-9e2b70");
  assert.equal("serial-fixture-actual", "serial-fixture-expected", "SERIAL-FIXTURE-ASSERTION-MESSAGE-5d8c22");
});
