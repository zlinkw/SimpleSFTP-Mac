"use strict";
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// These protocols read project data; they never write or remove project outputs.
const READ_ONLY_SETTLEMENT_METHODS = ["sync.downloadMappedPaths", "sync.projectInventory", "sync.projectTree", "sync.projectFileStats"];

function identityOf(value) {
  if (!value || typeof value !== "object") return undefined;
  const result = {};
  for (const key of ["id", "name", "host", "hostname", "remotePath", "path", "port", "user", "username"])
    if (value[key] !== undefined && value[key] !== null) {
      if (!["string", "number"].includes(typeof value[key]) || String(value[key]).length > 4096) throw new Error("INVALID_TRANSFER_IDENTITY");
      result[key] = value[key];
    }
  return Object.keys(result).length ? result : undefined;
}

// Keep field order identical to the SimpleExperiment request-key protocol.
function retryIdentity(params) {
  const localPath = String(params.localPath || params.localBase || params.workspacePath || "").trim().replace(/[\\/]+/g, "/");
  const identity = {
    localPath: process.platform === "win32" ? localPath.toLowerCase() : localPath,
    remotePath: String(params.remotePath || "").trim(),
    targetId: params.targetId || params.serverId || "", host: params.host || "",
    server: identityOf(params.server), sftp: identityOf(params.sftp),
    source: identityOf(params.source), destination: identityOf(params.destination), target: identityOf(params.target),
  };
  if (JSON.stringify(identity).length > 16384) throw new Error("INVALID_TRANSFER_IDENTITY");
  return identity;
}
function clientRequestKey(method, params) {
  return createHash("sha256").update(JSON.stringify({ method, ...retryIdentity(params) })).digest("hex");
}

// Conservative Windows argv reader. Only a complete ssh -N invocation with no
// remote command is exempt; command-line text never leaves this local function.
function sshForwardOnly(command) {
  if (typeof command !== "string" || command.length > 32768 || /\\"/.test(command)) return false;
  const args = []; let word = "", quoted = false, started = false;
  for (const char of command) {
    if (char === '"') { quoted = !quoted; started = true; }
    else if (/\s/.test(char) && !quoted) { if (started) { args.push(word); word = ""; started = false; } }
    else { word += char; started = true; }
  }
  if (quoted) return false;
  if (started) args.push(word);
  if (!/(?:^|[\\/])ssh(?:[.]exe)?$/i.test(args.shift() || "")) return false;
  let noSession = false;
  const safeOptions = /^(?:ServerAliveInterval|ServerAliveCountMax|TCPKeepAlive|ExitOnForwardFailure|BatchMode|ConnectTimeout|ConnectionAttempts|StrictHostKeyChecking|UserKnownHostsFile|LogLevel|IdentitiesOnly|GatewayPorts|PasswordAuthentication|KbdInteractiveAuthentication|NumberOfPasswordPrompts)$/i;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) return noSession && i === args.length - 1 && Boolean(arg);
    if (/^-[46CfgnNqTtv]+$/.test(arg)) { noSession ||= arg.includes("N"); continue; }
    if (/^-[LRDpli]/.test(arg)) { if (arg.length === 2 && !args[++i]) return false; continue; }
    if (arg === "-o" || arg.startsWith("-o")) {
      const value = arg.length > 2 ? arg.slice(2) : args[++i];
      if (!value || !safeOptions.test(value.split(/[=\s]/)[0])) return false;
      continue;
    }
    return false;
  }
  return false;
}

function assertLocalProcessesIdle(rows, oldPid, allowCurrentOwner, currentPid = process.pid, oldStartedAt) {
  if (!Array.isArray(rows) || rows.length > 8192 || rows.some(row => !Number.isSafeInteger(row?.ProcessId) || row.ProcessId < 0
    || !Number.isSafeInteger(row.ParentProcessId) || row.ParentProcessId < 0 || typeof row.Name !== "string" || !row.Name || row.Name.length > 260))
    throw new Error("LOCAL_PROCESS_PROOF_UNAVAILABLE");
  const processes = new Map(rows.map(row => [row.ProcessId, row]));
  if (processes.size !== rows.length) throw new Error("LOCAL_PROCESS_PROOF_UNAVAILABLE");
  const checked = new Set();
  for (const row of rows) {
    const chain = new Set();
    let cursor = row;
    while (cursor && cursor.ProcessId !== 0 && !checked.has(cursor.ProcessId)) {
      if (chain.has(cursor.ProcessId)) throw new Error("LOCAL_PROCESS_ANCESTRY_UNAVAILABLE");
      chain.add(cursor.ProcessId);
      cursor = cursor.ParentProcessId === 0 ? undefined : processes.get(cursor.ParentProcessId);
    }
    for (const id of chain) checked.add(id);
  }
  const owner = processes.get(oldPid), createdAt = row => typeof row?.CreationDate === "string" ? Date.parse(row.CreationDate) : NaN;
  const ownerReused = owner && Number.isFinite(oldStartedAt) && createdAt(owner) > oldStartedAt;
  if (owner && !ownerReused && !(allowCurrentOwner && oldPid === currentPid))
    throw new Error("LOCAL_TRANSFER_OR_OWNER_STILL_ACTIVE");
  let unrelatedTransports = 0;
  for (const transport of rows.filter(row => /^(ssh|scp|sftp|plink|rsync|tar|gzip|pigz|zstd)\.exe$/i.test(row.Name))) {
    // A port-forward-only client cannot be this protocol's remote command.
    // Its exited shell ancestor is irrelevant, but ordinary/unknown SSH still
    // needs complete ancestry and all writer exit checks remain in place.
    if (/^ssh[.]exe$/i.test(transport.Name) && transport.forwardOnly === true) { unrelatedTransports++; continue; }
    let cursor = transport, birthChainVerified = true;
    const seen = new Set();
    while (true) {
      if (seen.has(cursor.ProcessId)) throw new Error("LOCAL_PROCESS_ANCESTRY_UNAVAILABLE");
      seen.add(cursor.ProcessId);
      if (cursor.ProcessId === oldPid || cursor.ParentProcessId === oldPid) {
        // A reused owner PID is a different process generation. A child born
        // before that replacement (or without birth evidence) remains guarded.
        if (ownerReused && createdAt(cursor) >= createdAt(owner)) break;
        throw new Error("LOCAL_TRANSFER_OR_OWNER_STILL_ACTIVE");
      }
      if (oldPid !== currentPid && cursor.ProcessId === currentPid) {
        // A transport born under this different, live producer cannot belong
        // to the abandoned producer. Do not require its exited Windows login
        // ancestors to remain alive; verify every child/parent generation.
        if (!birthChainVerified) throw new Error("LOCAL_PROCESS_ANCESTRY_UNAVAILABLE");
        break;
      }
      if (cursor.ProcessId === 0 || cursor.ParentProcessId === 0) break;
      const parent = processes.get(cursor.ParentProcessId);
      if (!parent || createdAt(parent) > createdAt(cursor)) throw new Error("LOCAL_PROCESS_ANCESTRY_UNAVAILABLE");
      birthChainVerified &&= Number.isFinite(createdAt(parent)) && Number.isFinite(createdAt(cursor));
      cursor = parent;
    }
    unrelatedTransports++;
  }
  // A complete census must contain this live producer. Empty or filtered
  // snapshots cannot prove the old owner/children absent.
  if (!processes.has(currentPid)) throw new Error("LOCAL_PROCESS_PROOF_UNAVAILABLE");
  return { localOwnerExited: !owner || Boolean(ownerReused), localTransportCount: 0, unrelatedTransportCount: unrelatedTransports };
}

async function localTransferExitProof(instanceId, allowCurrentOwner = false) {
  // Census the original owner's process tree, not all transports on the PC.
  // Missing ancestry, a live original owner, and old descendants still deny
  // replay. Creation time distinguishes a reused PID from the old generation.
  const match = /^([1-9][0-9]{0,9}):(.+)$/.exec(String(instanceId));
  const oldStartedAt = match ? Date.parse(match[2]) : NaN;
  if (!match) throw new Error("LOCAL_PROCESS_PROOF_UNAVAILABLE");
  const oldPid = Number(match[1]);
  if (process.platform === "darwin") {
    if (!Number.isSafeInteger(oldPid) || oldPid > 2147483647) throw new Error("LOCAL_PROCESS_PROOF_UNAVAILABLE");
    const output = await new Promise((resolve, reject) => execFile("/bin/ps", ["-ax", "-o", "pid=,comm="],
      { windowsHide: true, timeout: 6000, maxBuffer: 512 * 1024, encoding: "utf8" },
      (error, stdout) => error ? reject(new Error("LOCAL_PROCESS_PROOF_UNAVAILABLE")) : resolve(stdout)));
    if (typeof output !== "string" || Buffer.byteLength(output) > 512 * 1024 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffd]/.test(output)) throw new Error("LOCAL_PROCESS_PROOF_UNAVAILABLE");
    const rows = [], pids = new Set();
    for (const line of output.split(/\r?\n/).filter(line => line.trim())) {
      const row = /^\s*([1-9][0-9]*)\s+(.+?)\s*$/.exec(line);
      const pid = row && Number(row[1]);
      if (!row || !Number.isSafeInteger(pid) || pid > 2147483647 || pids.has(pid)) throw new Error("LOCAL_PROCESS_PROOF_UNAVAILABLE");
      pids.add(pid); rows.push({ pid, name: path.posix.basename(row[2]) });
    }
    // A missing current owner means the native snapshot is incomplete, not idle.
    if (!pids.has(process.pid)) throw new Error("LOCAL_PROCESS_PROOF_UNAVAILABLE");
    const transport = /^(ssh|scp|sftp|rsync|tar|gzip|pigz|zstd)$/i;
    if (rows.some(row => transport.test(row.name) || row.pid === oldPid && !(allowCurrentOwner && oldPid === process.pid)))
      throw new Error("LOCAL_TRANSFER_OR_OWNER_STILL_ACTIVE");
    return { localOwnerExited: oldPid !== process.pid, localTransportCount: 0 };
  }
  if (process.platform !== "win32") throw new Error("LOCAL_PROCESS_PROOF_UNAVAILABLE");
  // Windows birth evidence compares the old producer's start time; without a
  // parseable identity it must deny recovery instead of guessing a generation.
  if (!Number.isFinite(oldStartedAt)) throw new Error("LOCAL_PROCESS_PROOF_UNAVAILABLE");
  const command = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $items=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate,@{Name='SshCommandLine';Expression={if($_.Name -ieq 'ssh.exe'){$_.CommandLine}else{$null}}}); if($items.Count -gt 8192){throw 'LOCAL_PROCESS_PROOF_UNAVAILABLE'}; ConvertTo-Json -Compress -InputObject @($items)`;
  const output = await new Promise((resolve, reject) => execFile("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, timeout: 6000, maxBuffer: 1048576, encoding: "utf8" }, (error, stdout) => error ? reject(new Error("LOCAL_PROCESS_PROOF_UNAVAILABLE")) : resolve(stdout)));
  const rows = JSON.parse(String(output));
  if (!Array.isArray(rows)) throw new Error("LOCAL_PROCESS_PROOF_UNAVAILABLE");
  for (const row of rows) {
    row.forwardOnly = /^ssh[.]exe$/i.test(row.Name) && sshForwardOnly(row.SshCommandLine);
    delete row.SshCommandLine;
  }
  return assertLocalProcessesIdle(rows, oldPid, allowCurrentOwner, process.pid, oldStartedAt);
}

function settlementProbeCommand(root, quote, protocol = "staged-tar-v1") {
  if (!["staged-tar-v1", "plain-tar-v1"].includes(protocol)) throw new Error("INVALID_TRANSFER_PROTOCOL");
  const source = fs.readFileSync(path.join(__dirname, "transfer-settlement-probe.py"), "utf8");
  const encoded = zlib.deflateSync(Buffer.from(source, "utf8")).toString("base64");
  const loader = "import base64,zlib,sys; code=zlib.decompress(base64.b64decode(sys.argv[1])); sys.argv=sys.argv[1:]; exec(compile(code,'simple_sftp_settlement_probe','exec'))";
  const receiverHash = require("node:crypto").createHash("sha256")
    .update(fs.readFileSync(path.join(__dirname, "staged-tar-receive.py"))).digest("hex");
  return `python3 -B -c ${quote(loader)} ${quote(encoded)} ${quote(root)} ${quote(receiverHash)} ${quote(protocol)}`;
}

module.exports = { READ_ONLY_SETTLEMENT_METHODS, clientRequestKey, retryIdentity, assertLocalProcessesIdle, localTransferExitProof, settlementProbeCommand, sshForwardOnly };
