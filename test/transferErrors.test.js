const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../extension.js"), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const headerEnd = source.indexOf(") {", start);
  assert.ok(headerEnd >= 0, `missing function header ${name}`);
  const body = headerEnd + 2;
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const sandbox = { Error, normalizeSshPort: (port) => Number(port) || 22 };
vm.createContext(sandbox);
vm.runInContext(`${extractFunction("classifyTransportFailure")}\n${extractFunction("classifySftpFailure")}\n${extractFunction("formatProcessFailure")}\nthis.classify = classifyTransportFailure; this.withTarget = classifySftpFailure; this.formatProcess = formatProcessFailure;`, sandbox);

test("command text cannot turn a remote Python error into a false timeout", () => {
  const result = sandbox.classify(new Error("RuntimeError: file changed during inventory"), {
    command: "python3 -c 'db=sqlite3.connect(path,timeout=5)'",
    sshStderr: "RuntimeError: file changed during inventory",
  });
  assert.notEqual(result.category, "transfer_timeout");
});

test("transport failures expose the required diagnostic categories", () => {
  const cases = [
    ["SimpleSFTP 传输超过 600 秒未完成，已停止。", "transfer_timeout"],
    ["ssh: Permission denied (publickey,password).", "ssh_auth_failed"],
    ["connect ECONNREFUSED 127.0.0.1:18766", "dns_tcp_unreachable"],
    ["ssh: connect to host 10.216.245.3 port 22: Connection timed out", "dns_tcp_unreachable"],
    ["getaddrinfo ENOTFOUND gpu.example", "dns_tcp_unreachable"],
    ["mkdir /data/experiments/demo: permission denied", "remote_permission_denied"],
    ["target is outside the configured remote root", "remote_root_validation_failed"],
    ["传输已取消", "user_cancelled"],
  ];
  for (const [message, expected] of cases) {
    const error = sandbox.classify(new Error(message), { sshStderr: message });
    assert.equal(error.category, expected, message);
    assert.ok(error.diagnosis);
    assert.equal(typeof error.retryable, "boolean");
  }
});

test("SSH failure identifies the configured host and actionable cause", () => {
  const error = sandbox.withTarget(
    new Error("ssh: connect to host 10.216.245.3 port 22: Connection timed out"),
    { host: "10.216.245.3", port: 22, remotePath: "/data/project" },
    { sshStderr: "Connection timed out" },
  );
  assert.equal(error.category, "dns_tcp_unreachable");
  assert.match(error.message, /10\.216\.245\.3:22/);
  assert.match(error.message, /核对服务器配置/);
  assert.equal(error.apiData.host, "10.216.245.3");
  assert.equal(error.apiData.port, 22);
});

test("upload SSH exit errors format without a local tar process", () => {
  const message = sandbox.formatProcess({ operation: "上传指定文件", sshCode: 255, sshStderr: "Connection timed out" });
  assert.match(message, /ssh 退出码：255/);
  assert.match(message, /Connection timed out/);
  assert.doesNotMatch(message, /tar 退出码/);
});

test("process failures retain bounded stderr evidence", () => {
  const error = sandbox.classify(new Error("tar failed"), {
    sshCode: 255,
    tarCode: 2,
    sshStderr: "connection refused",
    tarStderr: "tar: x",
  });
  assert.equal(error.details.sshExitCode, 255);
  assert.equal(error.details.tarExitCode, 2);
  assert.match(error.details.tarStderr, /tar: x/);
});
