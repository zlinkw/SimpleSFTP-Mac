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

function assertLocalProcessesIdle(rows, oldPid, allowCurrentOwner, currentPid = process.pid) {
  if (!Array.isArray(rows) || rows.some(row => !Number.isSafeInteger(Number(row?.ProcessId)) || Number(row.ProcessId) <= 0 || typeof row.Name !== "string"))
    throw new Error("LOCAL_PROCESS_PROOF_UNAVAILABLE");
  const live = rows.filter(row => !(allowCurrentOwner && oldPid === currentPid && Number(row.ProcessId) === currentPid)
    || /^(ssh|scp|sftp|plink|rsync|tar|gzip|pigz|zstd)\.exe$/i.test(row.Name));
  if (live.length) throw new Error("LOCAL_TRANSFER_OR_OWNER_STILL_ACTIVE");
}

async function localTransferExitProof(instanceId, allowCurrentOwner = false) {
  // A missing child count, elapsed time, or a Windows kill(pid, 0) exception
  // cannot establish that an abandoned transport has exited.
  const match = /^([1-9][0-9]{0,9}):/.exec(String(instanceId));
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
  const command = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $items=@(Get-CimInstance Win32_Process -Filter \"ProcessId=${oldPid} OR Name='ssh.exe' OR Name='scp.exe' OR Name='sftp.exe' OR Name='plink.exe' OR Name='rsync.exe' OR Name='tar.exe' OR Name='gzip.exe' OR Name='pigz.exe' OR Name='zstd.exe'\"); ConvertTo-Json -Compress -InputObject @($items | Select-Object ProcessId,Name)`;
  const output = await new Promise((resolve, reject) => execFile("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, timeout: 6000, maxBuffer: 32768, encoding: "utf8" }, (error, stdout) => error ? reject(new Error("LOCAL_PROCESS_PROOF_UNAVAILABLE")) : resolve(stdout)));
  const rows = JSON.parse(String(output));
  assertLocalProcessesIdle(rows, oldPid, allowCurrentOwner);
  return { localOwnerExited: oldPid !== process.pid, localTransportCount: 0 };
}

function settlementProbeCommand(root, quote) {
  const source = fs.readFileSync(path.join(__dirname, "transfer-settlement-probe.py"), "utf8");
  const encoded = zlib.deflateSync(Buffer.from(source, "utf8")).toString("base64");
  const loader = "import base64,zlib,sys; code=zlib.decompress(base64.b64decode(sys.argv[1])); sys.argv=sys.argv[1:]; exec(compile(code,'simple_sftp_settlement_probe','exec'))";
  const receiverHash = require("node:crypto").createHash("sha256")
    .update(fs.readFileSync(path.join(__dirname, "staged-tar-receive.py"))).digest("hex");
  return `python3 -B -c ${quote(loader)} ${quote(encoded)} ${quote(root)} ${quote(receiverHash)} ${quote("staged-tar-v1")}`;
}

module.exports = { READ_ONLY_SETTLEMENT_METHODS, clientRequestKey, retryIdentity, assertLocalProcessesIdle, localTransferExitProof, settlementProbeCommand };
