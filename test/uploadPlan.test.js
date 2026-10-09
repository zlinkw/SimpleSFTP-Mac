const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

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

function createPlanSandbox(rootPath) {
  return {
    process,
    ...require("../workspace-path"),
    fs,
    path,
    crypto,
    toPosixPath: (value) => String(value).replace(/\\/g, "/"),
    toTarPath: (value) => {
      const normalized = String(value).replace(/\\/g, "/").replace(/^\/+/, "");
      return normalized.startsWith("-") ? `./${normalized}` : normalized;
    },
    patternMatchesPath: (lowerPath, lowerPattern) => {
      if (lowerPattern.includes("*")) {
        const escaped = lowerPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
        return new RegExp(`^${escaped}$`, "i").test(lowerPath);
      }
      return lowerPath === lowerPattern || lowerPath.endsWith(`/${lowerPattern}`);
    },
    isIgnoredLocalPath: (relativePath, ignorePatterns) => {
      const normalized = String(relativePath).replace(/\\/g, "/");
      return ignorePatterns.some((pattern) => (
        normalized === pattern ||
        normalized.startsWith(`${pattern}/`) ||
        normalized.endsWith(`/${pattern}`) ||
        (pattern.startsWith("*.") && normalized.endsWith(pattern.slice(1)))
      ));
    },
  };
}

test("workspace upload plan excludes ignore rules and nested Git repositories", () => {
  const localPath = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-plan-"));
  try {
    fs.writeFileSync(path.join(localPath, "keep.py"), "print('ok')\n");
    fs.mkdirSync(path.join(localPath, ".git"), { recursive: true });
    fs.mkdirSync(path.join(localPath, "comparison_methods/_repos/demo"), { recursive: true });
    fs.writeFileSync(path.join(localPath, "comparison_methods/_repos/demo/file.py"), "x");
    fs.mkdirSync(path.join(localPath, "nested/repo"), { recursive: true });
    fs.mkdirSync(path.join(localPath, "nested/repo/.git"), { recursive: true });
    fs.writeFileSync(path.join(localPath, "nested/repo/file.py"), "x");

    const sandbox = createPlanSandbox(localPath);
    sandbox.rootPath = localPath;
    vm.createContext(sandbox);
    vm.runInContext([
      extractFunction("walkLocalFiles"),
      extractFunction("isIgnoredLocalPath"),
      extractFunction("patternMatchesPath"),
      extractFunction("toPosixPath"),
      extractFunction("createWorkspaceUploadPlan"),
      "this.createPlan = createWorkspaceUploadPlan;",
    ].join("\n"), sandbox);

    const plan = sandbox.createPlan(localPath, { ignore: [".git", "node_modules", "comparison_methods/_repos"] });
    assert.deepEqual(plan.files.map((file) => file.relativePath).join(","), "keep.py");
    assert.equal(plan.fileCount, 1);
    assert.ok(plan.byteCount > 0);
    assert.ok(plan.excludedRuleHits >= 2);
    assert.equal(plan.excludedNestedGitRepos, 1);
    assert.deepEqual([...plan.nestedGitRoots], ["nested/repo"]);
  } finally {
    fs.writeFileSync(path.join(localPath, "KEEP.txt"), "Isolated test evidence retained.\n", "utf8");
  }
});

test("upload file list is checksummed in bounded chunks", () => {
  const files = Array.from({ length: 501 }, (_, index) => ({
    relativePath: `file-${index}.py`,
    fullPath: `/tmp/file-${index}.py`,
    size: index + 1,
  }));
  const sandbox = { crypto, toTarPath: (value) => value };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction("hashUploadPlanChunks") + "\nthis.hash = hashUploadPlanChunks;", sandbox);
  const verification = sandbox.hash(files, 250);
  assert.equal(verification.algorithm, "sha256");
  assert.equal(verification.chunkSize, 250);
  assert.equal(verification.chunks.length, 3);
  assert.match(verification.combinedChecksum, /^[a-f0-9]{64}$/);
});

test("managed upload transfers only files failing remote content verification", () => {
  const localPath = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-delta-"));
  try {
    for (const name of ["same.py", "changed.py", "new.py"]) fs.writeFileSync(path.join(localPath, name), name, "utf8");
    const manifest = {
      "same.py": { size: 7, sha256: "same" },
      "changed.py": { size: 10, sha256: "new-hash" },
      "new.py": { size: 6, sha256: "new" },
    };
    const sandbox = createPlanSandbox(localPath);
    sandbox.sanitizeRelativeUploadPath = (value) => value;
    vm.createContext(sandbox);
    vm.runInContext([
      source.slice(source.indexOf("function getManagedManifest("), source.indexOf("function getMissingManagedFiles(")),
      source.slice(source.indexOf("function isSafeRemoteManagedPath("), source.indexOf("function targetScopeKey(")),
      source.slice(source.indexOf("function createManifestUploadPlan("), source.indexOf("function hashUploadPlanChunks(")),
      "this.createPlan = createManifestUploadPlan;",
    ].join("\n"), sandbox);
    const plan = sandbox.createPlan({ localPath, sftp: {}, manifest, changedPaths: ["changed.py", "new.py"] });
    assert.deepEqual([...plan.files.map((file) => file.relativePath)], ["changed.py", "new.py"]);
    assert.equal(sandbox.createPlan({ localPath, sftp: {}, manifest }).fileCount, 3);
  } finally {
    fs.writeFileSync(path.join(localPath, "KEEP.txt"), "Isolated test evidence retained.\n", "utf8");
  }
});

test("managed uploads write UTF-8 tar directly instead of invoking Windows tar", () => {
  const start = source.indexOf("function runLocalTarUpload");
  const end = source.indexOf("function createRemoteExtractCommand", start);
  assert.ok(start >= 0 && end > start, "missing managed upload implementation");
  const upload = source.slice(start, end);
  assert.doesNotMatch(upload, /createLocalTarArgs/);
  assert.doesNotMatch(source, /"--",\s*\.\.\.relativePaths\.map\(toTarPath\)/);
  assert.doesNotMatch(upload, /spawn\("tar"/);
  assert.match(upload, /writeTarEntriesToStream\(\{ localPath, files: plan\.files, stream: sshProc\.stdin, onFileBytes:/);
  assert.match(upload, /controller\.transferredBytes \+= bytes/);
  assert.match(source, /manifestSha256:/);
  assert.match(source, /hashUploadPlanChunks\(plan\.files\)/);
});

test("tar writer preserves UTF-8 and long POSIX paths", async () => {
  const { execFile } = require("node:child_process");
  const { promisify } = require("node:util");
  const execFileAsync = promisify(execFile);
  const writer = require("../tar-writer.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-tar-"));
  const extract = path.join(root, "extract");
  const unicodeRelative = "数据/实验配置.yaml";
  const longRelative = `${Array.from({ length: 12 }, (_, index) => `directory-${index}`).join("/")}/final-result.txt`;
  fs.mkdirSync(path.dirname(path.join(root, unicodeRelative)), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(root, longRelative)), { recursive: true });
  fs.writeFileSync(path.join(root, unicodeRelative), "中文内容\n");
  fs.writeFileSync(path.join(root, longRelative), "ok\n");

  try {
    const archive = fs.createWriteStream(path.join(root, "workspace.tar"));
    let transferredBytes = 0;
    const written = writer.writeTarEntriesToStream({
      localPath: root,
      files: [
        { relativePath: unicodeRelative, fullPath: path.join(root, unicodeRelative) },
        { relativePath: longRelative, fullPath: path.join(root, longRelative) },
      ],
      stream: archive,
      onFileBytes: (bytes) => { transferredBytes += bytes; },
    });
    await written;
    await new Promise((resolve, reject) => {
      archive.on("error", reject);
      archive.on("finish", resolve);
      archive.end();
    });
    fs.mkdirSync(extract);
    await execFileAsync("tar", ["-xf", path.join(root, "workspace.tar"), "-C", extract], { timeout: 10000, windowsHide: true });
    assert.equal(fs.readFileSync(path.join(extract, unicodeRelative), "utf8"), "中文内容\n");
    assert.equal(fs.readFileSync(path.join(extract, longRelative), "utf8"), "ok\n");
    assert.equal(transferredBytes, Buffer.byteLength("中文内容\n") + Buffer.byteLength("ok\n"));
  } finally {
    fs.writeFileSync(path.join(root, "KEEP.txt"), "Isolated test evidence retained.\n", "utf8");
  }
});

test("managed state uses simple_cluster and reports legacy directories for manual cleanup", () => {
  assert.match(source, /function writeLocalCodeSyncState\(localPath, state\) \{\s*const dir = path\.join\(localPath, "simple_cluster"\);/);
  assert.match(source, /检测到旧版托管路径 \$\{relativePath\}/);
  assert.match(source, /请人工核对后删除本地\/远端旧版 zlk_cluster 目录/);
  assert.doesNotMatch(source, /TARGET_IGNORE_STATE|sftp-target-ignores\.json/);
  const safeTest = source.match(/function isSafeRemoteManagedPath[\s\S]*?\n}/)?.[0] || "";
  assert.match(safeTest, /top === "simple_cluster"/);
});

test("managed manifest trusts caller-selected data files while retaining path safety", () => {
  const localPath = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-data-manifest-"));
  const sandbox = { fs, path, process, ...require("../workspace-path"), vscode: { window: { showWarningMessage() {} } }, toPosixPath: (value) => String(value).replace(/\\/g, "/") };
  vm.createContext(sandbox);
  vm.runInContext([
    source.slice(source.indexOf("function getManagedManifest("), source.indexOf("function getMissingManagedFiles(")),
    source.slice(source.indexOf("function isSafeRemoteManagedPath("), source.indexOf("function targetScopeKey(")),
    "this.getPaths = getManifestUploadRelativePaths;",
  ].join("\n"), sandbox);
  try {
    const allowed = [
      "data/__init__.py",
      "data/auxiliary_views.py",
      "data/multimodal_dataset.py",
      "data/datasets/fixed_protocol_manifest.py",
      "data/protocol_config.yaml",
      "data/datasets/bus_cot_lesion/recipe.yaml",
      "data/patient_info.json",
      "data/sample.npy",
      "data/images/scan.png",
      "data/weights/model.pt",
      "data/patients/subject.py",
      "datasets/loader.py",
    ];
    for (const relativePath of allowed) {
      const file = path.join(localPath, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "content\n");
    }
    const paths = sandbox.getPaths({ localPath, manifest: Object.fromEntries(allowed.map((name) => [name, {}])) });
    assert.deepEqual([...paths].sort(), allowed.sort());
    for (const blocked of [".git/config", ".vscode/settings.json", ".codex/state.json", "../outside.py"]) {
      assert.throws(() => sandbox.getPaths({ localPath, manifest: { [blocked]: {} } }), /不安全的受管理代码路径|非法远端相对路径/);
    }
  } finally {
    fs.writeFileSync(path.join(localPath, "KEEP.txt"), "Isolated test evidence retained.\n", "utf8");
  }
});

test("legacy managed state is copied atomically and remains a read-only source", () => {
  const localPath = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-migration-"));
  try {
    const legacyDir = path.join(localPath, "zlk_cluster");
    const legacyFile = path.join(legacyDir, "code_sync_state.json");
    const newFile = path.join(localPath, "simple_cluster", "code_sync_state.json");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify({ fingerprint: "old", updatedAt: "2026-01-01T00:00:00.000Z" }), "utf8");

    const sandbox = { fs, path, Date, process, console };
    vm.createContext(sandbox);
    vm.runInContext([
      extractFunction("atomicWriteJsonIfMissing"),
      extractFunction("migrateLegacyCodeSyncState"),
      "this.migrate = migrateLegacyCodeSyncState;",
    ].join("\n"), sandbox);
    assert.equal(sandbox.migrate(localPath), true);
    const migrated = JSON.parse(fs.readFileSync(newFile, "utf8"));
    assert.equal(migrated.fingerprint, "old");
    assert.equal(migrated.migration.source, "zlk_cluster/code_sync_state.json");
    assert.equal(fs.existsSync(legacyFile), true);
    const before = fs.readFileSync(newFile, "utf8");
    assert.equal(sandbox.migrate(localPath), false);
    assert.equal(fs.readFileSync(newFile, "utf8"), before);

    const brokenRoot = path.join(localPath, "broken-fixture");
    fs.mkdirSync(path.join(brokenRoot, "zlk_cluster"), { recursive: true });
    fs.writeFileSync(path.join(brokenRoot, "zlk_cluster/code_sync_state.json"), "{broken", "utf8");
    assert.equal(sandbox.migrate(brokenRoot), false);
    assert.equal(fs.existsSync(path.join(brokenRoot, "simple_cluster/code_sync_state.json")), false);
  } finally {
    fs.writeFileSync(path.join(localPath, "KEEP.txt"), "Isolated test evidence retained.\n", "utf8");
  }
});
