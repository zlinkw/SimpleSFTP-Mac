const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
test("receiver verifies all files before publication, retries fixed slots and closes descriptors", () => {
  const run = spawnSync("python", ["-B", "-X", "utf8", path.join(__dirname, "staged_receive_probe.py")], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /staged receiver verified/);
});
test("receiver bounds metadata, protects unknown owners and consumes staging files by replace", () => {
  const source = fs.readFileSync(path.join(__dirname, "../staged-tar-receive.py"), "utf8");
  assert.match(source, /range\(32\)/);
  assert.match(source, /MAX_METADATA = 65536/);
  assert.match(source, /staged SHA256 mismatch/);
  assert.match(source, /LOCK_EX \| fcntl\.LOCK_NB/);
  assert.match(source, /os\.replace\(/);
  assert.doesNotMatch(source, /os\.unlink\(|rmtree\(|os\.rmdir\(/);
});
for (const scenario of ["resume-slot", "continuous-chunks", "continuous-interruption"]) {
  test(`large-file receiver preserves checkpoint identity: ${scenario}`, () => {
    const run = spawnSync("python", ["-B", "-X", "utf8", path.join(__dirname, "staged_receive_probe.py"), scenario],
      { encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.equal(run.status, 0, (run.stderr || run.stdout || run.error?.message || "").slice(-2000));
    assert.match(run.stdout, /staged receiver verified/);
  });
}
