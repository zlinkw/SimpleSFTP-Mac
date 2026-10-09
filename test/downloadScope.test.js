const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const source = fs.readFileSync(path.join(__dirname, "../extension.js"), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function loadScopeHelpers() {
  const sandbox = {
    Buffer,
    path,
    DEFAULT_DOWNLOAD_EXTENSIONS: ["*"],
    DEFAULT_DOWNLOAD_MAX_FILE_SIZE_MB: 1024,
    toPosixPath: (value) => String(value).replace(/\\/g, "/"),
  };
  vm.createContext(sandbox);
  const scopeStart = source.indexOf("function normalizeDownloadExtensions(");
  const scopeEnd = source.indexOf("async function configureDownloadScope(", scopeStart);
  const scriptStart = source.indexOf("function createRemoteDownloadScript(");
  const scriptEnd = source.indexOf("function getTarExcludeArgs(", scriptStart);
  vm.runInContext([
    source.slice(scopeStart, scopeEnd),
    source.slice(scriptStart, scriptEnd),
    "this.normalize = normalizeDownloadScope; this.relative = relativeRemoteScopePath; this.script = createRemoteDownloadScript;",
  ].join("\n"), sandbox);
  return sandbox;
}

test("download scope keeps remote paths inside the configured project", () => {
  const helpers = loadScopeHelpers();
  assert.equal(helpers.relative("/srv/project", "/srv/project/data/results"), "data/results");
  assert.equal(helpers.relative("/srv/project", "/srv/project"), ".");
  assert.throws(() => helpers.relative("/srv/project", "/srv/other"), /超出项目根目录/);
  assert.throws(() => helpers.normalize({ paths: [".git"] }), /状态目录/);
});

test("scoped remote archive applies selected paths, extensions and size", () => {
  const helpers = loadScopeHelpers();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-download-scope-"));
  try {
    fs.mkdirSync(path.join(root, "results"), { recursive: true });
    fs.mkdirSync(path.join(root, "logs"), { recursive: true });
    fs.writeFileSync(path.join(root, "results", "small.csv"), "ok\n");
    fs.writeFileSync(path.join(root, "results", "model.pt"), "weight\n");
    fs.writeFileSync(path.join(root, "results", "large.csv"), Buffer.alloc(256 * 1024));
    fs.writeFileSync(path.join(root, "logs", "outside.csv"), "skip\n");
    const script = helpers.script(root, { paths: ["results"], extensions: [".csv"], maxFileSizeMB: 0.1 });
    const python = spawnSync("python", ["-B", "-X", "utf8", path.join(__dirname, "download_scope_probe.py"), Buffer.from(script, "utf8").toString("base64")], { encoding: null, maxBuffer: 2 * 1024 * 1024, timeout: 10000, windowsHide: true });
    assert.equal(python.status, 0, String(python.stderr || ""));
    const listed = spawnSync("tar", ["-tf", "-"], { input: python.stdout, encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(listed.stdout.trim().split(/\r?\n/).filter(Boolean), ["results/small.csv"]);
  } finally {
    fs.writeFileSync(path.join(root, "KEEP.txt"), "Isolated test evidence retained.\n", "utf8");
  }
});

test("download scope command is exposed to VS Code and local API", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  assert.ok(pkg.activationEvents.includes("onCommand:simpleSftp.configureDownloadScope"));
  assert.ok(pkg.contributes.commands.some((item) => item.command === "simpleSftp.configureDownloadScope"));
  assert.match(source, /"downloadScope\.configure": async/);
});
