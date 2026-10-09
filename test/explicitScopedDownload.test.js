const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../extension.js"), "utf8");
const start = source.indexOf("function normalizeDownloadExtensions(");
const end = source.indexOf("async function configureDownloadScope(", start);
assert.ok(start >= 0 && end > start);
const sandbox = {
  path,
  DEFAULT_DOWNLOAD_EXTENSIONS: ["*"],
  DEFAULT_DOWNLOAD_MAX_FILE_SIZE_MB: 1024,
  toPosixPath: (value) => String(value).replace(/\\/g, "/"),
};
vm.createContext(sandbox);
vm.runInContext(source.slice(start, end) + "\nthis.explicit = explicitDownloadScope", sandbox);

test("explicit download selects only named paths without file type or size limits", () => {
  const scope = sandbox.explicit({ paths: ["results/weights.pt", "results/logs"] });
  assert.deepEqual([...scope.paths], ["results/logs", "results/weights.pt"]);
  assert.deepEqual([...scope.extensions], ["*"]);
  assert.equal(scope.maxFileSizeMB, null);
  assert.equal(scope.noSizeLimit, true);
  assert.throws(() => sandbox.explicit({ paths: [] }), /禁止选择整个项目根目录/);
  assert.throws(() => sandbox.explicit({ paths: ["."] }), /禁止选择整个项目根目录/);
  assert.throws(() => sandbox.explicit({ paths: ["../outside"] }), /相对路径/);
  assert.match(source, /hasTargetOptions \? resolveUploadSftp\(localPath, options\) : readSftpConfig\(localPath\)/);
  assert.match(source, /scopedPaths \? explicitDownloadScope\(options\) : readTargetDownloadScope/);
  assert.match(source, /"sync\.downloadPaths": async/);
  assert.match(source, /assertSafeScopedLocalPaths\(localPath, downloadScope\.paths\)/);
});
