// regression fixture for scripts/test-serial.js：超时/杀进程路径下，已打印输出仍须完整回传。
"use strict";
const test = require("node:test");
test("serial fixture never settles", async () => {
  console.log("SERIAL-FIXTURE-TIMEOUT-MARKER-4c07aa");
  await new Promise(() => {});
});
