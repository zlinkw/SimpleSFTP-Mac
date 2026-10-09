"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
async function main() {
  let passed = 0;
  const files = fs.readdirSync(path.join(__dirname, "../test")).filter(name => name.endsWith(".test.js")).sort();
  for (const file of files) {
    const count = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--test", "--test-force-exit", "--test-timeout", "20000", "--test-reporter=spec", "test/" + file], { cwd: path.join(__dirname, ".."), windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      let output = "", timedOut = false;
      const receive = chunk => { output = (output + chunk.toString("utf8")).slice(-65536); };
      child.stdout.on("data", receive); child.stderr.on("data", receive);
      const timer = setTimeout(() => {
        timedOut = true;
        if (process.platform === "win32") execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }, () => {});
        else try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }, 20000);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", code => {
        clearTimeout(timer);
        if (code !== 0 || timedOut) reject(new Error(`${file}: ${timedOut ? "20 second limit" : "failed"}\n${output}`));
        else resolve(Number(/pass (\d+)/.exec(output)?.[1] || 0));
      });
    });
    passed += count; process.stdout.write(`${file}: ${count} passed\n`);
  }
  process.stdout.write(`${files.length} files, ${passed} passed\n`);
}
main().catch(error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
