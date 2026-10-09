"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const source = fs.readFileSync(path.join(__dirname, "../scripts/install-latest.ps1"), "utf8");

for (const trailing of [true, false]) test(`install lock preflight accepts a verified temp parent (trailing separator=${trailing})`, () => {
  const assignment = source.split(/\r?\n/).find(line => line.startsWith("$temporaryRoot = "));
  const check = source.split(/\r?\n/).find(line => line.startsWith("if ((Split-Path -Parent $lockPath)"));
  const command = `$ErrorActionPreference='Stop'; $raw=[System.IO.Path]::GetTempPath(); ${trailing ? "" : "$raw=[System.IO.Path]::TrimEndingDirectorySeparator($raw);"} ${assignment.replace("([System.IO.Path]::GetTempPath())", "$raw")}; $lockPath=Join-Path $temporaryRoot 'simple-sftp-install.lock'; ${check}; Write-Output 'verified'`;
  const run = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /verified/);
  assert.doesNotMatch(source, /--force|Remove-Item|\.Delete\(/);
  assert.match(source, /FileShare\]::None/);
});
