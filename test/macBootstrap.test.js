const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const gate = require("../mac-update-gate");
test("SFTP Mac bootstrap retains update access before loading business extension", () => {
  const source = fs.readFileSync(path.join(__dirname, "../mac-bootstrap.js"), "utf8");
  assert.ok(source.indexOf('registerCommand("simpleSftpMac.checkPreviewUpdates"') < source.indexOf('business = require("./extension")'));
  assert.equal(require("../package.json").main, "./mac-bootstrap.js");
  assert.equal(typeof require("../mac-bootstrap").waitForUpdateIdle, "function");
});
test("update gate rejects new operations and releases explicitly", () => {
  gate.setUpdateGate(true); assert.throws(gate.assertBusinessAllowed, /正在更新/);
  gate.setUpdateGate(false);
});
