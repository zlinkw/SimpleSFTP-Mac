"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { Writable } = require("node:stream");
const { spawnSync } = require("node:child_process");
const paths = require("../workspace-path");
const tar = require("../tar-writer");
const root = path.resolve(__dirname, "..");
const localRequire = createRequire(path.join(root, "extension.js"));
const source = fs.readFileSync(path.join(root, "extension.js"), "utf8");

function fixture() {
  const module = { exports: {} }, effects = [];
  const sandbox = { module, exports: module.exports, __dirname: root, Buffer, console, setTimeout, clearTimeout,
    setInterval, clearInterval, AbortController, process: { ...process, platform: "darwin", arch: "arm64" }, effects,
    require(name) {
      if (name === "path") return { ...path.posix, win32: path.win32, posix: path.posix };
      if (name === "vscode") return { TreeItem: class {}, workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
      if (name === "child_process") return { spawn() { effects.push("spawn"); throw Error("unexpected SSH"); }, execFile() { throw Error("unexpected SSH"); } };
      return localRequire(name);
    } };
  vm.createContext(sandbox);
  vm.runInContext(source + `
    withFileResourceLease = () => { effects.push('lease'); throw Error('unexpected lease'); };
    this.helpers = { sanitizeRelativeUploadPath, isSafeRemoteManagedPath, runLocalTarUpload, parseMappedTarHeader };
  `, sandbox);
  return { ...module.exports.__test, ...sandbox.helpers, effects };
}

const valid = [" 研究 A / 文件.py ", "Model/a.json", "model/a.json", "e\u0301.csv", "é.csv", "literal%20.json", "a..b.py", "-模型.py"];
const invalid = ["", "/x", "//x", "C:/x", "../x", "a/../x", "a/./x", "a//x", "a\\x", "a\tx", "a\nx", "a\0x", "a\x7fx", 42, null, "中".repeat(1366)];

test("actual Mac upload, Worker and mapped paths preserve spelling and reject unsafe aliases", () => {
  const f = fixture();
  for (const value of valid) {
    assert.equal(paths.normalizeMacRelativePath(value), value);
    assert.equal(f.sanitizeRelativeUploadPath(value), value);
    assert.equal(f.directSyncRelativePath(value), value);
    assert.equal(f.isSafeRemoteManagedPath(value), true);
    assert.equal(tar.toTarPath(value, "darwin"), value);
    const plan = f.normalizeMappedDownloadEntries({ entries: [{ remotePath: value, localRelativePath: value }] });
    assert.equal(plan.entries[0].remotePath, value); assert.equal(plan.entries[0].localRelativePath, value);
  }
  assert.equal(paths.normalizeMacRelativePath("./目录/文件.py/"), "目录/文件.py");
  assert.equal(paths.normalizeMacRelativePath(".", "范围", true), ".");
  for (const value of invalid) {
    assert.throws(() => paths.normalizeMacRelativePath(value));
    assert.throws(() => f.sanitizeRelativeUploadPath(value));
    assert.throws(() => f.directSyncRelativePath(value));
    assert.equal(f.isSafeRemoteManagedPath(value), false);
    assert.throws(() => f.normalizeMappedDownloadEntries({ entries: [{ remotePath: value, localRelativePath: "safe.json" }] }));
  }
  const plan = f.normalizeMappedDownloadEntries({ entries: [
    { remotePath: "Model/a.json", localRelativePath: "upper.json" }, { remotePath: "model/a.json", localRelativePath: "lower.json" },
  ] });
  assert.equal(plan.entries.length, 2);
  assert.throws(() => f.normalizeMappedDownloadEntries({ entries: [
    { remotePath: "Model/a.json", localRelativePath: "A.json" }, { remotePath: "model/a.json", localRelativePath: "a.json" },
  ] }), /本机路径重复/);
});

test("whole upload plan is checked before SSH, leases or tar bytes", async () => {
  const f = fixture();
  for (const second of ["../outside.py", "bad\nname.py", "safe.py"]) {
    const files = [{ relativePath: "safe.py", content: Buffer.from("ok") }, { relativePath: second, content: Buffer.from("bad") }];
    assert.throws(() => f.runLocalTarUpload({ localPath: "/Users/test/研究 ", sftp: { remotePath: "/Data/研究 " }, uploadPlan: { files } }));
    const chunks = [];
    await assert.rejects(tar.writeTarEntriesToStream({ files, platform: "darwin", stream: new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } }) }));
    assert.equal(chunks.length, 0);
  }
  assert.deepEqual(f.effects, []);
});

const inspectTar = "import io,json,sys,tarfile\na=tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()),mode='r:*')\nprint(json.dumps([{'name':m.name,'body':a.extractfile(m).read().decode('utf-8')} for m in a if m.isfile()],ensure_ascii=False))";
function python(script, input) {
  return spawnSync("python", ["-B", "-X", "utf8", "-c", script], { input, timeout: 10000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
}
test("real tar/PAX round trip preserves spaces, case and both Unicode spellings", async () => {
  const chunks = [], files = valid.map((relativePath, index) => ({ relativePath, content: Buffer.from("内容 " + index, "utf8") }));
  await tar.writeTarEntriesToStream({ files, localPath: "/unused", platform: "darwin", stream: new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }) });
  const result = python(inspectTar, Buffer.concat(chunks));
  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  assert.deepEqual(JSON.parse(result.stdout.toString("utf8")), files.map((file, index) => ({ name: file.relativePath, body: "内容 " + index })));
});

test("real mapped Python protocol rejects malformed paths before emitting an archive", () => {
  const f = fixture(), local = fs.mkdtempSync(path.join(os.tmpdir(), "mac-mapped-names-"));
  fs.mkdirSync(path.join(local, "目录 A")); fs.writeFileSync(path.join(local, "目录 A", "数据.json"), "中文", "utf8");
  fs.writeFileSync(path.join(local, "KEEP.txt"), "Local test evidence retained; no server was contacted.\n", "utf8");
  const request = { root: local, maxFileBytes: 1024, maxBatchBytes: 4096, files: [{ remotePath: "目录 A/数据.json", archiveName: "mapped/0", bytes: 6 }] };
  const result = python(f.createMappedDownloadScript(), Buffer.from(JSON.stringify(request), "utf8"));
  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  const decoded = python(inspectTar, result.stdout); assert.equal(decoded.status, 0, decoded.stderr.toString("utf8"));
  assert.deepEqual(JSON.parse(decoded.stdout.toString("utf8")), [{ name: "mapped/0", body: "中文" }]);
  for (const value of invalid.filter(value => typeof value === "string")) {
    const bad = python(f.createMappedDownloadScript(), Buffer.from(JSON.stringify({ ...request, files: [{ remotePath: value, archiveName: "mapped/0" }] }), "utf8"));
    assert.equal(bad.status, 73, String(value)); assert.equal(bad.stdout.length, 0);
  }
  const duplicate = python(f.createMappedDownloadScript(), Buffer.from(JSON.stringify({ ...request, files: [...request.files, { ...request.files[0], archiveName: "mapped/1" }] }), "utf8"));
  assert.equal(duplicate.status, 73); assert.equal(duplicate.stdout.length, 0);
});

test("mapped tar headers retain spaces so they cannot impersonate an expected archive member", () => {
  const f = fixture();
  assert.equal(f.parseMappedTarHeader(tar.ustarHeader({ name: " mapped/0 ", typeflag: "0", size: 2 })).name, " mapped/0 ");
  assert.equal(f.parseMappedTarHeader(tar.ustarHeader({ name: "mapped/0", prefix: " dir ", typeflag: "0", size: 2 })).name, " dir /mapped/0");
});
