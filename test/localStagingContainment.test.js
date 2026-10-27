const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  return request === "vscode" ? {
    TreeItem: class {},
    ProgressLocation: { Notification: 1 },
    window: {
      withProgress: (_options, operation) => operation({ report: () => undefined }),
      showErrorMessage: () => undefined,
    },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    },
  } : originalLoad.call(this, request, ...args);
};
const { __test } = require("../extension.js");
Module._load = originalLoad;

function project() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-local-staging-"));
}

test("local mapping partials are contained inside the reserved staging subtree", () => {
  const root = project();
  fs.mkdirSync(path.join(root, "experiments", "results", "nested"), { recursive: true });
  const staging = __test.mappedStagingPath(root, path.join(root, "experiments", "results", "run.csv"));
  const base = path.join(fs.realpathSync(root), "simple_cluster", ".simple-sftp-staging");
  assert.equal(path.dirname(staging), base);
  assert.match(path.basename(staging), /^\.run\.csv\.simple-sftp-partial-[0-9a-f]{32}$/);
  // The same destination always reuses one bounded slot; different destinations never collide.
  const again = __test.mappedStagingPath(root, path.join(root, "experiments", "results", "run.csv"));
  assert.equal(again, staging);
  const other = __test.mappedStagingPath(root, path.join(root, "experiments", "results", "nested", "run.csv"));
  assert.notEqual(other, staging);
  assert.equal(path.dirname(other), base);
  // Partial siblings must not appear next to the destination.
  assert.equal(fs.readdirSync(path.join(root, "experiments", "results")).length, 1);
});

test("local mapping staging refuses symlinked containers instead of following them", () => {
  const root = project();
  const outside = project();
  fs.mkdirSync(path.join(root, "experiments"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "simple_cluster"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => __test.mappedStagingPath(root, path.join(root, "experiments", "a.csv")), /不是普通目录/);
  fs.unlinkSync(path.join(root, "simple_cluster"));
  fs.mkdirSync(path.join(root, "simple_cluster"));
  fs.symlinkSync(outside, path.join(root, "simple_cluster", ".simple-sftp-staging"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => __test.mappedStagingPath(root, path.join(root, "experiments", "a.csv")), /不是普通目录/);
});
