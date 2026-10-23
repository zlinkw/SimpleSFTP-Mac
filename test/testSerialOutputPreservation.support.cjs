"use strict";

// 回归：scripts/test-serial.js 必须把子进程 stdout+stderr 原文持续落到唯一树外日志（不截断、不囤内存），
// 失败/超时/被杀都返回真实 exitCode/signal/limit 与完整日志引用；控制台只做有界预览；时限只能缩短且不超过 20000ms。
// 夹具是同目录 testSerial*.fixture.js（runner 只扫 *.test.js，不会自扫）；本测试不清理临时树与日志，保留可查。
const test = require("node:test");

const assert = require("node:assert/strict");

const fs = require("node:fs");

const os = require("node:os");

const path = require("node:path");

const { spawnSync } = require("node:child_process");

const projectRoot = path.join(__dirname, "..");

const runner = path.join(projectRoot, "scripts", "test-serial.js");

const serial = require(runner);

const kept = [];

// logParent 用于“同一配置父目录连续两次执行”的回归；默认每次调用用自己的空目录。
function run(fixtureNames, env, logParent) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b-test-serial-"));
  const logs = logParent || path.join(root, "logs");
  const before = fs.existsSync(logs) ? new Set(fs.readdirSync(logs)) : new Set();
  fs.mkdirSync(path.join(root, "test"));
  for (const name of fixtureNames) {
    fs.copyFileSync(path.join(__dirname, name), path.join(root, "test", name.replace(/\.fixture\.js$/, ".test.js")));
  }
  const result = spawnSync(process.execPath, [runner, root], {
    cwd: projectRoot, windowsHide: true, timeout: 19000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8",
    env: Object.assign({}, process.env, { SIMPLESFTP_TEST_SERIAL_LOG_DIR: logs }, env || {}),
  });
  assert.ok(!result.error, "runner spawn failed: " + String(result.error && result.error.message));
  assert.equal(result.signal, null, "runner must exit on its own, got signal " + result.signal);
  kept.push(root);
  // 配置值只是父目录：每次执行必须在其中新开一个 run 目录，日志落在 run 目录里。
  const fresh = fs.readdirSync(logs).filter(name => !before.has(name));
  assert.equal(fresh.length, 1, "每次执行只应新开一个 run 目录：" + JSON.stringify({ before: [...before], after: fs.readdirSync(logs) }));
  const runDir = path.join(logs, fresh[0]);
  assert.ok(fs.statSync(runDir).isDirectory(), "run 目录必须是目录：" + runDir);
  const entries = fs.readdirSync(runDir).filter(name => name.endsWith(".log"));
  assert.equal(entries.length, fixtureNames.length, "每个测试文件必须有一份唯一日志：" + JSON.stringify(entries));
  const logFile = path.join(runDir, entries[0]);
  return { root, logs, runDir, logFile, log: fs.readFileSync(logFile, "utf8"),
    stdout: String(result.stdout || ""), stderr: String(result.stderr || ""), code: result.status };
}

test.after(() => { console.log("test-serial regression trees kept for review: " + kept.join(" ")); });
module.exports={test,assert,fs,os,path,spawnSync,projectRoot,runner,serial,kept,run};
