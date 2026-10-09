"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const pkg = require("../package.json");
const file = path.join(__dirname, `../simple-sftp-${pkg.version}.vsix`);
const staging = file + ".writing";
const before = fs.existsSync(file) ? fs.lstatSync(file) : undefined;
if (before && (!process.argv.includes("--replace") || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1))
  throw new Error(`Release artifact already exists; rebuilding an owned unpublished package requires --replace: ${file}`);
if (fs.existsSync(staging)) throw new Error(`Inspect the unfinished fixed package slot first: ${staging}`);
const result = spawnSync(process.execPath, [require.resolve("@vscode/vsce/vsce"), "package", "--no-dependencies", "--out", staging, "--allow-missing-repository"], { cwd: path.join(__dirname, ".."), stdio: "inherit", windowsHide: true, timeout: 60000 });
if (result.status !== 0) throw new Error(result.error?.message || "VSIX packaging failed");
if (before) {
  const current = fs.lstatSync(file);
  if (current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size || current.mtimeMs !== before.mtimeMs)
    throw new Error("Release artifact identity changed; fixed staging package retained");
} else if (fs.existsSync(file)) throw new Error("Release artifact appeared during build; fixed staging package retained");
fs.renameSync(staging, file);
