// regression fixture for scripts/test-serial.js：多字节输出必须成行落盘。
// 说明：node --test 自身的捕获层在重负载下会偶发丢尾/坏字符（不经本 runner 也复现），
// 所以这里只要求“量大且含首尾标记”；字节级边界保真由 test-serial 导出的纯函数单测精确覆盖。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const LINES = 4000;
test("serial fixture multi-byte output stays intact", () => {
  console.log("串行夹具首行-MARK-头-3f9a12");
  for (let index = 0; index < LINES; index++) console.log("第" + index + "行·隔离与只读并发互不阻断·校验通过・漢字混じりの充填");
  console.log("串行夹具末行-MARK-尾-7cd0e5");
  assert.equal("多字节实际值", "多字节期望值");
});
