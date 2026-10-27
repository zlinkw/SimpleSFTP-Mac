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
  assert.match(source, /MAX_METADATA = 65536/);
  assert.match(source, /staged SHA256 mismatch/);
  assert.match(source, /LOCK_EX \| fcntl\.LOCK_NB/);
  assert.match(source, /os\.replace\(/);
  assert.doesNotMatch(source, /os\.unlink\(|rmtree\(|os\.rmdir\(/);
  // Staging lives in identity-owned two-slot directories; foreign checkpoints are never silently cleared.
  assert.match(source, /STAGING_CONTAINER = "simple_cluster"/);
  assert.match(source, /STAGING_DIRECTORY = "\.simple-sftp-staging"/);
  assert.match(source, /IDENTITY_SLOTS = \("0", "1"\)/);
  assert.match(source, /TRANSFER_STAGE_PENDING/);
  assert.doesNotMatch(source, /scrub_terminal_slot|OWNED_SLOT_FILE|os\.listdir|range\(32\)/);
  // r118: the receiver itself still never deletes — expiry evidence is FACTS plus a fail-closed
  // verdict only. terminalAt is stamped at commit; the trusted age basis may read ONLY the
  // journal manifest's own non-followed mtime, never slot/lock/data mtimes; refusals gain the
  // additive SIMPLE_STAGE_PENDING machine-readable line without touching the error text.
  assert.doesNotMatch(source, /os\.unlink\(|rmtree\(|os\.rmdir\(/);
  assert.match(source, /payload\["terminalAt"\]/);
  assert.match(source, /SIMPLE_STAGE_PENDING/);
  assert.match(source, /follow_symlinks=False\)\.st_mtime/);
  assert.doesNotMatch(source, /expiry_ms is not None[\s\S]*?unlink/);
});
for (const scenario of ["generation-rotation", "continuous-chunks", "continuous-interruption", "foreign-admission", "same-key-admission"]) {
  test(`large-file receiver preserves checkpoint identity: ${scenario}`, () => {
    const run = spawnSync("python", ["-B", "-X", "utf8", path.join(__dirname, "staged_receive_probe.py"), scenario],
      { encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.equal(run.status, 0, (run.stderr || run.stdout || run.error?.message || "").slice(-2000));
    assert.match(run.stdout, /staged receiver verified/);
  });
}
