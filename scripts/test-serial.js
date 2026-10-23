"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFile } = require("node:child_process");
const DEFAULT_TIMEOUT_MS = 20000;
const MIN_TIMEOUT_MS = 250;
const PREVIEW_HEAD_BYTES = 4096;
const PREVIEW_TAIL_BYTES = 16384;
// 时限只允许显式“缩短”到合法下界：缺失/非法/超限一律回到 20000ms，绝不放大原上限。
function timeoutLimit() {
  const raw = process.env.SIMPLESFTP_TEST_SERIAL_TIMEOUT_MS;
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(DEFAULT_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)));
}
// 原始 stdout/stderr 按 Buffer 直接落盘：不在内存囤全文，也不逐块 toString 破坏多字节边界。
// 配置值只当作“父目录”：每次执行仍必须在其中 mkdtemp 出独立 run 目录。
// 若直接返回配置目录本身，第二次执行的 open('w') 会把第一次的失败日志原地覆盖，违反“树外唯一保留”。
function logDirectory() {
  const configured = process.env.SIMPLESFTP_TEST_SERIAL_LOG_DIR;
  const parent = configured && String(configured).trim() ? path.resolve(configured) : os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, "run-"));
}
function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return null; }
}
// 失败元数据：exitCode / signal / limitMs 三项独立成行（含 null），不做“三选一”压缩；
// spawn 失败另留系统 code 与日志路径，便于区分“没跑起来”和“跑了但失败”。
function failureReport(file, detail, info) {
  const lines = [file + ": " + detail,
    "exitCode: " + String(info.code),
    "signal: " + String(info.signal),
    "limitMs: " + String(info.limitMs),
    "log: " + info.logFile];
  if (info.systemCode !== undefined) lines.push("spawnSystemCode: " + String(info.systemCode));
  if (info.size !== null && info.size !== undefined) lines.push("size: " + info.size + " bytes");
  if (info.previewText) lines.push(info.previewText);
  return lines.join(String.fromCharCode(10));
}
function decodeFromBoundary(buffer) {
  // 预览可能从多字节字符中间切起：丢掉开头的 UTF-8 后续字节，避免乱码。
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString("utf8");
}
function preview(head, tail) {
  const headText = decodeFromBoundary(head);
  const tailText = decodeFromBoundary(tail);
  const glue = headText && !headText.endsWith(String.fromCharCode(10)) ? String.fromCharCode(10) : "";
  return headText + (tail.length ? glue + "[…完整原文见日志文件…]" + String.fromCharCode(10) + tailText : "");
}
function tailNumber(file, pattern) {
  // 只读日志末尾窗口取汇总行，避免把整份日志读回内存。
  let handle, buffer = Buffer.alloc(0);
  try {
    const size = fs.statSync(file).size;
    const wanted = Math.min(size, 65536);
    buffer = Buffer.alloc(wanted);
    handle = fs.openSync(file, "r");
    fs.readSync(handle, buffer, 0, wanted, size - wanted);
  } catch { return 0; } finally { if (handle !== undefined) fs.closeSync(handle); }
  const matches = [...decodeFromBoundary(buffer).matchAll(pattern)];
  return matches.length ? Number(matches[matches.length - 1][1]) : 0;
}
async function main() {
  let passed = 0;
  // 第二个位置参数只用于回归夹具隔离树；默认仍是本项目根目录，行为不变。
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, "..");
  const limit = timeoutLimit();
  const logs = logDirectory();
  const files = fs.readdirSync(path.join(root, "test")).filter(name => name.endsWith(".test.js")).sort();
  process.stdout.write("test-serial: " + files.length + " files, limit=" + limit + "ms, logs=" + logs + String.fromCharCode(10));
  for (const file of files) {
    const count = await new Promise((resolve, reject) => {
      // NODE_TEST_CONTEXT 由外层 node:test 注入；继承给子集会令 node 打印
      // “run() is being called recursively within a test file. skipping running files.”
      // 并以 0 个用例、退出码 0 伪报通过。这里只删这一个变量，其余环境原样传递。
      const childEnv = Object.assign({}, process.env);
      delete childEnv.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, ["--test", "--test-force-exit", "--test-timeout", String(limit), "--test-reporter=spec", "test/" + file],
        { cwd: root, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: childEnv });
      const logFile = path.join(logs, file.replace(/[^a-zA-Z0-9._-]/g, "_") + ".log");
      // wx：本 run 目录里已存在同名日志就是异常，绝不静默截断既有原文。
      const logFd = fs.openSync(logFile, "wx");
      let head = Buffer.alloc(0), tail = Buffer.alloc(0), timedOut = false;
      const absorb = chunk => {
        const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        fs.writeSync(logFd, piece);
        if (head.length < PREVIEW_HEAD_BYTES) head = Buffer.concat([head, piece.subarray(0, PREVIEW_HEAD_BYTES - head.length)]);
        if (piece.length >= PREVIEW_TAIL_BYTES) tail = Buffer.from(piece.subarray(piece.length - PREVIEW_TAIL_BYTES));
        else tail = Buffer.concat([tail, piece]).subarray(Math.max(0, tail.length + piece.length - PREVIEW_TAIL_BYTES));
      };
      child.stdout.on("data", absorb); child.stderr.on("data", absorb);
      const timer = setTimeout(() => {
        timedOut = true;
        if (process.platform === "win32") execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }, () => {});
        else try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }, limit);
      const finish = run => { clearTimeout(timer); try { fs.closeSync(logFd); } catch {} run(); };
      child.on("error", error => finish(() => reject(new Error(failureReport(file, "spawn failed: " + String(error && error.message), {
        code: null, signal: null, limitMs: limit, logFile, systemCode: error && error.code, size: sizeOf(logFile), previewText: "",
      })))));
      child.on("close", (code, signal) => finish(() => {
        if (code !== 0 || timedOut || signal) {
          const reason = timedOut ? limit / 1000 + " second limit"
            : (signal ? "killed by " + signal : "failed (exit code " + String(code) + ")");
          reject(new Error(failureReport(file, reason, { code, signal, limitMs: limit, logFile, size: sizeOf(logFile), previewText: preview(head, tail) })));
          return;
        }
        // 汇总行由 node:test 打在末尾：只读日志尾部窗口并取最后一次匹配，避免用例正文里出现 pass 字样时误读数量。
        resolve(tailNumber(logFile, /pass (\d+)/g));
      }));
    });
    passed += count; process.stdout.write(`${file}: ${count} passed\n`);
  }
  process.stdout.write(`${files.length} files, ${passed} passed\n`);
}
if (require.main === module) {
  main().catch(error => { process.stderr.write(error.message + String.fromCharCode(10)); process.exitCode = 1; });
}
// 导出纯函数供回归单测直接断言（时限钳制、多字节预览边界），不必再拉子进程碰 node 自身的捕获缺陷。
module.exports = { timeoutLimit, decodeFromBoundary, preview, tailNumber, logDirectory, failureReport, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS };
