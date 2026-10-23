// regression fixture for scripts/test-serial.js：多个失败用例的名字与栈必须全部保留。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
test("serial fixture failing alpha", () => { assert.equal("alpha-actual", "alpha-expected"); });
test("serial fixture failing beta", () => { assert.equal("beta-actual", "beta-expected"); });
test("serial fixture failing gamma", () => { throw new Error("gamma-fixture-stack-marker"); });
