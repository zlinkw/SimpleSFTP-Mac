const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../extension.js"), "utf8");
const start = source.indexOf("function normalizeDownloadExtensions(");
const end = source.indexOf("async function configureDownloadScope(", start);
test("manual remote scope accepts results, logs and large weights but excludes machine state", () => {
  const sandbox = { path, toPosixPath: (value) => String(value).replace(/\\/g, "/"), DEFAULT_DOWNLOAD_EXTENSIONS: ["*"], DEFAULT_DOWNLOAD_MAX_FILE_SIZE_MB: 1024 };
  vm.runInNewContext(source.slice(start, end) + "\nthis.normalize=normalizeDownloadScope;", sandbox);
  const scope = sandbox.normalize({ paths: ["simple_cluster/results", "simple_cluster/tmp/cluster_scheduler/logs", "datasets"], extensions: ["*"], maxFileSizeMB: 4096 });
  assert.equal(scope.maxFileSizeMB, 4096);
  assert.deepEqual([...scope.paths], ["datasets", "simple_cluster/results", "simple_cluster/tmp/cluster_scheduler/logs"]);
  assert.throws(() => sandbox.normalize({ paths: ["simple_cluster/actions"] }), /状态目录/);
});

test("manual download browser shows directories omitted by the preset browser", () => {
  const manual = source.slice(source.indexOf("async function configureDownloadScopeCore("), source.indexOf("function mergeIgnorePatterns("));
  assert.match(manual, /title: "选择允许下载的远端文件夹", showHiddenTopLevel: true/);
  assert.match(manual, /title: "进入远端文件所在目录", showHiddenTopLevel: true/);
  assert.match(source, /if \(!showHiddenTopLevel && current === remoteBase\.replace/);
});
