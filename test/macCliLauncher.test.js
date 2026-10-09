"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http");
const { spawnSync, execFile } = require("node:child_process");
const { writeMacCliLauncher, launcherText, shellQuote, CLI_COMMAND, registerMacCli } = require("../mac-cli");
const root = path.resolve(__dirname, "..");
function evidence() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mac-cli-"));
  fs.writeFileSync(path.join(directory, "KEEP.txt"), "Local CLI evidence retained; no server or research operation.\n", "utf8");
  return directory;
}
function shell() {
  if (process.platform !== "win32") return "/bin/sh";
  const git = spawnSync("git", ["--exec-path"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  const executable = path.resolve(git.stdout.trim(), "../../..", "bin/bash.exe");
  assert.ok(fs.existsSync(executable), "local Git POSIX shell is required");
  return executable;
}
function packageFixture(directory, version) {
  fs.mkdirSync(path.join(directory, "bin"), { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ publisher: "simple-local", name: "simple-sftp-mac", version }), "utf8");
  fs.writeFileSync(path.join(directory, "bin/simple-sftp-api.js"), "console.log(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()}))\n", "utf8");
}
test("stable POSIX launcher preserves arguments/cwd, updates to the new package and cannot downgrade", () => {
  const directory = evidence(), v1 = path.join(directory, "版本 A ' $()"), v2 = path.join(directory, "版本 B ' $()"), data = path.join(directory, "Library/Application Support/SimpleSFTPMac");
  packageFixture(v1, "0.1.9"); packageFixture(v2, "0.1.10");
  const target = writeMacCliLauncher(v1, data), args = ["中文 空格", " trailing ", "$(touch should-not-exist)", "'quoted'", "Model/model"];
  const text = fs.readFileSync(target, "utf8"); assert.ok(!text.includes("\r"));
  const result = spawnSync(shell(), ["-s"], { input: [shellQuote(target), ...args.map(shellQuote)].join(" ") + "\n", cwd: directory, encoding: "utf8", timeout: 10000, windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { argv: args, cwd: directory });
  assert.equal(fs.existsSync(path.join(directory, "should-not-exist")), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(target).mode & 0o777, 0o700);
  assert.equal(writeMacCliLauncher(v2, data), target); assert.match(fs.readFileSync(target, "utf8"), /extension-version: 0\.1\.10/);
  const before = fs.readFileSync(target); assert.equal(writeMacCliLauncher(v1, data), target); assert.ok(fs.readFileSync(target).equals(before));
  const missingNode = spawnSync(shell(), ["-s"], { input: "PATH='' " + shellQuote(target) + "\n", cwd: directory, encoding: "utf8", timeout: 10000, windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  assert.equal(missingNode.status, 127); assert.match(missingNode.stderr, /Node.js 20/);
});

test("unknown files, linked directories, hard links, invalid paths and foreign packages cannot become an entry", () => {
  const directory = evidence(), pkg = path.join(directory, "package"); packageFixture(pkg, "0.1.0");
  const unknown = path.join(directory, "unknown/cli"); fs.mkdirSync(unknown, { recursive: true });
  const target = path.join(unknown, "simple-sftp-mac-api"); fs.writeFileSync(target, "user file", "utf8");
  assert.throws(() => writeMacCliLauncher(pkg, path.dirname(unknown)), /未知文件/); assert.equal(fs.readFileSync(target, "utf8"), "user file");
  const linked = path.join(directory, "linked"), foreign = path.join(directory, "foreign"); fs.mkdirSync(foreign);
  fs.symlinkSync(foreign, linked, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => writeMacCliLauncher(pkg, linked), /链接/); assert.deepEqual(fs.readdirSync(foreign), []);
  const hard = writeMacCliLauncher(pkg, path.join(directory, "hard")); fs.linkSync(hard, path.join(directory, "same-inode"));
  assert.throws(() => writeMacCliLauncher(pkg, path.join(directory, "hard")), /未知文件/);
  for (const entry of ["relative", "/tmp/a\n", "/tmp/a\0"]) assert.throws(() => launcherText(entry));
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "windows-original", publisher: "simple-local", version: "0.1.0" }), "utf8");
  assert.throws(() => writeMacCliLauncher(pkg, path.join(directory, "other")), /身份/);
});

test("CLI command is registered independently of business code and startup failure does not remove update entry", () => {
  const commands = new Map(), subscriptions = [];
  registerMacCli({ subscriptions }, { commands: { registerCommand: (id, work) => { commands.set(id, work); return { dispose() {} }; } } });
  assert.ok(commands.has(CLI_COMMAND)); assert.equal(subscriptions.length, 1);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); assert.ok(pkg.contributes.commands.some(item => item.command === CLI_COMMAND));
  const bootstrap = fs.readFileSync(path.join(root, "mac-bootstrap.js"), "utf8");
  assert.ok(bootstrap.indexOf('registerCommand("simpleSftpMac.checkPreviewUpdates"') < bootstrap.indexOf("registerMacCli(context, vscode)"));
  assert.ok(bootstrap.indexOf("registerMacCli(context, vscode)") < bootstrap.indexOf('business = require("./extension")'));
  assert.match(bootstrap, /try \{ cli\.refresh\(\); \}/);
});

test("actual Mac command refreshes and copies the quoted stable path without a business panel", async () => {
  const directory = evidence(), commands = new Map(), copied = [];
  const exports = {}, vm = require("node:vm"), localRequire = require("node:module").createRequire(path.join(root, "mac-cli.js"));
  const sandbox = { module: { exports }, exports, process: { ...process, platform: "darwin", arch: "arm64" }, require: name => name === "./mac-paths" ? { macComponentDirectory: () => path.join(directory, "component") } : localRequire(name) };
  vm.runInNewContext(fs.readFileSync(path.join(root, "mac-cli.js"), "utf8"), sandbox);
  sandbox.module.exports.registerMacCli({ extensionPath: root, subscriptions: [] }, { commands: { registerCommand: (id, work) => { commands.set(id, work); return {}; } },
    window: { showInformationMessage: async () => "复制自检命令" }, env: { clipboard: { writeText: async value => copied.push(value) } } });
  const result = await commands.get(CLI_COMMAND)();
  assert.equal(result.command, shellQuote(result.path) + " self-check"); assert.deepEqual(copied, [result.command]);
  assert.ok(fs.readFileSync(result.path, "utf8").includes("# extension-version: " + require("../package.json").version));
});

test("actual packaged CLI self-check runs through the launcher with fresh local discovery", async () => {
  const directory = evidence(), target = writeMacCliLauncher(root, path.join(directory, "component")), discovery = path.join(directory, "发现 中文.json");
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; assert.equal(req.url, "/api/v1/health"); assert.equal(req.headers.authorization, "Bearer local-fixture"); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, name: "SimpleSFTPMac", version: "fixture" })); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    fs.writeFileSync(discovery, JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: "local-fixture" }), "utf8");
    const result = await new Promise((resolve, reject) => execFile(shell(), [target, "self-check"], { cwd: directory, encoding: "utf8", timeout: 10000, windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: "1", SIMPLE_SFTP_MAC_API_FILE: discovery } }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(JSON.parse(stdout))));
    assert.equal(result.ok, true); assert.equal(requests, 1);
    const found = result.checks.find(item => item.name === "discovery"); assert.equal(found.detail, discovery);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
