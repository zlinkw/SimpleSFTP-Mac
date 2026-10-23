const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { agentPayload } = require("../agent-lifecycle");

// Counterexamples for AGENT_TRANSPORT_FAILED: bash: line 1: python3: command
// not found (installed 0.2.106, agent-lifecycle.js:44).
//
// Seam (per parent review): a Node test must not run the full agent-lifecycle.py
// through `python -c`. The production module is loaded through vm with ONLY its
// fs.readFileSync of agent-lifecycle.py stubbed to the short fixed PROBE below,
// so the REAL generator, REAL zlib bootstrap packing and the REAL resolution/
// dispatch shell are exercised while the executed Python stays a few stdlib
// lines. The full agent-lifecycle.py stays covered by test/agentLifecycle.test.js
// and the existing syntax gates; production interfaces are unchanged.
//
// Fixture "machines": HOME with login profiles (bash AND sh — the fallback tries
// both) that REPLACE PATH (some /etc/profile files add system paths
// unconditionally, so prepending would not prove login-only resolution). Every
// phase is one spawn (<=10s, windowsHide, status asserted); fixtures are KEPT
// and their paths printed. stdout must parse as JSON in whole — no last-line
// tolerance, because ignoring noise is exactly how transport failures hide.

function toMountedPath(target) {
  return target.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive) => "/mnt/" + drive.toLowerCase());
}

const PROBE = [
  "import json,os,shutil,sys",
  "try:",
  "    payload=json.load(sys.stdin)",
  "except Exception as error:",
  "    print(json.dumps({\"ok\": False, \"code\": \"PROBE_STDIN_INVALID\", \"error\": type(error).__name__})); sys.exit(1)",
  "print(json.dumps({\"ok\": True, \"status\": \"absent\", \"payload\": payload,",
  "    \"path\": os.environ.get(\"PATH\", \"\"), \"python\": \"%d.%d\" % sys.version_info[:2],",
  "    \"tmux\": shutil.which(\"tmux\") or \"\"}))",
].join("\n");

function loadGenerator(pythonSource) {
  // Real agent-lifecycle.js, real zlib, real string assembly — only the Python
  // source bytes behind agent-lifecycle.py become the short probe.
  const source = fs.readFileSync(path.join(__dirname, "../agent-lifecycle.js"), "utf8");
  const realFs = require("node:fs");
  const stubFs = Object.assign(Object.create(null), realFs, {
    readFileSync: (target, ...rest) => String(target).endsWith("agent-lifecycle.py")
      ? Buffer.from(pythonSource, "utf8") : realFs.readFileSync(target, ...rest),
  });
  const module = { exports: {} };
  const context = vm.createContext({
    require: name => name === "node:fs" ? stubFs : require(name),
    module, exports: module.exports, process, console, Buffer,
    __dirname: path.join(__dirname, ".."), __filename: path.join(__dirname, "..", "agent-lifecycle.js"),
  });
  vm.runInContext(source, context, { filename: "agent-lifecycle.js" });
  return module.exports;
}
const agentRemoteCommand = loadGenerator(PROBE).agentRemoteCommand;

function runShell(envAssignments, command, stdin, shell) {
  const envArgs = ["-i", ...envAssignments, shell || "/bin/sh", "-c", command];
  const opts = { encoding: "utf8", timeout: 10000, windowsHide: true, input: stdin === undefined ? "" : stdin };
  const proc = process.platform === "win32"
    ? spawnSync("wsl.exe", ["--distribution", process.env.SIMPLE_TEST_WSL_DISTRO || "Ubuntu-Codex",
        "--exec", "/usr/bin/env", ...envArgs], opts)
    : spawnSync("/usr/bin/env", envArgs, opts);
  assert.ok(!proc.error, `spawn failed: ${proc.error && proc.error.message}`);
  return proc;
}

// bin/<name> wrappers delegate to the real system interpreter (the WSL/POSIX
// convention resolves it as /usr/bin/python3 in the target environment). A
// fake2 wrapper behaves like a Python 2 install for everything the resolution
// protocol can observe: it fails the stdlib version probe.
function makeWrapper(dir, name, target) {
  // env-sh targets model a pyenv-style transparent shim: the `env` shebang only
  // resolves when the candidate runs inside its login PATH context.
  const base = target.startsWith("env-") ? "#!/usr/bin/env sh\n" : "#!/bin/sh\n";
  const body = target === "fake2" || target === "env-fake2"
    ? base + "case \"$2\" in *version_info*) exit 1;; esac\nexec /usr/bin/python3 \"$@\"\n"
    : base + "exec /usr/bin/" + target.replace(/^env-/, "") + " \"$@\"\n";
  fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
  fs.chmodSync(path.join(dir, name), 0o755);
}
function populateBin(bin, binNames) {
  if (!fs.existsSync(bin)) fs.mkdirSync(bin); // never deletes, never replaces
  for (const spec of binNames) makeWrapper(bin, spec[0], spec[1]);
  // A replaced login PATH has no system shell unless the machine ships one; the
  // env-shebang shim needs `sh` on that PATH exactly like a real pyenv needs its
  // environment. Ship an ordinary executable wrapper delegating to /bin/sh —
  // never a symlink (Windows resolves the link target against its own drive and
  // EPERMs), no privilege changes, no skipping; it lives only inside the kept
  // fixture.
  fs.writeFileSync(path.join(bin, "sh"), "#!/bin/sh\nexec /bin/sh \"$@\"\n", { mode: 0o755 });
  fs.chmodSync(path.join(bin, "sh"), 0o755);
  return bin;
}
function makeBin(binNames) {
  return populateBin(fs.mkdtempSync(path.join(os.tmpdir(), "agent-py-bin-")), binNames);
}
function fixtureHome(binNames) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-py-home-"));
  const bin = path.join(home, "bin");
  // Create precisely: verify absence, then mkdir the exact directory in place.
  // No delete, no rename over anything (manual-cleanup-only rule); every
  // created fixture stays on disk.
  assert.ok(!fs.existsSync(bin), "fresh fixture home must not pre-exist: " + home);
  populateBin(bin, binNames);
  return home;
}
function writeProfile(home, lines, shLines) {
  fs.writeFileSync(path.join(home, ".bash_profile"), lines.join("\n") + "\n", "utf8");
  fs.writeFileSync(path.join(home, ".profile"), (shLines || lines).join("\n") + "\n", "utf8");
}
function toolsDir(extra) {
  // An inherited-PATH directory carrying only auxiliary tools (a read-only tmux
  // helper the probe must be able to resolve), never a python name.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-py-tools-"));
  makeWrapper(dir, "tmux", "tmux");
  if (extra) for (const spec of extra) makeWrapper(dir, spec[0], spec[1]);
  return dir;
}

function inspectPayload() {
  // A fresh uninstalled project/install pair with the exact auxiliary identity;
  // the probe echoes the stdin payload back so equality proves stdin survived
  // the shell, allowlist and interpreter intact.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-py-case-"));
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  fs.mkdirSync(path.join(root, "agent"), { recursive: true });
  const payload = agentPayload({ action: "inspect",
    projectDir: toMountedPath(path.join(root, "project")), installDir: toMountedPath(path.join(root, "agent")),
    mode: "worker_telemetry", workerId: "resolution-test", host: "127.0.0.1", port: 23099,
    tmuxSession: "simple-worker-resolution-test-agent", tmuxWindow: "agent" });
  return { root, payload };
}
function wholeJson(stdout, context) {
  assert.ok(!/welcome banner|decoy|trailing note|not found/.test(String(stdout)),
    "stdout must carry only the JSON result: " + JSON.stringify(String(stdout)) + " " + context);
  return JSON.parse(String(stdout));
}
function assertExecuted(result, payload) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "absent", JSON.stringify(result));
  // The wire bytes are JSON.stringify(payload); undefined-valued allowlist keys
  // drop on encode, so the byte-exact reference is the encoded form itself.
  assert.deepEqual(result.payload, JSON.parse(JSON.stringify(payload)),
    "stdin payload must arrive byte-exact through the allowlist");
  assert.match(result.python, /^3\./, "executed interpreter must be Python 3: " + result.python);
}

const OLD_COMMAND = "python3 -c 'print(1)'"; // the exact 0.2.106 spelling, reduced

test("counterexample: with an uninitialised non-interactive PATH but a machine that HAS python via its own login profile, the hardcoded python3 -c form fails exactly as reported", () => {
  const home = fixtureHome([["python3", "python3"]]);
  writeProfile(home, ["PATH=" + toMountedPath(home) + "/bin", "export PATH"]);
  // Field shells are bash (the report says "bash: line 1:"); run the old form
  // under bash so the reproduction matches the production wording exactly.
  const proc = runShell(["PATH=/nonexistent", "HOME=" + toMountedPath(home)], OLD_COMMAND, undefined, "/bin/bash");
  assert.notEqual(proc.status, 0);
  assert.match(proc.stderr + proc.stdout, /bash: line 1: python3: command not found/);
  assert.equal(String(proc.stdout).trim(), "");
  console.log("kept fixture (old-form counterexample) at " + home);
});

test("regression: the command resolves python from the login profile alone, execs it with the login PATH so auxiliary tmux resolves, and stdin arrives byte-exact", () => {
  const home = fixtureHome([["python3", "python3"], ["tmux", "tmux"]]);
  writeProfile(home, ["PATH=" + toMountedPath(home) + "/bin", "export PATH"]);
  const { root, payload } = inspectPayload();
  const proc = runShell(["PATH=/nonexistent", "HOME=" + toMountedPath(home)], agentRemoteCommand(), JSON.stringify(payload));
  console.log("kept fixture (login-profile resolution) at " + home + " / case at " + root);
  assert.equal(proc.status, 0, proc.stdout + proc.stderr);
  const result = wholeJson(proc.stdout, proc.stderr);
  assertExecuted(result, payload);
  assert.ok(result.path.split(":").includes(toMountedPath(home) + "/bin"),
    "login PATH must travel with the login interpreter: " + result.path);
  assert.equal(result.tmux, toMountedPath(home) + "/bin/tmux",
    "bare tmux must resolve from the same machine configuration: " + result.tmux);
});

test("regression: a machine exposing only `python` (Python 3, no python3) is resolved through the same fixed candidate list", () => {
  const home = fixtureHome([["python", "python3"]]);
  writeProfile(home, ["PATH=" + toMountedPath(home) + "/bin", "export PATH"]);
  const { root, payload } = inspectPayload();
  const proc = runShell(["PATH=" + toMountedPath(toolsDir()), "HOME=" + toMountedPath(home)], agentRemoteCommand(), JSON.stringify(payload));
  console.log("kept fixture (python-only) at " + home + " / case at " + root);
  assert.equal(proc.status, 0, proc.stdout + proc.stderr);
  assertExecuted(wholeJson(proc.stdout, proc.stderr), payload);
});

test("regression: a normal initialized PATH resolves and execs directly, environment unchanged, without consulting any profile", () => {
  const home = fixtureHome([]);
  writeProfile(home, ["echo SHOULD-NOT-RUN-PROFILE >> " + toMountedPath(home) + "/profile-ran 2>/dev/null || true"]);
  const { root, payload } = inspectPayload();
  const realPy = toolsDir([["python3", "python3"]]);
  const proc = runShell(["PATH=" + toMountedPath(realPy), "HOME=" + toMountedPath(home)], agentRemoteCommand(), JSON.stringify(payload));
  console.log("kept fixture (plain PATH) at " + realPy + " / case at " + root);
  assert.equal(proc.status, 0, proc.stdout + proc.stderr);
  const result = wholeJson(proc.stdout, proc.stderr);
  assertExecuted(result, payload);
  assert.equal(result.path, toMountedPath(realPy), "inherited PATH must pass through unchanged: " + result.path);
  assert.equal(result.tmux, toMountedPath(realPy) + "/tmux");
  assert.ok(!fs.existsSync(path.join(home, "profile-ran")), "must not run login profiles when PATH already resolves");
});

test("counterexample: login profile noise (echoes, decoy paths, PATH churn) cannot pollute resolution or the result stream", () => {
  const home = fixtureHome([["python3", "python3"]]);
  writeProfile(home, ["echo welcome banner", "PATH=/also-missing",
    "echo /decoy/not/real", "PATH=" + toMountedPath(home) + "/bin", "export PATH", "echo trailing note"]);
  const { root, payload } = inspectPayload();
  const proc = runShell(["PATH=" + toMountedPath(toolsDir()), "HOME=" + toMountedPath(home)], agentRemoteCommand(), JSON.stringify(payload));
  console.log("kept fixture (noisy profile) at " + home + " / case at " + root);
  assert.equal(proc.status, 0, proc.stdout + proc.stderr);
  assert.ok(!/welcome banner|decoy|trailing note/.test(proc.stdout), "profile noise leaked to stdout: " + proc.stdout);
  assertExecuted(wholeJson(proc.stdout, proc.stderr), payload);
});

test("counterexample: a machine that truly exposes no interpreter yields structured AGENT_PYTHON_NOT_RESOLVED, not a shell error or fake ok", () => {
  const home = fixtureHome([["tmux", "tmux"]]); // the machine's own login PATH exposes no python at all
  writeProfile(home, ["PATH=" + toMountedPath(home) + "/bin", "export PATH"]);
  const proc = runShell(["PATH=" + toMountedPath(toolsDir()), "HOME=" + toMountedPath(home)], agentRemoteCommand(), "{}");
  console.log("kept fixture (no interpreter) at " + home);
  assert.equal(proc.status, 1);
  const result = wholeJson(proc.stdout, proc.stderr);
  assert.equal(result.ok, false);
  assert.equal(result.code, "AGENT_PYTHON_NOT_RESOLVED");
  assert.ok(!/command not found/.test(proc.stderr), "must not surface shell noise: " + proc.stderr);
});

test("counterexample: a machine whose only login candidate is Python 2 yields structured AGENT_PYTHON_VERSION_UNSUPPORTED instead of execing it", () => {
  const home = fixtureHome([["python", "fake2"]]);
  writeProfile(home, ["PATH=" + toMountedPath(home) + "/bin", "export PATH"]);
  const { root, payload } = inspectPayload();
  const proc = runShell(["PATH=" + toMountedPath(toolsDir()), "HOME=" + toMountedPath(home)], agentRemoteCommand(), JSON.stringify(payload));
  console.log("kept fixture (python2-only) at " + home + " / case at " + root);
  assert.equal(proc.status, 1);
  const result = wholeJson(proc.stdout, proc.stderr);
  assert.equal(result.ok, false);
  assert.equal(result.code, "AGENT_PYTHON_VERSION_UNSUPPORTED");
});

test("regression: an incompatible PATH `python` does not stop the search — the login shell's Python 3 candidate is execed", () => {
  const home = fixtureHome([["python3", "python3"], ["tmux", "tmux"]]);
  writeProfile(home, ["PATH=" + toMountedPath(home) + "/bin", "export PATH"]);
  const { root, payload } = inspectPayload();
  const badPy = toolsDir([["python", "fake2"]]); // inherited PATH offers ONLY the incompatible candidate
  const proc = runShell(["PATH=" + toMountedPath(badPy), "HOME=" + toMountedPath(home)], agentRemoteCommand(), JSON.stringify(payload));
  console.log("kept fixture (py2 on PATH, py3 in profile) at " + badPy + " / " + home + " / case at " + root);
  assert.equal(proc.status, 0, proc.stdout + proc.stderr);
  const result = wholeJson(proc.stdout, proc.stderr);
  assertExecuted(result, payload);
  assert.equal(result.tmux, toMountedPath(home) + "/bin/tmux", "login-stage helper tool must come from the login PATH");
});

test("regression: an env-shebang login candidate (only runnable in the login PATH context) is execed, not misjudged unsupported", () => {
  // A pyenv-style transparent shim uses `#!/usr/bin/env sh`; probing it on the
  // raw ssh PATH fails to find sh and would wrongly answer VERSION_UNSUPPORTED.
  const home = fixtureHome([["python3", "env-python3"], ["tmux", "tmux"]]);
  writeProfile(home, ["PATH=" + toMountedPath(home) + "/bin", "export PATH"]);
  const { root, payload } = inspectPayload();
  const proc = runShell(["PATH=/nonexistent", "HOME=" + toMountedPath(home)], agentRemoteCommand(), JSON.stringify(payload));
  console.log("kept fixture (env-shebang login shim) at " + home + " / case at " + root);
  assert.equal(proc.status, 0, proc.stdout + proc.stderr);
  const result = wholeJson(proc.stdout, proc.stderr);
  assertExecuted(result, payload);
  assert.equal(result.tmux, toMountedPath(home) + "/bin/tmux");
});

test("regression: an incompatible python3 from .bash_profile does not block the valid python3 that .profile exposes", () => {
  const bashBin = makeBin([["python3", "env-fake2"]]); // bash login PATH offers only the incompatible shim
  const shBin = makeBin([["python3", "env-python3"], ["tmux", "tmux"]]); // sh login PATH has the real one
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-py-home-"));
  writeProfile(home, ["PATH=" + toMountedPath(bashBin), "export PATH"],
    ["PATH=" + toMountedPath(shBin), "export PATH"]);
  const { root, payload } = inspectPayload();
  const proc = runShell(["PATH=/nonexistent", "HOME=" + toMountedPath(home)], agentRemoteCommand(), JSON.stringify(payload));
  console.log("kept fixture (bash-incompatible vs sh-valid) at " + home + " / " + bashBin + " / " + shBin + " / case at " + root);
  assert.equal(proc.status, 0, proc.stdout + proc.stderr);
  const result = wholeJson(proc.stdout, proc.stderr);
  assertExecuted(result, payload);
  assert.equal(result.tmux, toMountedPath(shBin) + "/tmux", "must have execed the .profile candidate with the .profile PATH");
});

test("regression: the REAL unstubbed command fits the Windows CreateProcess command-line limit with ssh prefix margin, without executing any Python", () => {
  const { agentRemoteCommand: realCommand } = require("../agent-lifecycle");
  const command = realCommand(); // full compressed agent-lifecycle.py, never run here
  const bootstrapCopies = command.split("base64.b64decode").length - 1;
  console.log("real remote command length: " + command.length + " chars, bootstrap copies: " + bootstrapCopies);
  assert.equal(bootstrapCopies, 1, "the payload may only be carried once (by __run)");
  // 32767 total for CreateProcess; leave >4.5KB for ssh.exe path, options and
  // the host target on top of the single payload.
  assert.ok(command.length < 28000, "command too long for a safe ssh spawn: " + command.length);
});

test("no injection surface: the command is a constant carrying zero caller input, and the fixed allowlist still drops caller commands/env", () => {
  const command = agentRemoteCommand();
  assert.equal(typeof command, "string");
  assert.ok(!command.includes("eval"), "no eval");
  assert.ok(!command.includes("awk"), "login fallback must be builtins only");
  // Caller-independent: two calls are byte-identical (payload never reaches it).
  assert.equal(agentRemoteCommand(), command);
  // Fixed candidate list; both names must be probed, and no absolute interpreter
  // path may be baked in (shell infrastructure paths /bin/bash /bin/sh aside).
  assert.ok(command.includes("command -v python3") && command.includes("command -v python)"));
  assert.match(command, /sys\.version_info\[0\]>=3/);
  assert.match(command, /@@agentpy:.*@@agentpy2:.*@@agentpath:/s);
  assert.match(command, /\$\{__L:\+:\}\$PATH/);
  assert.match(command, /__run "\$__a";/);
  assert.equal(command.split("base64.b64decode").length - 1, 1, "single payload copy");
  assert.ok(command.includes("AGENT_PYTHON_VERSION_UNSUPPORTED") && command.includes("AGENT_PYTHON_NOT_RESOLVED"));
  assert.ok(!/\/(usr|opt)\/(env )?python/.test(command), "no baked interpreter path: " + command.slice(0, 200));
  // The auxiliary agent payload keeps its fixed allowlist: caller command/env
  // keys are dropped (agentPayload's contract is filtering, not throw).
  const hostile = agentPayload({ action: "inspect", projectDir: "/srv/p", installDir: "/srv/a",
    mode: "worker_telemetry", workerId: "w", host: "h", port: 22, program: "echo marker",
    env: { MARKER: "1" }, command: "echo marker-only" });
  assert.ok(!("program" in hostile) && !("env" in hostile) && !("command" in hostile));
});
