// regression fixture for scripts/test-serial.js：正常通过路径的计数语义保持不变。
"use strict";
const test = require("node:test");
test("serial fixture passing one", () => {});
test("serial fixture passing two with the word pass 7 inside its name", () => {});
