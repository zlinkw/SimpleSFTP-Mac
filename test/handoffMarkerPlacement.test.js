const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

// r28: the remote handoff marker moved from the remote project root into the remote managed
// state tree <remoteRoot>/simple_cluster/state/simple-sftp/handoff/<safe basename>. The legacy
// root-level file stays a read-only source and is consulted only when the new file is truly
// absent. These tests drive the real extracted sources with a scripted runSsh transport —
// no real ssh, sftp, or network access happens anywhere in this file.

const source = fs.readFileSync(path.join(__dirname, "../extension.js"), "utf8");
const defaultMarkerName = /const DEFAULT_HANDOFF_MARKER = "([^"]+)";/.exec(source)[1];
const managedSegmentsDeclaration = /const REMOTE_HANDOFF_MANAGED_SEGMENTS = [^\n]+;/.exec(source)[0];

function extract(name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const headerEnd = source.indexOf(") {", start);
  assert.ok(headerEnd >= 0, `missing function body ${name}`);
  const body = headerEnd + 2;
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function remoteMarkerSandbox() {
  const sandbox = {
    path,
    DEFAULT_HANDOFF_MARKER: defaultMarkerName,
    sshCalls: [],
    sshScript: [],
    leaseCalls: [],
  };
  sandbox.runSsh = async (sftp, command, timeout) => {
    sandbox.sshCalls.push({ sftp, command, timeout });
    if (!sandbox.sshScript.length) throw new Error(`unexpected ssh command: ${command}`);
    const next = sandbox.sshScript.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  sandbox.withFileResourceLease = async (operation, project, paths, server, work) => {
    sandbox.leaseCalls.push({ operation, project, paths, server });
    return work();
  };
  vm.createContext(sandbox);
  vm.runInContext([
    managedSegmentsDeclaration,
    extract("shellQuote"),
    extract("normalizeSshPort"),
    extract("remoteResourceServer"),
    extract("requireRemoteRoot"),
    extract("safeHandoffMarkerName"),
    extract("getRemoteMarkerPath"),
    extract("legacyRemoteMarkerPath"),
    extract("createRemoteHandoffReadCommand"),
    extract("readRemoteHandoffMarker"),
    extract("writeRemoteHandoffMarker"),
    "this.api = { shellQuote, getRemoteMarkerPath, legacyRemoteMarkerPath, readRemoteHandoffMarker, writeRemoteHandoffMarker };",
  ].join("\n"), sandbox);
  return sandbox;
}

const MARKER = {
  schemaVersion: 1,
  action: "handoffReady",
  timestamp: "2026-10-25T08:00:00.000Z",
  relativePaths: ["work_dirs/a b/它's.txt"],
};

test("remote marker path derives the managed tree from one source with the exact legacy fallback", () => {
  const sandbox = remoteMarkerSandbox();
  const managed = "/srv/proj/simple_cluster/state/simple-sftp/handoff";
  assert.equal(sandbox.api.getRemoteMarkerPath("/srv/proj", undefined), `${managed}/${defaultMarkerName}`);
  assert.equal(sandbox.api.getRemoteMarkerPath("/srv/proj///", ""), `${managed}/${defaultMarkerName}`);
  assert.equal(sandbox.api.getRemoteMarkerPath("/srv/proj", "交接 标记.json"), `${managed}/交接 标记.json`);
  assert.equal(sandbox.api.getRemoteMarkerPath("/srv/proj", "/abs/deep/../../evil.json"), `${managed}/evil.json`);
  assert.equal(sandbox.api.legacyRemoteMarkerPath("/srv/proj", undefined), `/srv/proj/${defaultMarkerName}`);
  assert.equal(sandbox.api.legacyRemoteMarkerPath("/srv/proj", "交接 标记.json"), "/srv/proj/交接 标记.json");
  assert.notEqual(sandbox.api.getRemoteMarkerPath("/srv/proj", undefined), sandbox.api.legacyRemoteMarkerPath("/srv/proj", undefined));
  // Two remote roots never share a marker location, and the same root is stable across calls.
  assert.notEqual(sandbox.api.getRemoteMarkerPath("/srv/projA", undefined), sandbox.api.getRemoteMarkerPath("/srv/projB", undefined));
  assert.equal(sandbox.api.getRemoteMarkerPath("/srv/proj", undefined), sandbox.api.getRemoteMarkerPath("/srv/proj", undefined));
  // A missing, relative or root-only remote root fails closed instead of resolving elsewhere (r29).
  for (const bad of ["", "/", "///", undefined, null, "srv/proj", "./rel", "../up", "C:\\x"]) {
    assert.throws(() => sandbox.api.getRemoteMarkerPath(bad, undefined), /远端项目根|POSIX/);
    assert.throws(() => sandbox.api.legacyRemoteMarkerPath(bad, undefined), /远端项目根|POSIX/);
  }
  // Spaces, Chinese and single quotes remain valid absolute roots.
  assert.ok(sandbox.api.getRemoteMarkerPath("/srv/项 目/it's", undefined).startsWith("/srv/项 目/it's/"));
  for (const bad of [".", ".."]) assert.throws(() => sandbox.api.getRemoteMarkerPath("/srv/proj", bad), /名称无效/);
});

test("the reader prefers the new marker and only reads the exact legacy path when it is truly missing", async () => {
  const sandbox = remoteMarkerSandbox();
  const sftp = { remotePath: "/srv/proj", host: "h", port: 22 };
  const newPath = sandbox.api.getRemoteMarkerPath(sftp.remotePath, undefined);
  sandbox.sshScript = [`R${JSON.stringify(MARKER)}`];
  // vm 解析出的对象来自主域之外的 realm，深比较前经 JSON 归一化（仅夹具比较用，不改业务语义）。
  assert.deepEqual(JSON.parse(JSON.stringify(await sandbox.api.readRemoteHandoffMarker(sftp, undefined))), MARKER);
  assert.equal(sandbox.sshCalls.length, 1, "a readable new marker must not trigger the legacy read");
  assert.equal(sandbox.sshCalls[0].timeout, 15000);
  assert.ok(sandbox.sshCalls[0].command.includes(sandbox.api.shellQuote(newPath)));
  // r29: the single read command must prove the root and every managed parent before any sentinel.
  for (const parent of ["/srv/proj", "/srv/proj/simple_cluster", "/srv/proj/simple_cluster/state",
    "/srv/proj/simple_cluster/state/simple-sftp", "/srv/proj/simple_cluster/state/simple-sftp/handoff"]) {
    assert.ok(sandbox.sshCalls[0].command.includes(sandbox.api.shellQuote(parent)), `missing parent proof for ${parent}`);
  }
  for (const code of ["exit 61", "exit 62", "exit 63", "exit 64"]) {
    assert.ok(sandbox.sshCalls[0].command.includes(code), `missing fail-closed branch ${code}`);
  }
  // r30 ordinary-file contract: cat is gated by -f, non-regular existing entries fall to U, M only on absence.
  const tail = sandbox.sshCalls[0].command.slice(sandbox.sshCalls[0].command.lastIndexOf("elif [ -f"));
  assert.ok(tail.startsWith(`elif [ -f ${sandbox.api.shellQuote(newPath)} ]; then printf %s R; cat ${sandbox.api.shellQuote(newPath)}; elif [ -e ${sandbox.api.shellQuote(newPath)} ]; then printf %s U; else printf %s M; fi; }`));

  const legacyMarker = { schemaVersion: 1, action: "handoffReady", timestamp: "2026-01-01T00:00:00.000Z" };
  const legacyPath = sandbox.api.legacyRemoteMarkerPath(sftp.remotePath, undefined);
  sandbox.sshCalls.length = 0;
  sandbox.sshScript = ["M", JSON.stringify(legacyMarker)];
  assert.deepEqual(JSON.parse(JSON.stringify(await sandbox.api.readRemoteHandoffMarker(sftp, undefined))), legacyMarker);
  assert.equal(sandbox.sshCalls.length, 2);
  assert.equal(sandbox.sshCalls[1].command, `if [ -f ${sandbox.api.shellQuote(legacyPath)} ]; then cat ${sandbox.api.shellQuote(legacyPath)}; fi`);
  assert.equal(sandbox.sshCalls[1].timeout, 15000);
});

test("a broken, empty, unusable or unreadable new marker never falls back to the legacy file", async () => {
  for (const [label, response, expectation] of [
    ["broken json", "R{not-json", "rejected"],
    ["empty file", "R", "null"],
    ["symlink or directory", "U", "rejected"],
    ["lost sentinel", "", "rejected"],
    ["transport failure", new Error("ssh: connect timeout"), "rejected"],
  ]) {
    const sandbox = remoteMarkerSandbox();
    const sftp = { remotePath: "/srv/proj", host: "h", port: 22 };
    sandbox.sshScript = [response];
    if (expectation === "null") {
      assert.equal(await sandbox.api.readRemoteHandoffMarker(sftp, undefined), null, label);
    } else if (response instanceof Error) {
      await assert.rejects(sandbox.api.readRemoteHandoffMarker(sftp, undefined), /connect timeout/, label);
    } else if (label.startsWith("broken")) {
      // vm realm 的 SyntaxError 不是主域实例，按消息断言解析失败。
      await assert.rejects(sandbox.api.readRemoteHandoffMarker(sftp, undefined), /JSON/, label);
    } else {
      await assert.rejects(sandbox.api.readRemoteHandoffMarker(sftp, undefined), /交接标记|符号链接/, label);
    }
    assert.equal(sandbox.sshCalls.length, 1, `${label}: the legacy path must not be consulted`);
  }
});

test("spaces, Chinese characters and single quotes stay inside shell-quoted marker paths", async () => {
  const sandbox = remoteMarkerSandbox();
  const sftp = { remotePath: "/srv/项 目/it's", host: "h", port: 22 };
  const markerName = "my handoff.json";
  assert.equal(sandbox.api.shellQuote("it's"), `'it'\\''s'`);
  sandbox.sshScript = [`R${JSON.stringify(MARKER)}`];
  await sandbox.api.readRemoteHandoffMarker(sftp, markerName);
  const expectedNew = "/srv/项 目/it's/simple_cluster/state/simple-sftp/handoff/my handoff.json";
  assert.ok(sandbox.sshCalls[0].command.includes(sandbox.api.shellQuote(expectedNew)));

  sandbox.sshCalls.length = 0;
  sandbox.sshScript = ["M", ""];
  assert.equal(await sandbox.api.readRemoteHandoffMarker(sftp, markerName), null);
  const legacy = "/srv/项 目/it's/my handoff.json";
  assert.equal(sandbox.sshCalls[1].command, `if [ -f ${sandbox.api.shellQuote(legacy)} ]; then cat ${sandbox.api.shellQuote(legacy)}; fi`);
  assert.ok(sandbox.sshCalls[1].command.includes(`'\\''`), "single quotes must use the '\'' escape");
});

test("the writer creates only the managed tree under the same project root and overwrites one marker", async () => {
  const sandbox = remoteMarkerSandbox();
  const sftp = { remotePath: "/srv/proj/", host: "h", port: 22 };
  const newPath = sandbox.api.getRemoteMarkerPath(sftp.remotePath, undefined);
  const legacyPath = sandbox.api.legacyRemoteMarkerPath(sftp.remotePath, undefined);
  sandbox.sshScript = [""];
  await sandbox.api.writeRemoteHandoffMarker(sftp, undefined, MARKER);
  assert.equal(sandbox.sshCalls.length, 1);
  const command = sandbox.sshCalls[0].command;
  assert.equal(sandbox.sshCalls[0].timeout, 15000);
  let cursor = -1;
  const segments = ["simple_cluster", "state", "simple-sftp", "handoff"];
  for (let index = 0; index < segments.length; index += 1) {
    const expected = `/srv/proj/${segments.slice(0, index + 1).join("/")}`;
    const step = `{ if [ -L ${sandbox.api.shellQuote(expected)} ]; then exit 65; fi; mkdir -p -m 0700 ${sandbox.api.shellQuote(expected)}; }`;
    const found = command.indexOf(step, cursor + 1);
    assert.ok(found > cursor, `missing ordered managed-dir step for ${segments[index]}`);
    cursor = found;
  }
  assert.ok(command.includes(`{ if [ -L ${sandbox.api.shellQuote(newPath)} ]; then exit 66; fi;`));
  assert.ok(command.includes(`printf %s ${sandbox.api.shellQuote(`${JSON.stringify(MARKER, null, 2)}\n`)} > ${sandbox.api.shellQuote(newPath)}`));
  assert.ok(!command.includes(">>"), "the marker is overwritten, never appended");
  assert.ok(!command.includes(sandbox.api.shellQuote(legacyPath)), "the legacy root marker is never written");
  assert.ok(!command.includes("/root/"), "the managed tree stays under the configured project root");
  // A second write overwrites the same fixed file instead of leaving timestamped history.
  sandbox.sshCalls.length = 0;
  sandbox.sshScript = [""];
  await sandbox.api.writeRemoteHandoffMarker(sftp, undefined, { ...MARKER, timestamp: "2026-10-25T09:30:00.000Z" });
  const second = sandbox.sshCalls[0].command;
  const targetOf = (text) => text.slice(text.lastIndexOf("> "));
  assert.equal(targetOf(second), targetOf(command));
  assert.ok(command.trimEnd().endsWith(`> ${sandbox.api.shellQuote(newPath)}; }`));
});

test("the writer keeps the original lease operation, project scope, server identity and resource list", async () => {
  const sandbox = remoteMarkerSandbox();
  const sftp = { remotePath: "/srv/proj", host: "DEV.Server", port: 2222 };
  const newPath = sandbox.api.getRemoteMarkerPath(sftp.remotePath, undefined);
  sandbox.sshScript = [new Error("远端目录不可写")];
  await assert.rejects(sandbox.api.writeRemoteHandoffMarker(sftp, undefined, MARKER), /远端目录不可写/);
  assert.equal(sandbox.leaseCalls.length, 1);
  assert.equal(sandbox.leaseCalls[0].operation, "写入交接标记");
  assert.equal(sandbox.leaseCalls[0].project, sftp.remotePath);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.leaseCalls[0].paths)), [newPath]);
  assert.equal(sandbox.leaseCalls[0].server, "dev.server:2222");
  assert.equal(sandbox.sshCalls.length, 1, "a failed remote write is reported as-is without fallback attempts");
});

test("the marker payload keeps its original schema, timestamp and action bytes untouched", async () => {
  const sandbox = remoteMarkerSandbox();
  const sftp = { remotePath: "/srv/proj", host: "h", port: 22 };
  sandbox.sshScript = [""];
  await sandbox.api.writeRemoteHandoffMarker(sftp, "交接 标记.json", MARKER);
  const json = `${JSON.stringify(MARKER, null, 2)}\n`;
  assert.ok(sandbox.sshCalls[0].command.includes(`printf %s ${sandbox.api.shellQuote(json)} > `));
  assert.ok(sandbox.sshCalls[0].command.trimEnd().endsWith(`> ${sandbox.api.shellQuote(
    "/srv/proj/simple_cluster/state/simple-sftp/handoff/交接 标记.json",
  )}; }`));
});

test("the plain root tar excludes the managed handoff tree without touching other prefixes", () => {
  const sandbox = { path, DEFAULT_HANDOFF_MARKER: defaultMarkerName };
  vm.createContext(sandbox);
  vm.runInContext([
    extract("addTarExcludePattern"),
    extract("getTarExcludeArgs"),
    "this.api = { getTarExcludeArgs };",
  ].join("\n"), sandbox);
  const args = sandbox.api.getTarExcludeArgs(["custom_dir"]);
  assert.ok(args.includes("--exclude=simple_cluster/state/simple-sftp"));
  assert.ok(args.includes("--exclude=./simple_cluster/state/simple-sftp"));
  assert.ok(args.includes(`--exclude=${defaultMarkerName}`));
  assert.ok(args.includes(`--exclude=*/${defaultMarkerName}`));
  assert.ok(args.includes("--exclude=custom_dir"));
  assert.ok(!args.includes("--exclude=simple_cluster"), "simple_cluster/results and other kept prefixes stay transferable");
  assert.ok(!args.includes("--exclude=./simple_cluster"));
});
