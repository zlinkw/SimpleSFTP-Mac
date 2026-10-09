"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const run = (command, args, timeout = 10000) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true, timeout });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message); return result.stdout;
};
for (const file of pkg.files.filter(file => file.endsWith(".js"))) run(process.execPath, ["--check", file]);
run("python", ["-B", "-X", "utf8", "scripts/verify-python.py", ...pkg.files.filter(file => file.endsWith(".py"))]);
const included = new Set(run(process.execPath, [require.resolve("@vscode/vsce/vsce"), "ls", "--no-dependencies"], 8000).split(/\r?\n/));
for (const file of pkg.files) assert.ok(included.has(file), `VSIX missing ${file}`);
for (const file of included) assert.ok(!/node_modules|__pycache__|\.pyc$|(^|\/)test\//.test(file), `Unexpected runtime file ${file}`);
for (const file of pkg.files.filter(file => file.endsWith(".js"))) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  for (const match of text.matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
    let target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
    if (!target.endsWith(".js") && !target.endsWith(".json")) target += ".js";
    assert.ok(included.has(target), `Missing local dependency ${file} -> ${target}`);
  }
}
process.stdout.write(`Runtime syntax and VSIX closure: ${pkg.files.length} files verified\n`);
