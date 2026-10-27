"use strict";
// r17-D consumerRoot contract (consuming-project ownership of cleanup ledgers):
//  - a token's ledger lives ONLY inside the local consuming project's managed tree;
//  - memory, project file, observeBatch and cold reload all bind to that owner;
//  - the mixed legacy global folder is a read-only source reachable ONLY through this
//    caller's exact frozen digest reference; unknown ownership never migrates;
//  - a newer project record always wins; a corrupt project record never falls back;
//  - one instance keeps the global busy/observe budget — never per-project instances;
//  - the token ledger is retained while confirmations/settlement/DELETE_RECEIPT_UNCERTAIN
//    facts still need it (expiresAt is a preview freshness clock, NOT a completion clock);
//    only owner-verified writes ever create files under the project tree.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { CleanupFileApi, hash } = require("../cleanup-file-api.js");

const ROOT_A = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-A-"));
const ROOT_B = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-B-"));
const projectFile = (root, token) => path.join(root, "simple_cluster", "state", "simple-sftp", "cleanup-operations", token + ".json");
const identityOf = root => ({ path: root, device: "7", inode: "2" + root.length, machine: "m", user: "u" });
const nodeOf = root => ({ kind: "local", root });
const sentRequests = [];
const transport = async request => { sentRequests.push(request); return ({ ok: true, observationId: request.observationId, rootIdentity: identityOf(request.root),
  target: { absolutePath: request.root + "/" + (request.target?.relativePath || request.entries?.[0]?.relativePath || ""),
    fingerprint: "fp", device: "7", inode: "2out/d0" },
  ...(request.action === "batch-observe" ? { observations: (request.entries || []).map(e =>
    ({ key: e.key, status: "gone", target: { missing: true, type: e.type, absolutePath: request.root + "/" + e.relativePath }, executors: [], executorsChecked: true })) } : {}) }); };
const mkApi = storageRoot => new CleanupFileApi({ storageRoot, transport, activity: async () => {}, lease: async (n, t, work) => work() });

async function confirmedMove(api, consumerRoot, relative) {
  const p = await api.preview({ consumerRoot, node: nodeOf("/srv/target"), targets: [{ relativePath: relative, type: "file", destination: "clean_dir/" + relative }] });
  await api.confirm({ token: p.token, digest: p.digest, confirm: true, phase: 1, consumerRoot, exactTargets: p.targets.map(row => row.absolutePath) });
  return p;
}

test("two project consumer roots interleave without cross-read, cross-write or extra instances", async () => {
  const api = mkApi(path.join(os.tmpdir(), "legacy-mixed-" + Date.now()));
  const a = await confirmedMove(api, ROOT_A, "out/a.csv");
  const b = await confirmedMove(api, ROOT_B, "out/b.csv");
  assert.ok(fs.existsSync(projectFile(ROOT_A, a.token)) && fs.existsSync(projectFile(ROOT_B, b.token)));
  // cross-file absence: each record exists only under its own consumer tree
  assert.equal(fs.existsSync(projectFile(ROOT_A, b.token)), false);
  assert.equal(fs.existsSync(projectFile(ROOT_B, a.token)), false);
  // memory hits still verify ownership: B reading A's token fails closed
  await assert.rejects(api.read(a.token, ROOT_B), error => error.code === "CONSUMER_ROOT_MISMATCH");
  // an independent instance recovers each project only through its own root
  const cold = mkApi(api.storageRoot);
  assert.equal((await cold.read(a.token, ROOT_A)).token, a.token);
  assert.equal((await cold.read(b.token, ROOT_B)).token, b.token);
  await assert.rejects(cold.read(a.token, ROOT_B), error => error.code === "LEGACY_IMPORT_UNBOUND");
  await assert.rejects(cold.read(b.token, ROOT_A), error => error.code === "LEGACY_IMPORT_UNBOUND");
  // a disk row carrying a foreign owner field is refused even inside the "right" folder shape
  fs.mkdirSync(path.dirname(projectFile(ROOT_A, "f".repeat(48))), { recursive: true });
  fs.writeFileSync(projectFile(ROOT_A, "f".repeat(48)), JSON.stringify({ token: "f".repeat(48), consumerRoot: ROOT_B }));
  await assert.rejects(api.read("f".repeat(48), ROOT_A), error => error.code === "CONSUMER_ROOT_MISMATCH");
  // ONE instance serves both projects: the global busy/preview structures were never split
  assert.equal(api.previews.get(a.token).consumerRoot, ROOT_A);
  assert.equal(api.previews.get(b.token).consumerRoot, ROOT_B);
});

test("wrong consumer root against a valid token fails; a foreign legacy copy cannot smuggle it", async () => {
  const api = mkApi(fs.mkdtempSync(path.join(os.tmpdir(), "legacy-wrong-")));
  const a = await confirmedMove(api, ROOT_A, "out/keep.csv");
  // even WITH a digest reference, B cannot fetch A's token: no legacy bytes exist for it
  // (memory answers MISMATCH first; after a cold instance the fs branch answers EXPIRED)
  await assert.rejects(api.read(a.token, ROOT_B, a.digest), error => error.code === "CONSUMER_ROOT_MISMATCH");
  api.previews.delete(a.token);
  await assert.rejects(api.read(a.token, ROOT_B, a.digest), error => error.code === "PREVIEW_EXPIRED");
  // and A's project record stays byte-stable across B's failed attempts
  const bytes = fs.readFileSync(projectFile(ROOT_A, a.token));
  await assert.rejects(api.read(a.token, ROOT_B), () => true);
  assert.deepEqual(fs.readFileSync(projectFile(ROOT_A, a.token)), bytes);
  // a legacy copy of a token already owned elsewhere is refused by the on-disk owner field
  fs.writeFileSync(path.join(api.storageRoot, a.token + ".json"), JSON.stringify({ ...JSON.parse(bytes.toString()), consumerRoot: undefined }));
  const other = mkApi(api.storageRoot);
  other.previews.delete(a.token);
  const back = await other.read(a.token, ROOT_A); // project record wins over the legacy copy
  assert.equal(back.consumerRoot, ROOT_A);
});

test("legacy import needs the exact frozen digest; unknown ownership never migrates; new values win; corrupt never falls back", async () => {
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-exact-"));
  const api = mkApi(legacy);
  const token = "ab".repeat(24);
  const node = nodeOf("/srv/old"), identity = identityOf("/srv/old");
  const targets = [{ relativePath: "old/f.csv", type: "file", absolutePath: "/srv/old/old/f.csv" }];
  const safety = { legacy: 1 };
  const row = { token, operationId: "cleanup-old", node, rootIdentity: identity, action: "delete", targets, safety,
    tmuxSessionPrefix: "simple", expiresAt: Date.now() + 600000, confirmations: 0, states: ["pending"] };
  row.digest = hash({ node, rootIdentity: identity, action: "delete", targets, safety, tmuxSessionPrefix: "simple" });
  const legacyBytes = JSON.stringify(row);
  fs.writeFileSync(path.join(legacy, token + ".json"), legacyBytes);
  // unknown ownership: no reference -> the compatibility entry stops, legacy bytes untouched, no project file
  await assert.rejects(api.read(token, ROOT_A), error => error.code === "LEGACY_IMPORT_UNBOUND");
  assert.equal(fs.existsSync(projectFile(ROOT_A, token)), false);
  assert.equal(fs.readFileSync(path.join(legacy, token + ".json"), "utf8"), legacyBytes);
  // a wrong reference is refused byte-for-byte too (no partial import, no overwrite)
  await assert.rejects(api.read(token, ROOT_A, "0".repeat(64)), error => error.code === "TOKEN_DIGEST_MISMATCH");
  assert.equal(fs.existsSync(projectFile(ROOT_A, token)), false);
  // the exact reference imports the legacy BYTES and leaves the legacy file untouched
  const imported = await api.read(token, ROOT_A, row.digest);
  assert.equal(imported.digest, row.digest);
  assert.equal(fs.readFileSync(projectFile(ROOT_A, token), "utf8"), legacyBytes);
  assert.equal(fs.readFileSync(path.join(legacy, token + ".json"), "utf8"), legacyBytes);
  // no migration temp survives the import
  assert.deepEqual(fs.readdirSync(path.dirname(projectFile(ROOT_A, token))).filter(name => name.includes("migrating")), []);
  // a newer project record wins even when the caller still carries the OLD frozen digest
  const newer = { ...JSON.parse(legacyBytes), digest: "cd".repeat(32) };
  const token2 = "cd".repeat(24);
  newer.token = token2;
  fs.writeFileSync(projectFile(ROOT_B, token2), JSON.stringify(newer)); // pre-existing new value
  const won = await api.read(token2, ROOT_B, row.digest);
  assert.equal(won.digest, newer.digest);
  assert.equal(fs.readFileSync(projectFile(ROOT_B, token2), "utf8"), JSON.stringify(newer));
  // corrupt project record: never falls back to the (valid) legacy folder
  const token3 = "ef".repeat(24);
  const row3 = { ...row, token: token3 };
  fs.writeFileSync(path.join(legacy, token3 + ".json"), JSON.stringify(row3));
  fs.mkdirSync(path.dirname(projectFile(ROOT_A, token3)), { recursive: true });
  fs.writeFileSync(projectFile(ROOT_A, token3), "{corrupt");
  await assert.rejects(api.read(token3, ROOT_A, row3.digest), error => error.code === "PREVIEW_CORRUPT");
});

test("one observeBatch round mixes project tokens honestly: own rows answer, foreign rows stop at the owner contract", async () => {
  const api = mkApi(path.join(os.tmpdir(), "legacy-observe-" + Date.now()));
  const a = await confirmedMove(api, ROOT_A, "out/a0");
  const b = await confirmedMove(api, ROOT_B, "out/b0");
  const res = await api.observeBatch({ consumerRoot: ROOT_A, node: nodeOf("/srv/target"), observationId: "round-1", readConcurrency: 1,
    targets: [{ key: "own", relativePath: "out/a0", type: "file", backendToken: a.token, backendIndex: 0, backendDigest: a.digest },
      { key: "foreign", relativePath: "out/b0", type: "file", backendToken: b.token, backendIndex: 0 }] });
  const byKey = Object.fromEntries(res.observations.map(row => [row.key, row]));
  assert.equal(byKey.own.state, "completed", JSON.stringify(byKey.own));
  assert.equal(byKey.foreign.error.code, "CONSUMER_ROOT_MISMATCH", "B's memory-owned record never answers to A's round");
  assert.ok(!fs.existsSync(path.join(ROOT_A, "simple_cluster", "state", "simple-sftp", "cleanup-operations", b.token + ".json")));
  // a stale frozen digest reference is refused even for the owner
  const stale = await api.observeBatch({ consumerRoot: ROOT_A, node: nodeOf("/srv/target"), observationId: "round-2", readConcurrency: 1,
    targets: [{ key: "own", relativePath: "out/a0", type: "file", backendToken: a.token, backendIndex: 0, backendDigest: "0".repeat(64) }] });
  assert.equal(stale.observations[0].error.code, "TOKEN_DIGEST_MISMATCH");
});

test("preview refuses a missing or relative consumer root; execute/settle/verify carry ownership through", async () => {
  const api = mkApi(path.join(os.tmpdir(), "legacy-chain-" + Date.now()));
  await assert.rejects(api.preview({ node: nodeOf("/srv/target"), targets: [{ relativePath: "x", type: "file", destination: "clean_dir/x" }] }),
    error => error.code === "CONSUMER_ROOT_INVALID");
  await assert.rejects(api.preview({ consumerRoot: "relative/project", node: nodeOf("/srv/target"),
    targets: [{ relativePath: "x", type: "file", destination: "clean_dir/x" }] }), error => error.code === "CONSUMER_ROOT_INVALID");
  const a = await confirmedMove(api, ROOT_A, "out/settle.csv");
  api.previews.delete(a.token); // force every step through the project file
  assert.equal((await api.status({ token: a.token, consumerRoot: ROOT_A })).token, a.token);
  await assert.rejects(api.execute({ token: a.token, digest: a.digest, index: 0 }), error => error.code === "CONSUMER_ROOT_INVALID");
  await assert.rejects(api.execute({ token: a.token, digest: a.digest, index: 0, consumerRoot: ROOT_B }), error => error.code === "PREVIEW_EXPIRED");
  assert.equal((await api.settle({ token: a.token, digest: a.digest, index: 0, consumerRoot: ROOT_A })).state, "pending");
});

test("r118 reclaim authorizations are recorded explicitly, isolate-only, and ride the frozen row", async () => {
  const api = mkApi(path.join(os.tmpdir(), "legacy-reclaim-" + Date.now()));
  const rel = "simple_cluster/.simple-sftp-staging/d-" + "1".repeat(24) + "/0";
  const batch = "job-" + "ab".repeat(24);
  const base = { consumerRoot: ROOT_A, node: nodeOf("/srv/target"), action: "isolate",
    targets: [{ relativePath: rel, type: "directory", archiveBatch: batch, destination: "clean_dir/" + batch + "/" + rel }] };
  const auto = await api.preview({ ...base, authorizationSource: "auto_expiry_reclaim" });
  assert.equal(auto.reclaimAuthorizationSource, "auto_expiry_reclaim");
  const single = await api.preview({ ...base, authorizationSource: "single_confirmation_release" });
  assert.equal(single.reclaimAuthorizationSource, "single_confirmation_release");
  // Reclaim authorizations never ride another action, and unknown sources are refused outright.
  await assert.rejects(api.preview({ ...base, action: "move", authorizationSource: "auto_expiry_reclaim" }),
    error => error.code === "INVALID_AUTHORIZATION_SOURCE");
  await assert.rejects(api.preview({ ...base, authorizationSource: "auto_delete_please" }),
    error => error.code === "INVALID_AUTHORIZATION_SOURCE");
  // files.cleanup.preview keeps its promised {readOnly:true, zeroWrites:true}: an authorization
  // never persists on its own — only the confirmation writes the owning project's ledger.
  assert.equal(fs.existsSync(projectFile(ROOT_A, auto.token)), false);
  assert.equal(fs.existsSync(projectFile(ROOT_A, single.token)), false);
  await api.confirm({ token: auto.token, digest: auto.digest, confirm: true, phase: 1, consumerRoot: ROOT_A,
    exactTargets: auto.targets.map(row => row.absolutePath) });
  // Ownership rules are unchanged: once confirmed, the recorded row lives only under the consuming project…
  assert.ok(fs.existsSync(projectFile(ROOT_A, auto.token)));
  assert.equal(fs.existsSync(projectFile(ROOT_B, auto.token)), false);
  const cold = mkApi(api.storageRoot);
  assert.equal((await cold.read(auto.token, ROOT_A)).reclaimAuthorizationSource, "auto_expiry_reclaim");
  // …and the marker is ownership metadata: the frozen digest preimage (node/rootIdentity/action/
  // targets/safety/prefix) stays exactly as it was, so confirm/execute/maintenance bindings do
  // not change shape for any older caller.
  assert.equal(auto.digest, hash({ node: auto.node, rootIdentity: auto.rootIdentity, action: "isolate",
    targets: auto.targets, safety: auto.safety, tmuxSessionPrefix: auto.tmuxSessionPrefix }));
});

test("r118 journal binding: explicit facts ride the frozen row, malformed bindings fail closed, execute carries them to the engine", async () => {
  const api = mkApi(path.join(os.tmpdir(), "legacy-binding-" + Date.now()));
  const rel = "simple_cluster/.simple-sftp-staging/d-" + "1".repeat(24) + "/0";
  const batch = "job-" + "cd".repeat(24);
  const binding = { identity: "ab".repeat(32), generation: "cd".repeat(32), status: "committed", terminalAt: 172800, expiryMs: 86400000 };
  const base = { consumerRoot: ROOT_A, node: nodeOf("/srv/target"), action: "isolate",
    targets: [{ relativePath: rel, type: "directory", archiveBatch: batch, destination: "clean_dir/" + batch + "/" + rel }] };
  // A malformed or unrelated binding is refused before anything freezes — nothing implicit is inferred.
  await assert.rejects(api.preview({ ...base, authorizationSource: "auto_expiry_reclaim", stagedJournal: { ...binding, identity: "nope" } }),
    error => error.code === "INVALID_STAGED_JOURNAL_BINDING");
  await assert.rejects(api.preview({ ...base, authorizationSource: "auto_expiry_reclaim", stagedJournal: { ...binding, status: "preparing" } }),
    error => error.code === "INVALID_STAGED_JOURNAL_BINDING");
  await assert.rejects(api.preview({ ...base, authorizationSource: "auto_expiry_reclaim", stagedJournal: { ...binding, expiryMs: 0 } }),
    error => error.code === "INVALID_STAGED_JOURNAL_BINDING");
  await assert.rejects(api.preview({ ...base, authorizationSource: "auto_expiry_reclaim", stagedJournal: { ...binding, terminalAt: 0 } }),
    error => error.code === "INVALID_STAGED_JOURNAL_BINDING");
  await assert.rejects(api.preview({ ...base, stagedJournal: binding }),
    error => error.code === "INVALID_STAGED_JOURNAL_BINDING");
  // The valid binding rides the frozen row under the consuming project (ownership metadata, like
  // reclaimAuthorizationSource — the frozen digest preimage above is unchanged by it).
  const p = await api.preview({ ...base, authorizationSource: "auto_expiry_reclaim", stagedJournal: binding });
  await api.confirm({ token: p.token, digest: p.digest, confirm: true, phase: 1, consumerRoot: ROOT_A,
    exactTargets: p.targets.map(row => row.absolutePath) });
  const cold = mkApi(api.storageRoot);
  // 0.2.114: the frozen row stores the mode EXPLICITLY — absent input freezes to requireExpired:true,
  // so execute and any later reader always see the byte-identical 0.2.113 expiry behaviour.
  assert.deepEqual((await cold.read(p.token, ROOT_A)).stagedJournal, { ...binding, requireExpired: true });
  // Execute hands EXACTLY those expectations to the engine isolate request (the engine re-proves
  // them under the slot lock before the rename — see the fixture's binding race scenarios).
  const before = sentRequests.length;
  await api.execute({ token: p.token, digest: p.digest, index: 0, consumerRoot: ROOT_A });
  const isolateRequests = sentRequests.slice(before).filter(request => request.action === "isolate");
  assert.equal(isolateRequests.length, 1, JSON.stringify(isolateRequests.map(request => request.action)));
  assert.deepEqual(isolateRequests[0].stagedJournal, { ...binding, requireExpired: true });
  assert.equal(isolateRequests[0].target.relativePath, rel);
});

test("r119 user-confirmed early release: strict boolean mode, frozen into digest and row, engine proof gates advertising", async () => {
  const storageRoot = path.join(os.tmpdir(), "r119-release-" + Date.now());
  const api = mkApi(storageRoot);
  const rel = "simple_cluster/.simple-sftp-staging/d-" + "1".repeat(24) + "/0";
  const batch = "job-" + "ab".repeat(24);
  const binding = { identity: "ab".repeat(32), generation: "cd".repeat(32), status: "committed", terminalAt: 172800, expiryMs: 86400000 };
  const base = { consumerRoot: ROOT_A, node: nodeOf("/srv/target"), action: "isolate",
    targets: [{ relativePath: rel, type: "directory", archiveBatch: batch, destination: "clean_dir/" + batch + "/" + rel }] };
  // The mode is a real boolean or absent: truthy stand-ins are refused in BOTH chains.
  for (const bad of ["false", 1, 0, null]) {
    await assert.rejects(api.preview({ ...base, authorizationSource: "single_confirmation_release", stagedJournal: { ...binding, requireExpired: bad } }),
      error => error.code === "INVALID_STAGED_JOURNAL_BINDING");
  }
  // expiryMs stays required and > 0 whatever the mode: nobody smuggles 0 to switch the age rule off.
  await assert.rejects(api.preview({ ...base, authorizationSource: "single_confirmation_release",
    stagedJournal: { ...binding, expiryMs: 0, requireExpired: false } }), error => error.code === "INVALID_STAGED_JOURNAL_BINDING");
  // Preview keeps zero writes: the persisted ledger is a CONFIRM-time artifact, so a cold reader
  // can only resolve a token after confirm — before it, the frozen preview lives in memory only.
  const pFalse = await api.preview({ ...base, authorizationSource: "single_confirmation_release", stagedJournal: { ...binding, requireExpired: false } });
  const pTrue = await api.preview({ ...base, authorizationSource: "single_confirmation_release", stagedJournal: binding });
  // Zero writes, on the real filesystem: the persisted ledger is a CONFIRM-time artifact, so no
  // project record exists yet while the preview is memory-only.
  assert.equal(fs.existsSync(projectFile(ROOT_A, pFalse.token)), false);
  // A cold reader is refused with exactly LEGACY_IMPORT_UNBOUND — pinned deliberately, not
  // "any refusal passes": read() with no project record AND no frozen digest stops at the owner
  // contract instead of guessing an owner (cleanup-file-api.js:405-411), which is precisely what
  // "the ledger was never written" looks like to a cold reader. PREVIEW_EXPIRED would be the
  // mislabel here — it claims a record existed and aged out, which preview never did. The same
  // stop code is already pinned by this suite's cross-root cases and the observe-batch
  // owner-contract cases; changing it would break that established contract.
  await assert.rejects(mkApi(storageRoot).read(pFalse.token, ROOT_A), error => error.code === "LEGACY_IMPORT_UNBOUND");
  // The mode joins the digest preimage. Determinism control first: the same mode twice gives the
  // same digest (the stub answers are static, token/operationId/expiresAt are outside the
  // preimage), so the difference below is attributable to requireExpired alone.
  const pTrueAgain = await api.preview({ ...base, authorizationSource: "single_confirmation_release", stagedJournal: binding });
  assert.equal(pTrue.digest, pTrueAgain.digest);
  assert.notEqual(pFalse.digest, pTrue.digest);
  // The shared stub transport never answers the engine proof ⇒ the safety flag stays silent.
  assert.equal(pFalse.safety.userConfirmedSlotRelease, undefined);
  await api.confirm({ token: pFalse.token, digest: pFalse.digest, confirm: true, phase: 1, consumerRoot: ROOT_A,
    exactTargets: pFalse.targets.map(row => row.absolutePath) });
  // Positive control for the zero-write probe above: confirm (not preview) persists the ledger, so
  // the very same path check that was false before now sees the file — the probe can discriminate.
  assert.equal(fs.existsSync(projectFile(ROOT_A, pFalse.token)), true);
  // A mode flip cannot survive the exact-digest check: pTrue's digest on pFalse's token is refused.
  await assert.rejects(api.confirm({ token: pFalse.token, digest: pTrue.digest, confirm: true, phase: 1, consumerRoot: ROOT_A,
    exactTargets: pFalse.targets.map(row => row.absolutePath) }), error => error.code === "CONFIRM_REQUIRED");
  const cold = mkApi(storageRoot);
  assert.deepEqual((await cold.read(pFalse.token, ROOT_A)).stagedJournal, { ...binding, requireExpired: false });
  // Execute replays ONLY the frozen value; the engine consumes it under the slot lock.
  const before = sentRequests.length;
  await api.execute({ token: pFalse.token, digest: pFalse.digest, index: 0, consumerRoot: ROOT_A });
  const isolates = sentRequests.slice(before).filter(request => request.action === "isolate");
  assert.equal(isolates.length, 1);
  assert.equal(isolates[0].stagedJournal.requireExpired, false);
  // Capability truth: an engine that ANSWERS the flag on staged inspects advertises it; the
  // same-source discipline means one silent target is enough to keep the whole flag absent.
  const answeringTransport = async request => {
    const result = await transport(request);
    if (request.action === "inspect" && request.isolate === true) result.userConfirmedSlotRelease = 1;
    return result;
  };
  const answeringApi = new CleanupFileApi({ storageRoot: path.join(os.tmpdir(), "r119-answer-" + Date.now()),
    transport: answeringTransport, activity: async () => {}, lease: async (n, t, work) => work() });
  assert.equal((await answeringApi.preview(base)).safety.userConfirmedSlotRelease, 1);
  const halfSilent = async request => {
    const result = await transport(request);
    if (request.action === "inspect" && request.isolate === true && request.target.relativePath === rel) result.userConfirmedSlotRelease = 1;
    return result;
  };
  const mixedApi = new CleanupFileApi({ storageRoot: path.join(os.tmpdir(), "r119-mixed-" + Date.now()),
    transport: halfSilent, activity: async () => {}, lease: async (n, t, work) => work() });
  const mixed = await mixedApi.preview({ ...base, targets: [...base.targets,
    { relativePath: "docs", type: "directory", archiveBatch: "job-" + "ef".repeat(24), destination: "clean_dir/" + "job-" + "ef".repeat(24) + "/docs" }] });
  assert.equal(mixed.safety.userConfirmedSlotRelease, undefined);
});

test("upload-state writes into the project managed tree; the legacy .vscode file stays read-only", () => {
  const loadStub = () => { const original = Module._load; Module._load = function (name, ...rest) {
    if (name === "vscode") return { TreeItem: class {}, ProgressLocation: { Notification: 1 },
      workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_k, d) => d }), onDidChangeWorkspaceFolders: () => ({ dispose() {} }) },
      window: { showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, showErrorMessage: async () => undefined,
        createStatusBarItem: () => ({ command: "", tooltip: "", text: "", show() {}, hide() {}, dispose() {}, setDecoration() {} }),
        withProgress: async (_o, work) => work({ report() {} }, { onDidRequestCancel: () => ({ dispose() {} }) }),
        activeTextEditor: undefined, onDidChangeActiveTextEditor: () => ({ dispose() {} }) },
      commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined }, env: { openExternal: async () => true },
      Uri: { file: p => ({ fsPath: p }), parse: s => ({ toString: () => s }) },
      EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
      Disposable: class { static from() { return { dispose() {} } } dispose() {} },
      languages: { createDiagnosticCollection: () => ({ set() {}, clear() {}, dispose() {} }) },
      Range: class {}, Position: class {}, ThemeIcon: class {}, StatusBarAlignment: { Left: 1, Right: 2 }, ViewColumn: { One: 1 }, ExtensionMode: { Development: 2, Production: 1 } };
    return original.call(this, name, ...rest); }; return () => { Module._load = original; }; };
  const restore = loadStub();
  let extension;
  try { extension = require("../extension.js"); } finally { restore(); }
  const { readUploadState, writeUploadState, projectUploadStatePath } = extension.__test;
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "upload-state-"));
  // legacy source answers while no new file exists; the old file itself is never created by us
  const legacyDir = path.join(project, ".vscode");
  fs.mkdirSync(legacyDir);
  fs.writeFileSync(path.join(legacyDir, "simple-sftp-upload-state.json"), JSON.stringify({ lastUploadedAt: "2020-01-01T00:00:00.000Z", mode: "legacy" }));
  assert.equal(readUploadState(project).mode, "legacy");
  writeUploadState(project, { lastUploadedAt: "2026-01-01T00:00:00.000Z", mode: "managed" });
  assert.equal(readUploadState(project).mode, "managed");
  assert.ok(fs.existsSync(projectUploadStatePath(project)));
  // the old file keeps its exact bytes and the new value wins
  assert.equal(JSON.parse(fs.readFileSync(path.join(legacyDir, "simple-sftp-upload-state.json"), "utf8")).mode, "legacy");
  // a corrupt NEW record never falls back to the old timestamp
  fs.writeFileSync(projectUploadStatePath(project), "{corrupt");
  assert.equal(readUploadState(project), null);
});

// r26: local session records (plugin action/time/device/remote-path facts) share the managed-tree
// pattern with upload-state. The parent r26 contract pinned here: two roots interleave without
// cross-read/write; within one project a new record wins; a corrupt new record never resurrects the
// old .vscode value; a MISSING new record consults only the exact legacy path read-only; the old file
// keeps its bytes; a linked managed tree is refused outright. getUploadBaselineMs priority
// (upload-state → session → initial) is unchanged and pinned on top of the relocated session source.
function loadExtension() {
  const original = Module._load;
  Module._load = function (name, ...rest) {
    if (name === "vscode") return { TreeItem: class {}, ProgressLocation: { Notification: 1 },
      workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_k, d) => d }), onDidChangeWorkspaceFolders: () => ({ dispose() {} }) },
      window: { showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, showErrorMessage: async () => undefined,
        createStatusBarItem: () => ({ command: "", tooltip: "", text: "", show() {}, hide() {}, dispose() {}, setDecoration() {} }),
        withProgress: async (_o, work) => work({ report() {} }, { onDidRequestCancel: () => ({ dispose() {} }) }),
        activeTextEditor: undefined, onDidChangeActiveTextEditor: () => ({ dispose() {} }) },
      commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined }, env: { openExternal: async () => true },
      Uri: { file: p => ({ fsPath: p }), parse: s => ({ toString: () => s }) },
      EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
      Disposable: class { static from() { return { dispose() {} } } dispose() {} },
      languages: { createDiagnosticCollection: () => ({ set() {}, clear() {}, dispose() {} }) },
      Range: class {}, Position: class {}, ThemeIcon: class {}, StatusBarAlignment: { Left: 1, Right: 2 }, ViewColumn: { One: 1 }, ExtensionMode: { Development: 2, Production: 1 } };
    return original.call(this, name, ...rest);
  };
  try { return require("../extension.js"); } finally { Module._load = original; }
}

test("session records land in the consuming project's managed tree; two roots never cross", () => {
  const { readLocalSessionRecord, writeLocalSessionRecord, projectSessionPath } = loadExtension().__test;
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "session-A-"));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "session-B-"));
  writeLocalSessionRecord(rootA, { device: "dev-A", at: "2026-01-01T00:00:00.000Z", remotePath: "/srv/a" });
  writeLocalSessionRecord(rootB, { device: "dev-B", at: "2026-02-02T00:00:00.000Z", remotePath: "/srv/b" });
  assert.ok(fs.existsSync(projectSessionPath(rootA)) && projectSessionPath(rootA).startsWith(path.join(rootA, "simple_cluster")));
  assert.equal(readLocalSessionRecord(rootA).device, "dev-A");
  assert.equal(readLocalSessionRecord(rootB).device, "dev-B");
  // interleaved overwrite of A never leaks into B and vice versa
  writeLocalSessionRecord(rootA, { device: "dev-A2", at: "2026-03-03T00:00:00.000Z", remotePath: "/srv/a2" });
  assert.equal(readLocalSessionRecord(rootA).device, "dev-A2");
  assert.equal(readLocalSessionRecord(rootB).device, "dev-B");
  // no .vscode session file is ever created by a managed write
  assert.equal(fs.existsSync(path.join(rootA, ".vscode", "simple-sftp-session.json")), false);
});

test("session read: new value wins, corrupt new never resurrects old, missing new reads legacy read-only, old bytes intact", () => {
  const { readLocalSessionRecord, writeLocalSessionRecord, projectSessionPath } = loadExtension().__test;
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "session-legacy-"));
  const legacyDir = path.join(project, ".vscode");
  fs.mkdirSync(legacyDir);
  const legacyFile = path.join(legacyDir, "simple-sftp-session.json");
  const legacyBytes = JSON.stringify({ device: "old", at: "2020-01-01T00:00:00.000Z" });
  fs.writeFileSync(legacyFile, legacyBytes);
  // (a) missing new record → the exact legacy path answers, read-only
  assert.equal(readLocalSessionRecord(project).device, "old");
  // (b) a new record wins over the legacy value; the legacy bytes are never rewritten
  writeLocalSessionRecord(project, { device: "new", at: "2026-05-05T00:00:00.000Z" });
  assert.equal(readLocalSessionRecord(project).device, "new");
  assert.equal(fs.readFileSync(legacyFile, "utf8"), legacyBytes);
  // (c) a corrupt NEW record returns null — it must NOT fall back to the old device
  fs.writeFileSync(projectSessionPath(project), "{corrupt");
  assert.equal(readLocalSessionRecord(project), null);
});

test("session write refuses a linked managed tree (simple_cluster symlink/junction)", () => {
  const { writeLocalSessionRecord } = loadExtension().__test;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "session-outside-"));
  fs.symlinkSync(outside, path.join(root, "simple_cluster"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => writeLocalSessionRecord(root, { device: "x", at: "2026-01-01T00:00:00.000Z" }), /链接或非目录/);
});

test("getUploadBaselineMs priority is unchanged: upload-state → session → initial", () => {
  const { readUploadState, writeUploadState, writeLocalSessionRecord, getUploadBaselineMs, projectUploadStatePath } = loadExtension().__test;
  // (1) upload-state present and parseable wins over a session record
  const p1 = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-state-"));
  writeUploadState(p1, { lastUploadedAt: "2026-01-01T00:00:00.000Z", mode: "synced" });
  writeLocalSessionRecord(p1, { at: "2020-01-01T00:00:00.000Z" });
  assert.equal(getUploadBaselineMs(p1), new Date("2026-01-01T00:00:00.000Z").getTime());
  // (2) no usable upload-state → the session record is the baseline
  const p2 = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-session-"));
  writeLocalSessionRecord(p2, { at: "2025-06-06T00:00:00.000Z" });
  assert.equal(getUploadBaselineMs(p2), new Date("2025-06-06T00:00:00.000Z").getTime());
  // (3) neither → initial writes an upload-state record and returns "now"
  const p3 = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-initial-"));
  const before = Date.now();
  const baseline = getUploadBaselineMs(p3);
  assert.ok(baseline >= before && baseline <= Date.now() + 1);
  assert.equal(readUploadState(p3).mode, "initial");
  assert.ok(fs.existsSync(projectUploadStatePath(p3)));
  // (2b) a corrupt upload-state falls through to the session source (fail-closed own record, not a stale init)
  const p4 = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-corrupt-"));
  writeLocalSessionRecord(p4, { at: "2025-07-07T00:00:00.000Z" });
  fs.writeFileSync(projectUploadStatePath(p4), "{corrupt");
  assert.equal(getUploadBaselineMs(p4), new Date("2025-07-07T00:00:00.000Z").getTime());
});
