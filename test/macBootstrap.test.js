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

test("update idle waits for controller disposal AND child process close proof", async () => {
  const Module = require("node:module"), { EventEmitter } = require("node:events");
  const original = Module._load;
  Module._load = function(name, ...args) { return name === "vscode" ? { TreeItem: class {} } : original.call(this, name, ...args); };
  let extension;
  try { extension = require("../extension"); } finally { Module._load = original; }
  const controller = extension.__test.createTransferController({ id: "mac-update-idle-test", operation: "upload", localPath: "/test", remotePath: "/remote", host: "example" });
  const child = new EventEmitter(); extension.__test.trackTransferResource(child, controller.operationId);
  let done = false;
  const idle = extension.waitForUpdateIdle().then(() => { done = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(done, false);
    controller.dispose(); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(done, false);
    child.emit("close", 0); await idle; assert.equal(done, true);
  } finally { controller.dispose(); child.emit("close", 0); }
});
