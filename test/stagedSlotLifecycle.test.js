const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const identity = "11".repeat(32);
const generation = "c3".repeat(32);

// The fixture runs as two independently budgeted sections (the G2 host run showed the single
// combined run crossing the spawn budget once the release scenarios grew): SAME file, SAME real
// engine and receiver, section selected by argv. The union of the two verdict dicts equals the
// old single verdict key-for-key — nothing moved off, nothing weakened, no timeout changed.
function runFixture(...section) {
  const nativeFiles = [path.join(__dirname, "stagedSlotLifecycle.fixture.py"),
    path.resolve(__dirname, "../staged-tar-receive.py"), path.resolve(__dirname, "../cleanup-files.py")];
  const distro = process.env.SIMPLE_TEST_WSL_DISTRO || "Ubuntu-Codex";
  const files = process.platform === "win32" ? nativeFiles.map(file => {
    const resolved = spawnSync("wsl.exe", ["--distribution", distro, "--exec", "wslpath", "-a", file],
      { encoding: "utf8", timeout: 5000, windowsHide: true });
    assert.equal(resolved.status, 0, resolved.stderr || resolved.error?.message);
    return resolved.stdout.trim();
  }) : nativeFiles;
  const argv = ["-B", "-X", "utf8", ...files, ...section];
  const run = process.platform === "win32"
    ? spawnSync("wsl.exe", ["--distribution", distro, "--exec", "python3", ...argv],
      { encoding: "utf8", timeout: 10000, windowsHide: true })
    : spawnSync("python3", argv, { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(run.status, 0, (run.stderr || run.stdout || "").slice(-3000));
  return JSON.parse(run.stdout.trim().split("\n").pop());
}

test("staged slots keep two generations end to end: preview, fail-closed third, confirmed executor, landing", () => {
  assert.deepEqual(runFixture("core"),
    { ok: true, pendingBlocked: true, leaving: "simple_cluster/.simple-sftp-staging/d-" + "1".repeat(24) + "/0", thirdGenerationLanded: true,
      hardlinkPublication: { tarPublished: true, pendingAliasPreserved: true, chunkPublished: true,
        normalTargetPublished: true, directoryTargetRejected: true, symlinkTargetRejected: true },
      // r118: every expiry/protection scenario ran against the REAL receiver and engine entries.
      expiryReclaim: { terminalAtWritten: true, journalTerminalAtCarried: true, expiredOldGenerationTrue: true,
        claimStillPending: true, structuredPendingFacts: true, boundaryAtLeastDay: true, boundaryJustBelow: true,
        futureProtected: true, contradictionProtected: true, mtimeAgedExpired: true, mtimeFreshProtected: true,
        sameGenerationNoReclaim: true, inventoryRolesHeld: true, corruptProtected: true, lockedProtected: true,
        slotLockHeldBlocksIsolate: true, isolateAfterRelease: true, claimAdmitted: true,
        // r118 final review: malformed times never fall back; the reclaim binding is re-proven under lock.
        malformedTimeProtected: true, malformedNoOlderFallback: true, mtimeContradictionProtected: true,
        legacyFallbackStillWorks: true, reclaimBindingNonTerminalRefused: true,
        reclaimBindingGenerationChangedRefused: true, reclaimBindingFreshCommitRefused: true,
        reclaimBindingTerminalRemovedRefused: true, reclaimBindingCreatedAfterTerminalRefused: true,
        reclaimBindingLegacyNullUpdateRefused: true, reclaimBindingUnchangedAccepted: true } });
});

// 0.2.114: the user-confirmed early release works on the REAL filesystem, while every
// other under-lock rule still denies it, defaults stay byte-identical and capability
// answers are truthful (staged slots answer, everything else stays silent).
test("0.2.114 user-confirmed early release: the young slot isolates ONLY in requireExpired:false mode; every other rule still denies", () => {
  assert.deepEqual(runFixture("release"), { ok: true, userRelease: {
    userReleaseYoungAccepted: true, userReleaseAbsentStillRefused: true, userReleaseTrueStillRefused: true,
    userReleaseModeNotBooleanRefused: true, userReleaseGenerationSwapRefused: true,
    userReleaseNonTerminalRefused: true, userReleaseFreshCommitRefused: true,
    userReleaseMalformedTimeRefused: true, userReleaseFutureTimeRefused: true,
    userReleaseCreatedContradictionRefused: true, userReleaseJournalRemovedRefused: true,
    userReleaseJournalRemovedDefaultRefused: true, userReleaseJournalCorruptRefused: true,
    userReleaseJournalCorruptDefaultRefused: true, userReleaseJournalNonObjectRefused: true,
    userReleaseJournalNonObjectDefaultRefused: true,
    userReleaseInspectProof: true, userReleaseInspectAnswers: true } });
});

// The extension-side production request builder must encode the SAME read-only protocol the
// receiver just executed: inventory omits generation; admission carries the incoming one.
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  return request === "vscode" ? {
    TreeItem: class {},
    ProgressLocation: { Notification: 1 },
    window: { withProgress: (_options, operation) => operation({ report: () => undefined }), showErrorMessage: () => undefined },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  } : originalLoad.call(this, request, ...args);
};
const { __test } = require("../extension.js");
Module._load = originalLoad;

function requestPayload(command) {
  const quoted = /'([A-Za-z0-9+/=]+)'$/.exec(command);
  assert.ok(quoted, command.slice(-200));
  return JSON.parse(zlib.inflateRawSync(Buffer.from(quoted[1], "base64")).toString("utf8"));
}

test("staged slot stale-report commands carry stable logicalKey and only the incoming generation", () => {
  const target = { remotePath: "/srv/project" };
  const inventory = requestPayload(__test.stagedSlotStaleReportCommand(target, identity));
  assert.deepEqual(inventory, { mode: "staleReport", root: "/srv/project", identity });
  const admission = requestPayload(__test.stagedSlotStaleReportCommand(target, identity, generation));
  assert.deepEqual(admission, { mode: "staleReport", root: "/srv/project", identity, generation });
});

test("production archive builder keeps the scope across changed selections and run retries", () => {
  const target = { remotePath: "/srv/project" };
  const files = { "out/a": { sha256: "a".repeat(64), size: 1 },
    "out/b": { sha256: "b".repeat(64), size: 1 } };
  const build = (key, run, paths, extra = {}) => requestPayload(__test.stagedTarUnpackingCommand(
    target, "none", { retentionKey: key, generation: run, ...extra }, files, paths));
  const first = build("plans/a.yaml|task-0", "run-1", ["out/a"]);
  const retry = build("plans/a.yaml|task-0", "run-1", ["out/b"]);
  const next = build("plans/a.yaml|task-0", "run-2", ["out/a", "out/b"]);
  const other = build("plans/b.yaml|task-0", "run-1", ["out/a"]);
  assert.equal(first.identity, retry.identity);
  assert.equal(first.identity, next.identity);
  assert.equal(first.generation, retry.generation);
  assert.notEqual(first.generation, next.generation);
  assert.notEqual(first.identity, other.identity);
  assert.notEqual(first.identity, build("plans/a.yaml|task-0", "run-1", ["out/a"], { stagingLane: 1 }).identity);
  // The two lanes are fixed; arbitrarily many archive partitions never open additional pools.
  assert.equal(first.identity, build("plans/a.yaml|task-0", "run-1", ["out/b"], { stagingLane: 99 }).identity);
});

// ---------------------------------------------------------------------------
// r118 extension-side contracts: the stage block fields are FROZEN here (SE wires
// against exactly this shape), expiry defaults come from the registered package
// configuration, and the claim-scoped reclaim drives the managed chain exactly
// once — an unknown isolation outcome is never replayed.
// ---------------------------------------------------------------------------

test("expiry defaults are registered and can never fall below the ruled one-day floor", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
  const props = pkg.contributes.configuration.properties;
  assert.equal(pkg.version, "0.2.105");
  assert.equal(props["simpleSftpMac.autoReclaimExpiredCommittedSlots"].type, "boolean");
  assert.equal(props["simpleSftpMac.autoReclaimExpiredCommittedSlots"].default, true);
  assert.equal(props["simpleSftpMac.stagedSlotCommittedExpiryMs"].default, 86400000);
  assert.equal(props["simpleSftpMac.stagedSlotCommittedExpiryMs"].minimum, 86400000);
  // The stubbed vscode config falls back to the schema defaults: the automatic chain is ON by default.
  const settings = __test.stagedSlotExpirySettings();
  assert.equal(settings.enabled, true);
  assert.equal(settings.expiryMs, 86400000);
});

test("stale-report expiry is requested explicitly and older request shapes stay byte-identical", () => {
  const target = { remotePath: "/srv/project" };
  assert.deepEqual(requestPayload(__test.stagedSlotStaleReportCommand(target, identity, generation, 86400000)),
    { mode: "staleReport", root: "/srv/project", identity, generation, expiry: { ms: 86400000 } });
  assert.deepEqual(requestPayload(__test.stagedSlotStaleReportCommand(target, identity, generation)),
    { mode: "staleReport", root: "/srv/project", identity, generation });
  assert.deepEqual(requestPayload(__test.stagedSlotStaleReportCommand(target, identity)),
    { mode: "staleReport", root: "/srv/project", identity });
});

test("stage block is the frozen SE contract: JS fills host/profile/scope/lane around Python slot facts", () => {
  const slot0 = "simple_cluster/.simple-sftp-staging/d-" + identity.slice(0, 24) + "/0";
  const slot1 = "simple_cluster/.simple-sftp-staging/d-" + identity.slice(0, 24) + "/1";
  const context = { destination: { host: "worker-7.example", id: "worker-7", remotePath: "/srv/project" },
    profile: "zlk-prod", scope: "plans/a.yaml|task-0", lane: 1, identity, incomingGeneration: generation };
  const leaving = { path: slot0, status: "committed", generation: "a".repeat(64), createdAt: 1, terminalAt: 2,
    updatedAt: 3, timeSource: "terminalAt", ageMs: 90000000, locked: false };
  const lockedSlot = { path: slot1, status: "locked", generation: "b".repeat(64), createdAt: 4, terminalAt: 0,
    updatedAt: 5, timeSource: null, ageMs: null, locked: true, protectedReason: "slot-locked" };
  const block = __test.stagedSlotStageBlock(context, { stale: [leaving], slots: [leaving, lockedSlot] });
  assert.deepEqual(Object.keys(block).sort(),
    ["code", "destination", "identity", "incomingGeneration", "lane", "releaseCandidate", "schemaVersion", "scope", "slots"]);
  assert.equal(block.schemaVersion, 1);
  assert.equal(block.code, "TRANSFER_STAGE_PENDING");
  assert.deepEqual(block.destination, { id: "worker-7", profile: "zlk-prod", host: "worker-7.example" });
  assert.equal(block.scope, "plans/a.yaml|task-0");
  assert.equal(block.lane, 1);
  assert.equal(block.identity, identity);
  assert.equal(block.incomingGeneration, generation);
  assert.deepEqual(Object.keys(block.slots[0]).sort(),
    ["ageMs", "createdAt", "generation", "locked", "path", "protectedReason", "slot", "status", "terminalAt", "timeSource", "updatedAt"]);
  assert.equal(block.slots[0].slot, "0");
  assert.equal(block.slots[0].terminalAt, 2);
  assert.equal(block.slots[1].locked, true);
  assert.equal(block.slots[1].protectedReason, "slot-locked");
  assert.equal(block.releaseCandidate, true);
  // Locked, non-terminal or absent leaving slots are NEVER presented as releasable.
  assert.equal(__test.stagedSlotStageBlock(context, { stale: [{ ...leaving, locked: true }], slots: [] }).releaseCandidate, false);
  assert.equal(__test.stagedSlotStageBlock(context, { stale: [{ ...leaving, status: "preparing" }], slots: [] }).releaseCandidate, false);
  assert.equal(__test.stagedSlotStageBlock(context, { stale: [], slots: [] }).releaseCandidate, false);
  assert.equal(__test.stagedSlotStageBlock({}, { slots: [] }).lane, 0);
});

test("leaving candidates carry the structured expiry facts and keep every legacy field", () => {
  const rows = __test.stagedSlotCleanupCandidates({ stale: [{ path: "p/0", status: "committed", identity, generation,
    updatedAt: 5, createdAt: 9, terminalAt: 7, timeSource: "terminalAt", ageMs: 123, expiredCommitted: true,
    expiryReason: "expired", locked: false }] });
  assert.deepEqual(Object.keys(rows[0]), ["relativePath", "type", "status", "logicalKey", "generation", "updatedAt",
    "createdAt", "terminalAt", "timeSource", "ageMs", "expiredCommitted", "expiryReason", "locked", "releaseCandidate", "protectedReason"]);
  assert.equal(rows[0].relativePath, "p/0");
  assert.equal(rows[0].updatedAt, 5);
  assert.equal(rows[0].terminalAt, 7);
  assert.equal(rows[0].expiredCommitted, true);
  assert.equal(rows[0].releaseCandidate, true);
  assert.equal(__test.stagedSlotCleanupCandidates({ stale: [{ path: "p/1", status: "committed", locked: true }] })[0].releaseCandidate, false);
  assert.equal(__test.stagedSlotCleanupCandidates({ stale: [{ path: "p/2", status: "failed", locked: false }] })[0].releaseCandidate, false);
});

function fakeCleanupApi(calls, options = {}) {
  return {
    preview: async params => {
      calls.push("preview:" + String(params.authorizationSource));
      calls.push("preview-consumer:" + String(params.consumerRoot));
      (options.bindings || []).push(params.stagedJournal);
      return { token: "t".repeat(48), digest: "d".repeat(64),
        targets: [{ missing: false, absolutePath: "/srv/project/" + params.targets[0].relativePath,
          relativePath: params.targets[0].relativePath, destination: params.targets[0].destination }] };
    },
    confirm: async params => { calls.push("confirm:" + params.phase); return { ok: true }; },
    execute: async () => { calls.push("execute"); return { ok: true }; },
    status: async () => { calls.push("status"); return { states: [options.isolationState || "completed"] }; },
    isolatedMaintenanceDelete: async () => { calls.push("delete"); return { ok: true, state: options.deleteState || "accepted" }; },
  };
}

function expiredLeavingReport() {
  return { stale: [{ path: "simple_cluster/.simple-sftp-staging/d-" + identity.slice(0, 24) + "/0", status: "committed",
    identity, generation, locked: false, expiredCommitted: true, expiryReason: "expired", ageMs: 90000000,
    terminalAt: 172800 }], held: [], slots: [] };
}

test("claim-scoped reclaim drives preview→confirm→isolate→registered-delete exactly once for an expired committed slot", async () => {
  const calls = [], bindings = [];
  let transmitted = null;
  __test.setRemoteBatchTransport(async (source, command) => { transmitted = requestPayload(command); return JSON.stringify(expiredLeavingReport()); });
  try {
    const result = await __test.reclaimExpiredStagedSlots({ destination: { host: "127.0.0.1", username: "u", port: 22, remotePath: "/srv/project" },
      identity, generation, scope: "project-files", lane: 0, consumerRoot: "/fixture/project", api: fakeCleanupApi(calls, { bindings }), expiryMs: 86400000 });
    assert.equal(result.outcome, "accepted");
    assert.equal(result.isolationProven, true);
    assert.equal(transmitted.mode, "staleReport");
    assert.deepEqual(transmitted.expiry, { ms: 86400000 });
    assert.deepEqual(calls, ["preview:auto_expiry_reclaim", "preview-consumer:/fixture/project", "confirm:1", "execute", "status", "delete"]);
    // P1-3 ruling: the authorization rides the preview as an EXPLICIT journal binding — the
    // engine re-proves these exact facts under the slot lock before any rename.
    assert.deepEqual(bindings, [{ identity, generation, status: "committed", terminalAt: 172800, expiryMs: 86400000 }]);
  } finally { __test.setRemoteBatchTransport(null); }
});

test("a plain (non-hex) run id normalizes to the receiver generation everywhere — real helpers, no stubs", async () => {
  // The receiver always sends transferScope64(options.generation); check, reclaim and stage block
  // must carry the IDENTICAL string or a supported run id like "run-1" silently disables both
  // features (invalid-scope / generation mismatch / swallowed probe errors).
  const archive = requestPayload(__test.stagedTarUnpackingCommand({ remotePath: "/srv/project" }, "none",
    { retentionKey: "plans/a.yaml|task-0", generation: "run-1" }, { "out/a": { sha256: "a".repeat(64), size: 1 } }, ["out/a"]));
  const receiverGeneration = archive.generation;
  assert.match(receiverGeneration, /^[0-9a-f]{64}$/);
  assert.notEqual(receiverGeneration, "run-1");
  const destination = { host: "127.0.0.1", username: "u", port: 22, remotePath: "/srv/project" };
  let transmitted = null;
  const calls = [], bindings = [];
  __test.setRemoteBatchTransport(async (source, command) => { transmitted = requestPayload(command); return JSON.stringify(expiredLeavingReport()); });
  try {
    const result = await __test.reclaimExpiredStagedSlots({ destination, identity, generation: receiverGeneration,
      scope: "plans/a.yaml|task-0", lane: 0, consumerRoot: "/fixture/project", api: fakeCleanupApi(calls, { bindings }), expiryMs: 86400000 });
    assert.equal(result.outcome, "accepted");
    assert.equal(transmitted.generation, receiverGeneration); // byte-for-byte the receiver request value
    assert.equal(transmitted.identity, identity);
    assert.deepEqual(bindings, [{ identity, generation, status: "committed", terminalAt: 172800, expiryMs: 86400000 }]);
  } finally { __test.setRemoteBatchTransport(null); }
  // The stage-block attach asks for THIS run's generation too, never a raw id.
  let attached = null;
  __test.setRemoteBatchTransport(async (source, command) => { attached = requestPayload(command); return JSON.stringify({ stale: [], held: [], slots: [] }); });
  try {
    const error = new Error("TRANSFER_STAGE_PENDING: 暂存槽仍被上一代占用");
    await __test.attachStagedStageBlock(error, { destination, profile: "zlk-prod", scope: "plans/a.yaml|task-0",
      lane: 0, identity, incomingGeneration: receiverGeneration, expiryMs: 86400000 });
    assert.equal(attached.generation, receiverGeneration);
    assert.equal(error.stageBlock.incomingGeneration, receiverGeneration);
    assert.ok(error.message.startsWith("TRANSFER_STAGE_PENDING: 暂存槽仍被上一代占用"));
  } finally { __test.setRemoteBatchTransport(null); }
});

test("reclaim does not touch anything for protected candidates and never replays after an unknown isolation", async () => {
  const base = { destination: { host: "127.0.0.1", username: "u", port: 22, remotePath: "/srv/project" },
    identity, generation, scope: "project-files", lane: 0, consumerRoot: "/fixture/project", expiryMs: 86400000 };
  const noCalls = [];
  __test.setRemoteBatchTransport(async () => JSON.stringify({ stale: [], held: [], slots: [] }));
  try {
    assert.equal((await __test.reclaimExpiredStagedSlots({ ...base, api: fakeCleanupApi(noCalls) })).reason, "no-leaving-candidate");
    assert.deepEqual(noCalls, []);
    __test.setRemoteBatchTransport(async () => JSON.stringify({ stale: [{ path: "s/0", status: "committed", locked: false,
      expiredCommitted: false, expiryReason: "time-future" }], held: [], slots: [] }));
    assert.equal((await __test.reclaimExpiredStagedSlots({ ...base, api: fakeCleanupApi(noCalls) })).reason, "time-future");
    assert.deepEqual(noCalls, []);
    assert.equal((await __test.reclaimExpiredStagedSlots({ ...base, api: fakeCleanupApi(noCalls), consumerRoot: "" })).reason, "no-consumer-root");
    assert.deepEqual(noCalls, []);
    // Isolation outcome unknown: the delete entry is never attempted and nothing is re-sent.
    __test.setRemoteBatchTransport(async () => JSON.stringify(expiredLeavingReport()));
    const unknownCalls = [];
    const unknown = await __test.reclaimExpiredStagedSlots({ ...base, api: fakeCleanupApi(unknownCalls, { isolationState: "unknown" }) });
    assert.equal(unknown.outcome, "unknown");
    assert.equal(unknown.reason, "isolation-completion-not-proven");
    assert.ok(!unknownCalls.includes("delete"));
  } finally { __test.setRemoteBatchTransport(null); }
});
