"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const localRequire = createRequire(path.join(root, "extension.js"));
const source = fs.readFileSync(path.join(root, "extension.js"), "utf8");
function fixture({ output = " 文件.json \0" + "6\0Model.json\0" + "0\0model.json\0" + "12\0", picks = [], manual } = {}) {
  const module = { exports: {} }, commands = [], saved = [], listings = [];
  const target = { host: "worker", username: "research", port: 2222, remotePath: "/Data/ 研究 A " };
  const vscode = { TreeItem: class {}, workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { showInformationMessage() {}, showErrorMessage() {}, showInputBox: async () => manual,
      showQuickPick: async items => { const choice = picks.shift(); return typeof choice === "function" ? choice(items) : choice; } } };
  const sandbox = { module, exports: module.exports, __dirname: root, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, process: { ...process, platform: "darwin", arch: "arm64" }, commands, output, saved, listings, target,
    require(name) {
      if (name === "vscode") return vscode;
      if (name === "path") return { ...path.posix, win32: path.win32, posix: path.posix };
      return localRequire(name);
    } };
  vm.createContext(sandbox);
  vm.runInContext(source + `
    execSsh = (_sftp,command,_options,callback) => { commands.push(command); callback(null,output,''); return {}; };
    watchTransferProcess = () => ({receive() {}});
    listRemoteDirs = async (_sftp,directory) => { listings.push(directory); return []; };
    resolveLocalWorkspacePath = value => value;
    resolveUploadSftp = () => target;
    readTargetDownloadScope = () => null;
    confirmTransferPath = async () => {};
    writeTargetDownloadScope = (_local,_options,_sftp,value) => { const scope=normalizeDownloadScope(value); saved.push(scope); return scope; };
    this.helpers = { normalizeDownloadScope, explicitDownloadScope, relativeRemoteScopePath, listRemoteFiles,
      configureDownloadScopeCore, pickRemoteDirectory, createRemoteDownloadScript };
  `, sandbox);
  return { ...sandbox.helpers, api: module.exports.__test.createLocalApiMethods(), commands, saved, listings, target };
}

test("Mac download scopes preserve exact relative names and cannot expand empty or malformed input to root", async () => {
  const f = fixture(), values = [" 研究 A / 文件.csv ", "Model", "model", "e\u0301", "é", "literal%20", "a..b"];
  const scope = f.normalizeDownloadScope({ paths: values });
  for (const value of values) assert.ok(scope.paths.includes(value));
  assert.equal(f.normalizeDownloadScope({ paths: ["."] }).paths[0], ".");
  assert.deepEqual(Array.from(f.normalizeDownloadScope({ paths: [] }).paths), []);
  for (const value of ["", "/", "/x", "a//x", "a/../x", "a/./x", "a\\x", "a\tx", "a\nx", "a\x7fx", "中".repeat(1366), null]) {
    assert.throws(() => f.normalizeDownloadScope({ paths: [value] }));
    await assert.rejects(f.configureDownloadScopeCore({ localPath: "/Users/test/研究 ", server: f.target, apiMode: true, paths: [value] }));
    await assert.rejects(f.api["sync.downloadPaths"]({ localPath: "/Users/test/研究 ", server: f.target, paths: [value] }));
  }
  for (const value of [".", "./", "././"]) assert.throws(() => f.explicitDownloadScope({ paths: [value] }));
  assert.equal(f.saved.length, 0); assert.equal(f.commands.length, 0);
  assert.equal(f.relativeRemoteScopePath(f.target.remotePath, f.target.remotePath + "/ 结果 "), " 结果 ");
  for (const value of ["/data/ 研究 A /x", "/Data/ 研究 A /../outside", "/Data/ 研究 A /./x", "/Data/ 研究 A /x\n", "relative"])
    assert.throws(() => f.relativeRemoteScopePath(f.target.remotePath, value));
});

test("NUL file browser retains edge spaces and case, and rejects malformed metadata", async () => {
  const f = fixture(), files = await f.listRemoteFiles(f.target, f.target.remotePath);
  assert.deepEqual(Array.from(files, file => [file.name, file.sizeBytes]).sort(), [[" 文件.json ", 6], ["Model.json", 0], ["model.json", 12]].sort());
  assert.ok(f.commands[0].includes("-printf '%f\\0%s\\0'"));
  assert.ok(f.commands[0].includes("'" + f.target.remotePath + "'"));
  for (const output of ["file\0", "file\0bad\0", "file\0-1\0", "file\0" + "9007199254740992\0", "a/b\0" + "1\0", "a\nb\0" + "1\0", "a\\b\0" + "1\0", "./file\0" + "1\0", "file\0" + "1\0file\0" + "2\0"])
    await assert.rejects(fixture({ output }).listRemoteFiles(f.target, f.target.remotePath));
  assert.deepEqual(Array.from(await fixture({ output: "" }).listRemoteFiles(f.target, f.target.remotePath)), []);
});

test("actual Mac scope UI saves spaced file names and confines manual choices before browsing files", async () => {
  const f = fixture({ picks: [items => items.find(item => item.id === "file"), items => items.find(item => item.kind === "use"), items => [items.find(item => item.file.name === " 文件.json ")]] });
  const result = await f.configureDownloadScopeCore({ localPath: "/Users/test/项目", server: f.target });
  assert.equal(result.ok, true); assert.deepEqual(Array.from(f.saved[0].paths), [" 文件.json "]);
  const escaped = fixture({ manual: "/outside/项目", picks: [items => items.find(item => item.id === "file"), items => items.find(item => item.kind === "manual")] });
  assert.equal((await escaped.configureDownloadScopeCore({ localPath: "/Users/test/项目", server: escaped.target })).ok, false);
  assert.equal(escaped.commands.length, 0); assert.equal(escaped.saved.length, 0);
  assert.deepEqual(escaped.listings, [escaped.target.remotePath]);
  const rootBrowse = fixture({ picks: [{ kind: "dir", name: " 研究 " }, items => items.find(item => item.kind === "use")] });
  assert.equal(await rootBrowse.pickRemoteDirectory({ remoteBase: "/", sftp: rootBrowse.target }), "/ 研究 ");
  assert.deepEqual(rootBrowse.listings, ["/", "/ 研究 "]);
});

test("real scoped Python archive preserves chosen names and excludes other paths and unsafe links", () => {
  const f = fixture(), local = fs.mkdtempSync(path.join(os.tmpdir(), "mac-download-scope-"));
  const directory = " 研究 A";
  fs.mkdirSync(path.join(local, directory)); fs.mkdirSync(path.join(local, "outside"));
  fs.writeFileSync(path.join(local, directory, "数据.json"), "中文", "utf8"); fs.writeFileSync(path.join(local, "outside", "other.json"), "outside", "utf8");
  fs.writeFileSync(path.join(local, "KEEP.txt"), "Local test evidence retained; no remote server contacted.\n", "utf8");
  // Only the fixture mount root changes on Windows; the production-generated scope and archive logic run verbatim.
  const makeScript = (paths) => f.createRemoteDownloadScript(f.target.remotePath, { paths, extensions: [".json"], maxFileSizeMB: 1 })
    .replace('root=os.path.realpath(' + JSON.stringify(f.target.remotePath) + ')', 'root=os.path.realpath(' + JSON.stringify(local) + ')');
  const script = makeScript([directory]), encoded = Buffer.from(script, "utf8").toString("base64");
  const result = spawnSync("python", ["-B", "-X", "utf8", path.join(__dirname, "download_scope_probe.py"), encoded], { timeout: 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  const archive = path.join(local, "evidence.tar"); fs.writeFileSync(archive, result.stdout);
  const probe = path.join(local, "inspect_archive.py");
  fs.writeFileSync(probe, "import json,sys,tarfile\nwith tarfile.open(sys.argv[1]) as a:\n print(json.dumps([{'name':m.name,'body':a.extractfile(m).read().decode('utf-8')} for m in a if m.isfile()],ensure_ascii=False))\n", "utf8");
  const decoded = spawnSync("python", ["-B", "-X", "utf8", probe, archive], { timeout: 10000, windowsHide: true, encoding: "utf8" });
  assert.equal(decoded.status, 0, decoded.stderr); assert.deepEqual(JSON.parse(decoded.stdout), [{ name: directory + "/数据.json", body: "中文" }]);
  fs.symlinkSync(path.join(local, directory), path.join(local, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(fs.lstatSync(path.join(local, "linked")).isSymbolicLink(), true);
  // Python treats Windows junctions differently; represent this verified fixture link as a POSIX symlink.
  const linkProbe = path.join(local, "scope_link_probe.py");
  fs.writeFileSync(linkProbe, "import os,sys,base64\noriginal=os.path.islink\nlink=os.path.normcase(os.path.abspath(sys.argv[2]))\nos.path.islink=lambda p: original(p) or os.path.normcase(os.path.abspath(p))==link\nexec(compile(base64.b64decode(sys.argv[1]),'scoped_archive_fixture','exec'))\n", "utf8");
  const linked = spawnSync("python", ["-B", "-X", "utf8", linkProbe, Buffer.from(makeScript(["linked"]), "utf8").toString("base64"), path.join(local, "linked")], { timeout: 10000, windowsHide: true });
  assert.notEqual(linked.status, 0); assert.equal(linked.stdout.length, 0); assert.match(linked.stderr.toString("utf8"), /symlink/);
});
