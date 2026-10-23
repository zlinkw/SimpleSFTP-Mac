"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { atomicWriteText } = require("./state-store");
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Binary numbers avoid JavaScript/Python decimal and exponent formatting differences.
const canonical = value => typeof value === "number" ? "n" + (() => {
  if (!Number.isFinite(value)) fail("CLEANUP_INPUT_CHANGED");
  const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value === 0 ? 0 : value); return bytes.toString("hex");
})() : Array.isArray(value) ? "[" + value.map(row => canonical(row) ?? "null").join(",") + "]" : value && typeof value === "object"
  ? "{" + Object.keys(value).filter(key => value[key] !== undefined).sort((a,b) => Buffer.compare(Buffer.from(a),Buffer.from(b)))
    .map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}" : JSON.stringify(value);
const targetHash = value => crypto.createHash("sha256").update(canonical(value)).digest("hex");
const copy = value => JSON.parse(JSON.stringify(value));
// Codes that MAY accompany a zero-mutation refusal. The code alone is never
// sufficient: retry additionally requires the engine's explicit
// mutationStarted=false fact, because the same codes can also surface after
// earlier unlinks (mid-walk or file-group recheck) of a partially mutated batch.
const FAST_VERIFY_BATCH_LIMIT = 5000; // engine FAST_BATCH_LIMIT parity, counted in EXPANDED verify entries
const FAST_ZERO_MUTATION_CODES = new Set(["ENTRY_IDENTITY_CHANGED", "MISSING_TARGET", "TYPE_CHANGED", "UNCERTAIN_TYPE",
  "UNSAFE_PATH", "UNSAFE_PARENT", "FAST_BATCH_INVALID", "INVALID_AUTHORIZATION_MODE", "ROOT_IDENTITY_CHANGED",
  "NOT_REGISTERED_ISOLATION", "PROTECTED_PATH", "UNSAFE_ARCHIVE_BATCH"]);
const isFastDeleteRow = row => row.authorizationMode === "confirmed_paths" && row.action === "delete";
// The only remote deletion chain runs a content-addressed engine program that
// was pinned into the protected managed program area; requests never carry a
// copy of the source through argv. Commands stay far below the Windows argv
// quoting budget because only a fixed short invocation crosses the wire.
const REMOTE_COMMAND_BUDGET = 20000;
const RUNTIME_PROGRAM_DIR = "clean_dir/.operations/managed";
function runtimeProgramRelativePath(sha256) {
  if (!/^[a-f0-9]{64}$/.test(String(sha256))) fail("INVALID_REQUEST");
  return RUNTIME_PROGRAM_DIR + "/runtime-" + sha256 + ".py";
}
function runtimePrepareRequest({ root, source, rootIdentity }) {
  if (typeof source !== "string" || !source || Buffer.byteLength(source) > 262144) fail("INVALID_REQUEST");
  const sha256 = crypto.createHash("sha256").update(source).digest("hex");
  const request = { action: "runtime-prepare", root, runtimeSha256: sha256, runtimeSource: source };
  // The identity travels as the real {path,device,inode,machine,user} object
  // contract when one is already known; the engine and installer must observe
  // the very same verified root or the install is refused. A wrong shape is
  // an explicit error, never a silently dropped field.
  if (rootIdentity !== undefined && rootIdentity !== null) {
    if (typeof rootIdentity !== "object" || typeof rootIdentity.path !== "string" || !rootIdentity.path
      || typeof rootIdentity.device !== "string" || typeof rootIdentity.inode !== "string") fail("INVALID_REQUEST");
    request.rootIdentity = copy(rootIdentity);
  }
  return { sha256, programRelativePath: runtimeProgramRelativePath(sha256), request };
}
// The bounded short installer never creates before checking: the root itself
// is first pinned through O_DIRECTORY|O_NOFOLLOW and its identity is derived
// from that very pinned fd (device+inode of the open, never of a later
// re-stat), so a same-device inode swap between checks is refused with
// ROOT_IDENTITY_CHANGED before any creation. Every managed-program component
// is opened through the pinned dir_fd chain (a missing level is only created
// after its parent fd is proven), mounts and reparse points are refused, the
// directory owner must be the executing user, and the program itself is
// created O_EXCL with a write loop until the last byte, fsync and full
// read-back. The installer is POSIX-openat-only and FAIL-CLOSED: a missing
// O_NOFOLLOW/O_DIRECTORY flag or dir_fd capability aborts with
// RUNTIME_CAPABILITY_UNAVAILABLE before any mkdir or write — there is no
// weaker path-based fallback (the old plain_chain downgrade is removed).
// This only bounds the remote short installer: local nodes execute the engine
// directly (its own platform path_guard), so Windows local cleanup is
// unaffected. First installs bind and return the verified root identity; a
// supplied identity must match the pinned fd exactly.
const RUNTIME_PREPARE_BOOTSTRAP = [
  "import hashlib,json,os,socket,stat,sys",
  "def out(code,detail=''):",
  "    sys.stdout.write(json.dumps({'ok':False,'error':{'code':code,'message':detail}}));raise SystemExit(1)",
  "def done(state):",
  "    sys.stdout.write(json.dumps({'ok':True,'state':state,'runtimeSha256':sha,'programRelativePath':'" + RUNTIME_PROGRAM_DIR + "/runtime-'+sha+'.py','rootIdentity':identity}));raise SystemExit(0)",
  "try:",
  "    req=json.loads(sys.stdin.buffer.read(4194304).rstrip(b" + "\"\\x00\"" + ").decode('utf-8'))",
  "except Exception:",
  "    out('INVALID_REQUEST')",
  "if not isinstance(req,dict) or req.get('action')!='runtime-prepare':out('INVALID_REQUEST')",
  "src=req.get('runtimeSource');sha=req.get('runtimeSha256')",
  "if not isinstance(src,str) or not isinstance(sha,str):out('INVALID_REQUEST')",
  "code=src.encode('utf-8')",
  "if len(code)==0 or len(code)>262144 or len(sha)!=64 or hashlib.sha256(code).hexdigest()!=sha:out('RUNTIME_CODE_MISMATCH')",
  "root=req.get('root')",
  "if not isinstance(root,str) or not os.path.isabs(root) or chr(0) in root or '..' in root.replace(chr(92),'/').split('/'):out('UNSAFE_ROOT')",
  "if os.path.normpath(os.path.realpath(root))!=os.path.normpath(root) or not os.path.isdir(root):out('ROOT_IDENTITY_CHANGED')",
  "cursor=root",
  "while cursor!=os.path.dirname(cursor):",
  "    info=os.lstat(cursor)",
  "    if stat.S_ISLNK(info.st_mode) or getattr(info,'st_file_attributes',0)&1024:out('LINK_OR_REPARSE_POINT',cursor)",
  "    cursor=os.path.dirname(cursor)",
  "import re as _re",
  "mounts=set()",
  "try:",
  "    if os.path.exists('/proc/self/mountinfo'):",
  "        with open('/proc/self/mountinfo','r',encoding='utf-8') as stream:",
  "            mounts={os.path.abspath(_re.sub(r'\\\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),line.split()[4])) for line in stream if len(line.split())>4}",
  "except OSError:",
  "    pass",
  "for capability in ('O_RDONLY','O_WRONLY','O_CREAT','O_EXCL','O_NOFOLLOW','O_DIRECTORY'):",
  "    if not hasattr(os,capability):out('RUNTIME_CAPABILITY_UNAVAILABLE',capability)",
  "DIRS=('clean_dir','.operations','managed')",
  "def fail_open(error,chain):",
  "    out('LINK_OR_REPARSE_POINT' if getattr(error,'errno',None) in (40,62) else 'RUNTIME_PROGRAM_PREPARE_FAILED',chain+':'+str(error))",
  "FLAGS=os.O_DIRECTORY|os.O_NOFOLLOW",
  "try:",
  "    fd=os.open(root,os.O_RDONLY|FLAGS)",
  "except OSError as error:",
  "    fail_open(error,root)",
  "info=os.fstat(fd)",
  "if not stat.S_ISDIR(info.st_mode):out('UNSAFE_ROOT',root)",
  "identity={'path':root,'device':str(info.st_dev),'inode':str(info.st_ino),'machine':socket.gethostname(),'user':str(os.getuid()) if hasattr(os,'getuid') else os.environ.get('USERNAME','')}",
  "if req.get('rootIdentity') is not None and req['rootIdentity']!=identity:out('ROOT_IDENTITY_CHANGED')",
  "root_dev=info.st_dev",
  "def pinned_chain(fd):",
  "    chain=root",
  "    for name in DIRS:",
  "        chain=chain+'/'+name",
  "        if os.path.ismount(chain) or chain in mounts:out('MOUNT_ESCAPE',chain)",
  "        try:",
  "            child=os.open(name,os.O_RDONLY|FLAGS,dir_fd=fd)",
  "        except FileNotFoundError:",
  "            try:",
  "                os.mkdir(name,mode=0o700,dir_fd=fd)",
  "            except FileExistsError:",
  "                pass",
  "            except OSError as error:",
  "                out('RUNTIME_PROGRAM_PREPARE_FAILED',chain+':'+str(error))",
  "            try:",
  "                child=os.open(name,os.O_RDONLY|FLAGS,dir_fd=fd)",
  "            except OSError as error:",
  "                fail_open(error,chain)",
  "        except OSError as error:",
  "            fail_open(error,chain)",
  "        info=os.fstat(child)",
  "        if not stat.S_ISDIR(info.st_mode) or info.st_dev!=root_dev:out('MOUNT_ESCAPE',chain)",
  "        if os.path.ismount(chain) or chain in mounts:out('MOUNT_ESCAPE',chain)",
  "        if hasattr(os,'getuid') and info.st_uid!=os.getuid():out('RUNTIME_PROGRAM_PREPARE_FAILED',chain+' 归属不符')",
  "        os.close(fd)",
  "        fd=child",
  "    return fd",
  "try:",
  "    dirfd=pinned_chain(fd)",
  "except (NotImplementedError,ValueError,AttributeError) as error:",
  "    out('RUNTIME_CAPABILITY_UNAVAILABLE','dir_fd:'+str(error))",
  "progname='runtime-'+sha+'.py'",
  "def verify_existing():",
  "    try:",
  "        pfd=os.open(progname,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=dirfd)",
  "    except OSError as error:",
  "        fail_open(error,progname)",
  "    info=os.fstat(pfd)",
  "    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size!=len(code):out('RUNTIME_PROGRAM_MISMATCH',progname)",
  "    handle=os.fdopen(pfd,'rb')",
  "    same=handle.read()==code",
  "    handle.close()",
  "    if not same:out('RUNTIME_PROGRAM_MISMATCH',progname)",
  "try:",
  "    _probe=os.open(progname,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=dirfd)",
  "    os.close(_probe)",
  "    verify_existing();done('verified')",
  "except FileNotFoundError:",
  "    pass",
  "except OSError as error:",
  "    fail_open(error,progname)",
  "try:",
  "    fd2=os.open(progname,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600,dir_fd=dirfd)",
  "except FileExistsError:",
  "    verify_existing();done('verified')",
  "except OSError as error:",
  "    fail_open(error,progname)",
  "view=memoryview(code);written=0",
  "while written<len(code):",
  "    written+=os.write(fd2,view[written:])",
  "os.fsync(fd2)",
  "info=os.fstat(fd2)",
  "if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:out('RUNTIME_PROGRAM_MISMATCH',progname)",
  "os.close(fd2)",
  "verify_existing()",
  "done('installed')",
].join("\n");
function remoteRuntimePrepareCommand(shellQuote) {
  const command = "python3 -B -c " + shellQuote(RUNTIME_PREPARE_BOOTSTRAP);
  if (command.length > REMOTE_COMMAND_BUDGET) fail("REMOTE_COMMAND_TOO_LARGE");
  return command;
}
function remoteRuntimeCommand(programPath, shellQuote) {
  if (typeof programPath !== "string" || !programPath.startsWith("/") || programPath.includes("\0")) fail("UNSAFE_ROOT");
  const command = "python3 -B -X utf8 " + shellQuote(programPath);
  if (command.length > REMOTE_COMMAND_BUDGET) fail("REMOTE_COMMAND_TOO_LARGE");
  return command;
}
// One synchronous, memory-only projection of the three transfer-activity sets. The cleanup guard and the read-only
// transfers.list route must agree on exactly this value, so the predicate is written once here instead of twice.
// A status that is not one of the terminal names stays busy (fail closed). Nothing here reads the filesystem, the
// network or any ledger, and a raw workspace key never leaves the projection: queue keys travel as one-way hashes only.
const TERMINAL_TRANSFER_STATUSES = new Set(["completed", "failed", "cancelled"]);
const MAX_BUSY_ROWS = 12;
// 文本化只用于输出：恶意/异常 toString 不得让守卫抛出别的错误码，兜底成空串后仍按原值判忙。
const busyText = (value, max = 40) => { try { return String(value ?? "").slice(0, max).replace(/[\u0000-\u001f]/g, " "); } catch { return ""; } };
// 终态判定必须用 status 原值：0.2.102 用的是 ["completed","failed","cancelled"].includes(row.status)（SameValueZero），
// new String("completed")、自定义 toString 的 {toString:()=>"completed"} 在原版里都不算终态，判忙之前绝不能先转成文本。
const busyStatusText = status => typeof status === "string" ? busyText(status, 32) || "unknown" : "unknown";
// 队列键是一向哈希：无法文本化的键也要计入忙（原版 uploadQueues.size 无条件计数），但绝不外泄原值。
const queueKeyHash = key => { let text; try { text = String(key).toLowerCase(); } catch { text = "unstringifiable:" + typeof key; }
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 12); };
function transferBusySnapshot(collections = {}, identity = {}) {
  // 只读观测身份只认控制器携带的生产事实（路由证明的 readObserver 且明确非远端变更）；
  // 缺任一项、值为 null 或状态异常的行都继续按写入计忙，绝不因为名字像只读就放行。
  const readOnlyObserver = row => Boolean(row) && row.readObserver === true && row.remoteMutation === false;
  // 自身豁免只认调用上下文里由服务端路由登记的那一个控制器对象（对象同一性）。
  // 控制器 id 由服务端生成、operationId 可被客户端 _operationId 指定，因此两者都不作为豁免依据；
  // 缺上下文、非同一对象或其他任何在途行一律继续按写入计忙（fail closed）。
  const self = collections.self && typeof collections.self === "object" ? collections.self : null;
  const nonTerminalRows = [...(collections.transfers || [])]
    // Set.has(原值) 与原版 Array.includes(原值) 同语义；缺 row.status（含 null 行）按非终态计忙，比原版崩溃更保守。
    .filter(row => !TERMINAL_TRANSFER_STATUSES.has(row && row.status))
    .map(row => ({ readOnlyObserver: readOnlyObserver(row), selfAttempt: Boolean(self) && row === self, id: busyText(row && row.id), status: busyStatusText(row && row.status),
      ...(row && row.operation ? { operation: busyText(row.operation) } : {}), ...(row && row.phase ? { phase: busyText(row.phase) } : {}) }));
  const blockingTransferCount = nonTerminalRows.filter(row => row.readOnlyObserver !== true && row.selfAttempt !== true).length;
  const uploadOperations = [...(collections.uploadOperations || [])]
    .map(row => ({ id: busyText(row.id), ...(row.stage ? { stage: busyText(row.stage) } : {}) }));
  const keys = [...(collections.uploadQueueKeys || [])];
  const snapshot = {
    schemaVersion: 1,
    observedAt: busyText(identity.observedAt, 40),
    instanceId: busyText(identity.instanceId, 60),
    // 忙判定只认真正可能改动文件系统的传输（写入/未知状态）；被生产事实证明的只读观测
    // （清理预览/巡检、代码清单等）不再互相对撞，但逐条保留在快照里，当时在途的事实不会被抹掉。
    busy: blockingTransferCount > 0 || uploadOperations.length > 0 || keys.length > 0,
    activeTransferCount: nonTerminalRows.length,
    blockingTransferCount,
    observerTransferCount: nonTerminalRows.filter(row => row.readOnlyObserver === true).length,
    selfAttemptCount: nonTerminalRows.filter(row => row.selfAttempt === true).length,
    activeTransfers: nonTerminalRows.slice(0, MAX_BUSY_ROWS),
    uploadOperationCount: uploadOperations.length,
    uploadOperations: uploadOperations.slice(0, MAX_BUSY_ROWS),
    uploadQueueCount: keys.length,
    uploadQueues: { count: keys.length, keyHashes: keys.slice(0, MAX_BUSY_ROWS).map(queueKeyHash) },
  };
  if (nonTerminalRows.length > MAX_BUSY_ROWS || uploadOperations.length > MAX_BUSY_ROWS || keys.length > MAX_BUSY_ROWS) snapshot.truncated = true;
  return snapshot;
}
// Only the projection's own shape may travel inside an error: an unrelated object can never smuggle extra fields.
function busyEvidence(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || snapshot.schemaVersion !== 1) return undefined;
  const row = (value, fields) => value && typeof value === "object"
    ? Object.fromEntries(fields.filter(field => typeof value[field] === "string" && value[field]).map(field => [field, String(value[field]).slice(0, 40)])) : null;
  const pick = (value, fields) => Array.isArray(value) ? value.map(item => row(item, fields)).filter(Boolean).slice(0, MAX_BUSY_ROWS) : [];
  const queues = snapshot.uploadQueues && typeof snapshot.uploadQueues === "object" ? snapshot.uploadQueues : {};
  const hashes = Array.isArray(queues.keyHashes) ? queues.keyHashes.filter(key => /^[0-9a-f]{6,64}$/.test(String(key))).map(String).slice(0, MAX_BUSY_ROWS) : [];
  const counts = name => Number.isInteger(snapshot[name]) && snapshot[name] >= 0 ? snapshot[name] : undefined;
  const transferRow = value => { const base = row(value, ["id", "status", "operation", "phase"]); if (!base) return null;
    // 只读观测标记是白名单里的布尔事实：外部对象无法伪造出别的字段。
    base.readOnlyObserver = value.readOnlyObserver === true; base.selfAttempt = value.selfAttempt === true; return base; };
  const transferRows = Array.isArray(snapshot.activeTransfers) ? snapshot.activeTransfers.map(transferRow).filter(Boolean).slice(0, MAX_BUSY_ROWS) : [];
  const evidence = {
    schemaVersion: 1, observedAt: busyText(snapshot.observedAt, 40), instanceId: busyText(snapshot.instanceId, 60),
    busy: snapshot.busy === true,
    activeTransferCount: counts("activeTransferCount") ?? transferRows.length,
    blockingTransferCount: counts("blockingTransferCount") ?? transferRows.filter(item => item.readOnlyObserver !== true).length,
    observerTransferCount: counts("observerTransferCount") ?? transferRows.filter(item => item.readOnlyObserver === true).length,
    selfAttemptCount: counts("selfAttemptCount") ?? transferRows.filter(item => item.selfAttempt === true).length,
    activeTransfers: transferRows,
    uploadOperationCount: counts("uploadOperationCount") ?? 0, uploadOperations: pick(snapshot.uploadOperations, ["id", "stage"]),
    uploadQueueCount: counts("uploadQueueCount") ?? counts("queueCount") ?? hashes.length,
    uploadQueues: { count: counts("uploadQueueCount") ?? hashes.length, keyHashes: hashes },
  };
  if (snapshot.truncated === true) evidence.truncated = true;
  return evidence;
}
function fail(code, message = code, details = {}) { const error = new Error(message); error.code = code; error.apiCode = code === "CONFIRM_REQUIRED" ? 2001 : 2010; error.apiData = { code };
  for (const key of ["blockingPath", "reason"]) if (typeof details[key] === "string" && details[key]) error.apiData[key] = details[key].slice(0, 4096);
  // The refuse-moment busy snapshot travels with the refusal: a later idle projection must never overwrite what
  // was actually in flight when the guard said no, and the caller never has to guess from a bare code string.
  const busy = busyEvidence(details.busy); if (busy) error.apiData.busy = busy;
  // The engine's explicit batch-phase fact travels with the error: a retry is
  // only admissible when it proves the refused batch mutated nothing.
  if (typeof details.mutationStarted === "boolean") error.mutationStarted = details.mutationStarted;
  throw error; }

// Discriminating identity fields of a CleanupNode; tokens bind to exactly one
// node, so an observation request must agree on every field both sides carry.
// When both sides carry a stable worker id it must match too: two tunnels can
// share host/port/user yet terminate on different workers, and evidence frozen
// under one worker id never answers for the other. An id-free side keeps the
// older sync-scope field-only compatibility.
const sameNode = (a, b) => Boolean(a && b) && ["kind", "root", "host", "port", "user"].every(field => String(a[field] ?? "") === String(b[field] ?? ""))
  && (a.id === undefined || a.id === null || a.id === "" || b.id === undefined || b.id === null || b.id === "" || String(a.id) === String(b.id));

/** A path capability authorizes one frozen batch, never a later or remembered path. */
class CleanupFileApi {
  constructor({ storageRoot, transport, activity, lease }) {
    this.storageRoot = storageRoot; this.transport = transport; this.activity = activity; this.lease = lease;
    this.previews = new Map(); this.busy = new Set(); this.localExecutions = new Map();
    this.observeInFlight = 0; this.observeWaiters = [];
  }
  /** Shared read-only in-flight budget for the whole API instance: exactly two
   *  engine reads at once, independent of any request's readConcurrency. Each
   *  request bounds only itself through its batch windows, so two concurrent
   *  readConcurrency=1 rounds may legitimately hold both global slots together,
   *  while readConcurrency=2 rounds can never stack past two. The finally path
   *  releases the slot on failed reads so later rounds keep running. */
  async observeSlot(run) {
    while (this.observeInFlight >= 2) await new Promise(resolve => this.observeWaiters.push(resolve));
    this.observeInFlight += 1;
    try { return await run(); }
    finally { this.observeInFlight -= 1; const next = this.observeWaiters.shift(); if (next) next(); }
  }
  async checked(request) {
    const value = await this.transport(copy(request));
    if (!value?.ok) fail(value?.error?.code || "UNVERIFIED_RESPONSE", value?.error?.message, value?.error || {});
    return value;
  }
  async read(token) {
    if (!/^[a-f0-9]{48}$/.test(String(token))) fail("INVALID_TOKEN");
    const memory = this.previews.get(token);
    if (memory) return copy(memory);
    try { return JSON.parse(await fs.readFile(path.join(this.storageRoot, token + ".json"), "utf8")); }
    catch { fail("PREVIEW_EXPIRED"); }
  }
  async save(row) { await atomicWriteText(path.join(this.storageRoot, row.token + ".json"), JSON.stringify(row)); this.previews.set(row.token, copy(row)); }
  async preview(params) {
    const tmuxSessionPrefix = String(params.tmuxSessionPrefix || "simple").trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(tmuxSessionPrefix)) fail("INVALID_TMUX_SESSION_PREFIX");
    for (const [token, preview] of this.previews) if (Date.now() > preview.expiresAt) this.previews.delete(token);
    if (this.previews.size >= 4096) fail("CLEANUP_PREVIEW_CAPACITY_EXCEEDED");
    const { node, action = "move", targets } = params;
    if (params.authorizationMode !== undefined && params.authorizationMode !== "confirmed_paths") fail("INVALID_AUTHORIZATION_MODE");
    const pathOnly = params.authorizationMode === "confirmed_paths";
    // Confirmed paths only ever authorize permanent deletion; a move/restore
    if (pathOnly && action !== "delete") fail("INVALID_ACTION");
    const observationMode = params.observationMode === "managed_tmux" || pathOnly ? node?.kind === "local" ? "filesystem" : "tmux" : undefined;
    // Public batch entry: pathOnly (confirmed permanent deletion) rides the
    // batched fast chain and accepts the full engine FAST_BATCH_LIMIT of 5000
    // targets; move/restore/isolate keep their own per-target 500 limit.
    if (!node?.root || !["move", "delete", "restore", "isolate"].includes(action) || !Array.isArray(targets) || !targets.length || targets.length > (pathOnly ? 5000 : 500)) fail("INVALID_REQUEST");
    if (pathOnly) return await this.previewFast(node, targets, tmuxSessionPrefix);
    if (!pathOnly) await this.activity(node);
    const rows = []; let identity;
    for (const original of targets) {
      const target = { ...original, ...(observationMode ? { activityEvidenceMode: "managed_tmux" } : {}) };
      if (pathOnly) { target.authorizationMode = "confirmed_paths"; delete target.expectedOwner; delete target.expectedSha256; }
      else if (target.authorizationMode !== undefined) fail("INVALID_AUTHORIZATION_MODE");
      if (!target || !["file", "directory"].includes(target.type)) fail("UNCERTAIN_TYPE");
      if (target.archiveBatch !== undefined && !/^job-[a-f0-9]{48}$/.test(target.archiveBatch)) fail("UNSAFE_ARCHIVE_BATCH");
      // C1: a controlled fast isolation always lands in an explicit job batch
      // derived from this rerun intent; recovery of the same intent is stable.
      if (action === "isolate" && target.archiveBatch === undefined) fail("UNSAFE_ARCHIVE_BATCH");
      if (target.requiredInputs !== undefined && (!Array.isArray(target.requiredInputs) || target.requiredInputs.length > 200
        || target.requiredInputs.some(name => typeof name !== "string" || !name || name.length > 4096
          || /[\\\x00-\x1f:*?[\]{}]/.test(name) || name.startsWith("/")
          || name.split("/").some(part => part === "" || part === "." || part === "..")))) fail("INVALID_REQUEST");
      // C4: confirmed-path permanent deletion reaches only registered isolated
      // artifact subtrees; the clean_dir root, MANIFEST, locks and runtime stay out.
      const archivedDelete = pathOnly && /^clean_dir\/job-[a-f0-9]{48}\//.test(String(target.relativePath || ""));
      if (pathOnly && String(target.relativePath || "").startsWith("clean_dir/") && !archivedDelete) fail("UNSAFE_DESTINATION");
      const archivePrefix = "clean_dir/" + (target.archiveBatch ? target.archiveBatch + "/" : "");
      if (archivedDelete ? target.destination !== target.relativePath
        : action === "restore" ? !target.relativePath?.startsWith(archivePrefix) || target.destination !== target.relativePath.slice(archivePrefix.length)
        : target.destination !== archivePrefix + target.relativePath) fail("UNSAFE_DESTINATION");
      const result = await this.checked({ node, root: node.root, action: "inspect", archived: action === "restore",
        ...(action === "isolate" ? { isolate: true } : {}), target });
      if (identity && hash(identity) !== hash(result.rootIdentity)) fail("ROOT_IDENTITY_CHANGED");
      identity = result.rootIdentity;
      rows.push({ ...copy(target), ...result.target, destination: target.destination });
    }
    const row = { token: crypto.randomBytes(24).toString("hex"), operationId: "cleanup-" + crypto.randomBytes(16).toString("hex"), node: copy(node), rootIdentity: identity,
      action, observationMode, authorizationMode: pathOnly ? "confirmed_paths" : undefined, targets: rows, safety: { gitRepositoryAncestors: true, readOnlyReceiptCheck: true, formalJobOwner: true, immutableArchiveBatch: true, batchPreviewCapacity: 4096, managedObservation: 1, confirmedPathDeletion: 1, confirmedPathMetadata: 1, confirmedPathNestedRepositories: 1, isolateFast: action === "isolate" ? 1 : undefined, requiredInputGuard: action === "isolate" ? 1 : undefined, registeredIsolationDeletion: 1, subtreeSingleWriter: 1, serverWindowSelfClose: 1, chunkedFrozenManifest: 1, pinnedRuntimeProgram: 1, handleScan: pathOnly ? "confirmed_paths" : observationMode ? "managed_tmux" : "visible_same_user_processes" }, expiresAt: Date.now() + 30 * 60 * 1000, confirmations: 0, states: rows.map(row => row.missing ? "absent" : "pending") };
    row.tmuxSessionPrefix = tmuxSessionPrefix;
    row.targetDigests = rows.map(targetHash);
    row.digest = hash({ node: row.node, rootIdentity: identity, action, targets: rows, safety: row.safety, tmuxSessionPrefix });
    this.previews.set(row.token, copy(row)); // Preview does not write a journal or a remote hash cache.
    return copy(row);
  }
  /** v1.9 confirmed selection: entry identity binds, one batched read-only
   * metadata transfer per chunk, bounded parallel reads; mutation stays one
   * serial delete-fast call. Directories isolate by non-overwriting rename. */
  async previewFast(node, targets, tmuxSessionPrefix) {
    for (const target of targets) {
      if (!target || !["file", "directory"].includes(target.type)) fail("UNCERTAIN_TYPE");
      const rel = target.relativePath;
      if (typeof rel !== "string" || !rel || rel.length > 4096 || rel.startsWith("/")
        || /[\\\x00\r\n\x00-\x1f:*?[\]{}]/.test(rel) || rel.split("/").some(part => !part || part === "." || part === "..")) fail("INVALID_REQUEST");
      if (rel.split("/").includes(".git")) fail("PROTECTED_PATH");
      const archivedDelete = /^clean_dir\/job-[a-f0-9]{48}\//.test(rel);
      if (rel === "clean_dir" || rel.startsWith("clean_dir/") && !archivedDelete) fail("UNSAFE_DESTINATION");
      if (archivedDelete && target.destination !== rel) fail("UNSAFE_DESTINATION");
    }
    const operationId = "cleanup-" + crypto.randomBytes(16).toString("hex");
    const chunks = [];
    for (let i = 0; i < targets.length; i += 1000) chunks.push(targets.slice(i, i + 1000));
    const inspected = [];
    for (let i = 0; i < chunks.length; i += 2) { // bounded parallel: at most two reads in flight
      const part = await Promise.all(chunks.slice(i, i + 2).map(chunk => this.checked({ node, root: node.root,
        action: "batch-inspect", authorizationMode: "confirmed_paths", operationId,
        targets: chunk.map(target => ({ relativePath: target.relativePath, type: target.type })) })));
      inspected.push(...part);
    }
    const rows = []; let identity;
    for (const result of inspected) {
      if (identity && hash(identity) !== hash(result.rootIdentity)) fail("ROOT_IDENTITY_CHANGED");
      identity = result.rootIdentity;
      for (const entry of result.targets) {
        // The confirmation page must show the absolute isolation target before
        // execution: original -> isolation, both fully resolved.
        const leaf = entry.relativePath.slice(entry.relativePath.lastIndexOf("/") + 1);
        rows.push({ ...entry, ...(entry.archived ? { destination: entry.relativePath } : {}),
          ...(entry.isolationName ? { isolationAbsolutePath: entry.absolutePath.slice(0, entry.absolutePath.length - leaf.length) + entry.isolationName } : {}) });
      }
    }
    const row = { token: crypto.randomBytes(24).toString("hex"), operationId, node: copy(node), rootIdentity: identity,
      action: "delete", authorizationMode: "confirmed_paths", targets: rows,
      safety: { batchPreviewCapacity: 4096, confirmedPathDeletion: 1, entryIdentityBind: 1, batchedFastDelete: 1,
        directoryTreeIsolateDelete: 1, isolationRenameNoReplace: 1, registeredIsolationDeletion: 1, subtreeSingleWriter: 1,
        pinnedRuntimeProgram: 1, fastDeleteBatchLimit: 5000, contentHash: 0, descendantFingerprint: 0, handleScan: "entry_only" },
      metrics: { inspectRpcCalls: inspected.length,
        entryReads: inspected.reduce((sum, result) => sum + (result.metrics?.entryReads || 0), 0),
        mountReads: inspected.reduce((sum, result) => sum + (result.metrics?.mountReads || 0), 0),
        entryCheckMs: inspected.reduce((sum, result) => sum + (result.metrics?.entryCheckMs || 0), 0) },
      expiresAt: Date.now() + 30 * 60 * 1000, confirmations: 0, states: rows.map(entry => entry.missing ? "absent" : "pending") };
    row.tmuxSessionPrefix = tmuxSessionPrefix;
    row.targetDigests = rows.map(targetHash);
    row.digest = hash({ node: row.node, rootIdentity: identity, action: "delete", targets: rows, safety: row.safety, tmuxSessionPrefix });
    this.previews.set(row.token, copy(row)); // Preview performs no journal or remote write.
    return copy(row);
  }
  async inspect(params) {
    if (!params.node?.root || !["file", "directory"].includes(params.target?.type)) fail("INVALID_REQUEST");
    const result = await this.checked({ node: params.node, root: params.node.root, action: "inventory", target: params.target,
      manifestOnly: params.manifestOnly === true, presenceOnly: params.presenceOnly === true,
      allowMissing: params.allowMissing === true, observeExecutors: params.observeExecutors === true });
    if (params.observeExecutors === true && params.node.kind === "local") {
      result.executorsChecked = true; result.executors = [];
      for (const [key] of this.localExecutions) {
        const [token, index] = key.split(":"), row = this.previews.get(token), target = row?.targets[Number(index)];
        if (row && hash(row.rootIdentity) === hash(result.rootIdentity) && target?.relativePath === params.target.relativePath)
          result.executors.push({ kind: "active_local_transfer" });
      }
    }
    return result;
  }
  /** Read-only observation of a frozen receipt. Never settles audit state or starts a file operation. */
  /** Active batched presence query for a fast confirmed row; read-only. */
  async fastVerify(row, indexes) {
    const single = !Array.isArray(indexes);
    const list = single ? [indexes] : indexes;
    for (const i of list) if (!Number.isInteger(i) || !row.targets[i]) fail("INVALID_TARGET");
    const proofs = {};
    const live = list.filter(i => {
      if (row.targets[i].missing) proofs[i] = { ok: true, state: "absent", status: "absent", target: row.targets[i] };
      return !row.targets[i].missing;
    });
    if (live.length) {
      // Expansion is grouped per target: the deterministic entry-bound
      // isolation twin of a mode-A directory rides in the SAME group (bound to
      // the frozen original dev/inode), and groups are packed into read-only
      // batch-verify RPCs of at most FAST_VERIFY_BATCH_LIMIT EXPANDED entries
      // (engine FAST_BATCH_LIMIT parity). Public status/check/verify/settle
      // all share this entry point, so 2501+ directories no longer overflow a
      // single RPC; independent batches run at most two at a time and pairing
      // is resolved by relativePath+type, never by response position.
      const entries = [];
      const slots = []; // per live position: { orig, iso|null } slot indices into entries
      for (const i of live) {
        const target = row.targets[i];
        const orig = entries.length;
        entries.push({ relativePath: target.relativePath, type: target.type, device: target.device, inode: target.inode });
        let iso = null;
        if (target.type === "directory" && !target.archived && target.isolationName) {
          // Mode-A directories are isolate-then-delete: the disappearance of
          // the isolation tree - not the original path, which a fresh result
          // may legitimately reuse - marks completion.
          const parent = target.relativePath.slice(0, target.relativePath.lastIndexOf("/") + 1);
          iso = entries.length;
          entries.push({ relativePath: parent + target.isolationName, type: "directory", device: target.device, inode: target.inode });
        }
        slots.push({ orig, iso });
      }
      const chunks = [];
      const slotChunk = new Array(slots.length);
      let chunk = { start: 0, end: 0 };
      slots.forEach((slot, position) => {
        const size = slot.iso === null ? 1 : 2;
        if (chunk.end > chunk.start && chunk.end - chunk.start + size > FAST_VERIFY_BATCH_LIMIT) { chunks.push(chunk); chunk = { start: chunk.end, end: chunk.end }; }
        slotChunk[position] = chunks.length; // this slot lands in the chunk being filled
        chunk.end += size;
      });
      if (chunk.end > chunk.start) { chunks.push(chunk); slotChunk[slotChunk.length - 1] = chunks.length - 1; }
      const responses = new Array(chunks.length);
      const failures = new Array(chunks.length);
      for (let s = 0; s < chunks.length; s += 2) { // read-only batches: at most two in flight
        const settled = await Promise.allSettled(chunks.slice(s, s + 2).map(part => this.checked({
          node: row.node, root: row.node.root, rootIdentity: row.rootIdentity,
          action: "batch-verify", authorizationMode: "confirmed_paths", entries: entries.slice(part.start, part.end) })));
        settled.forEach((outcome, k) => {
          if (outcome.status === "fulfilled") responses[s + k] = outcome.value;
          else failures[s + k] = outcome.reason;
        });
      }
      const rowsByKey = new Map();
      responses.forEach((result, ci) => {
        if (result) for (const answered of result.targets || [])
          rowsByKey.set(ci + "\u0000" + answered.relativePath + "\u0000" + answered.type, answered);
      });
      let batchFailure;
      live.forEach((i, position) => {
        const target = row.targets[i];
        const { orig, iso } = slots[position];
        const ci = slotChunk[position]; // original and isolation twin share the chunk
        if (failures[ci]) {
          // A failed batch answers for NOTHING it carried: those entries are
          // safely unknown (never "gone"), while other batches' resolved
          // evidence stands untouched and batchExecuting is left alone.
          batchFailure ||= failures[ci];
          proofs[i] = { ok: false, state: "unknown", queryError: failures[ci].code || failures[ci].message, target };
          return;
        }
        const entry = rowsByKey.get(ci + "\u0000" + entries[orig].relativePath + "\u0000" + entries[orig].type) || { status: "missing" };
        const archived = Boolean(target.archived);
        let state;
        const proofExtra = {};
        if (iso !== null) {
          const isoRow = rowsByKey.get(ci + "\u0000" + entries[iso].relativePath + "\u0000" + "directory") || { status: "missing" };
          proofExtra.isolationStatus = isoRow.status;
          // While the entry-bound isolation tree still stands (or went
          // unanswered) the deletion is unfinished regardless of the original
          // path; a same-name recreation there is new data, never counted.
          if (isoRow.status === "missing") state = "unknown";
          else state = isoRow.status === "present" ? "unknown"
            : entry.status === "gone" || entry.status === "replaced" ? "completed"
              : entry.status === "missing" ? "unknown"
                : row.batchExecuting || row.states[i] === "executing" || row.states[i] === "completed" ? "unknown" : "pending";
        } else {
          state = entry.status === "gone" ? "completed"
            : entry.status === "replaced" ? (archived ? "unknown" : "completed")
              : entry.status === "missing" ? "unknown" : "pending";
        }
        proofs[i] = { ok: true, state, status: entry.status, target: entry, ...proofExtra };
      });
      if (single && batchFailure) throw batchFailure; // single-index callers keep their own error handling
    }
    return single ? proofs[list[0]] : proofs;
  }
  /** v1.10 exception recovery: one public check call is one observation round.
   *
   * Answers contract questions per caller key with CURRENT facts only: the
   * engine re-reads the filesystem and shares ONE managed-window sweep per
   * batch; frozen receipts are never replayed as this round's evidence. A
   * backend token additionally cross-checks the frozen target, node and root
   * (a token never travels across nodes or roots) and contributes its entry
   * identity plus the explicit isolation mapping - the isolation name is
   * never guessed. Unanswered, duplicated, contradicted or failed keys stay
   * unknown; nothing observed here authorizes a confirm/execute/settle step.
   */
  async observeBatch(params) {
    const node = params.node, observationId = params.observationId, targets = params.targets;
    if (!node?.root || typeof observationId !== "string" || !observationId
        || !Array.isArray(targets) || !targets.length || targets.length > 5000) fail("INVALID_REQUEST");
    if (params.readConcurrency !== 1 && params.readConcurrency !== 2) fail("INVALID_REQUEST");
    const observedPath = value => typeof value === "string" && value && value.length <= 4096 && !value.startsWith("/")
      && !/[\\\x00\r\n\x00-\x1f:*?[\]{}]/.test(value) && !value.split("/").some(part => !part || part === "." || part === "..");
    const seen = new Set(), planned = [], plannedByKey = new Map(), early = new Map();
    // One frozen backend row is READ at most once per observeBatch call; every
    // target pinned to the same token shares that immutable snapshot (rows
    // are never mutated here), and a token that failed to read is remembered
    // as failed for the rest of the round instead of being retried per target.
    // The next public call reads again: no cross-round cache, read()'s own
    // semantics for other callers stay exactly as they were.
    const rowSnapshots = new Map(), ROW_READ_FAILED = Symbol("row-read-failed");
    for (const target of targets) {
      const key = target?.key, rel = target?.relativePath, type = target?.type;
      if (typeof key !== "string" || !key || seen.has(key) || !["file", "directory"].includes(type)) fail("INVALID_REQUEST");
      if (!observedPath(rel)) fail("INVALID_REQUEST");
      if (rel.split("/").includes(".git")) fail("PROTECTED_PATH");
      if (rel.startsWith("clean_dir/") && !/^clean_dir\/job-[a-f0-9]{48}\//.test(rel)) fail("UNSAFE_DESTINATION");
      seen.add(key);
      let device = target.device, inode = target.inode, row, archived = false;
      let isolationRelativePath = target.isolationRelativePath, rootIdentity = params.rootIdentity;
      if (target.backendToken !== undefined || target.backendIndex !== undefined) {
        if (typeof target.backendToken !== "string" || !Number.isInteger(target.backendIndex) || target.backendIndex < 0
            || isolationRelativePath !== undefined && typeof isolationRelativePath !== "string") fail("INVALID_REQUEST");
        const unknown = code => { early.set(key, { key, relativePath: rel, type, state: "unknown", executors: [], executorsChecked: false,
          ...(isolationRelativePath !== undefined ? { isolationChecked: false } : {}), error: { code, message: code } }); };
        const snapshot = rowSnapshots.get(target.backendToken);
        if (snapshot === ROW_READ_FAILED) { unknown("TOKEN_UNAVAILABLE"); continue; }
        if (snapshot !== undefined) row = snapshot;
        else try { row = await this.read(target.backendToken); rowSnapshots.set(target.backendToken, row); }
        catch { rowSnapshots.set(target.backendToken, ROW_READ_FAILED); unknown("TOKEN_UNAVAILABLE"); continue; }
        // Cross-node or cross-root token reuse is refused per target, never
        // answered with the wrong root's facts.
        if (!sameNode(row.node, node) || rootIdentity !== undefined && hash(row.rootIdentity) !== hash(rootIdentity)) { unknown("TOKEN_NODE_MISMATCH"); continue; }
        const frozen = row.targets[target.backendIndex];
        if (!frozen || frozen.relativePath !== rel || frozen.type !== type) { unknown("TOKEN_TARGET_MISMATCH"); continue; }
        device = frozen.device; inode = frozen.inode; rootIdentity = row.rootIdentity; archived = Boolean(frozen.archived);
        // Only the frozen mapping counts as an explicit isolation path; the
        // observer never guesses one, and a caller claim the row contradicts
        // is refused instead of probed.
        const frozenIso = frozen.type === "directory" && !frozen.archived && frozen.isolationName
          ? rel.slice(0, rel.lastIndexOf("/") + 1) + frozen.isolationName : undefined;
        if (isolationRelativePath !== undefined && isolationRelativePath !== frozenIso) { unknown("TOKEN_TARGET_MISMATCH"); continue; }
        isolationRelativePath = frozenIso;
      }
      if (isolationRelativePath !== undefined && !observedPath(isolationRelativePath)) fail("INVALID_REQUEST");
      const item = { key, relativePath: rel, type, device, inode, isolationRelativePath, rootIdentity, row, archived,
        index: row ? target.backendIndex : undefined };
      planned.push(item); plannedByKey.set(key, item);
    }
    // Original and its explicit isolation probe travel together; batches are
    // capped in EXPANDED entries (engine FAST_BATCH_LIMIT parity) and issued
    // inside the caller's read budget, instance-capped at two in flight.
    const groups = new Map();
    for (const item of planned) {
      const id = item.rootIdentity === undefined ? "absent" : hash(item.rootIdentity);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(item);
    }
    const batches = [];
    for (const items of groups.values()) {
      let part = { items: [], size: 0 };
      for (const item of items) {
        const size = item.isolationRelativePath === undefined ? 1 : 2;
        if (part.size && part.size + size > FAST_VERIFY_BATCH_LIMIT) { batches.push(part); part = { items: [], size: 0 }; }
        part.items.push(item); part.size += size;
      }
      if (part.size) batches.push(part);
    }
    const batchIndex = new Map();
    batches.forEach((part, index) => part.items.forEach(item => batchIndex.set(item.key, index)));
    const responses = new Array(batches.length), failures = new Array(batches.length);
    for (let s = 0; s < batches.length; s += params.readConcurrency) {
      const settled = await Promise.allSettled(batches.slice(s, s + params.readConcurrency).map(part => {
        const entries = part.items.map(item => ({ key: item.key, relativePath: item.relativePath, type: item.type,
          ...(item.device === undefined ? {} : { device: item.device }),
          ...(item.inode === undefined ? {} : { inode: item.inode }),
          ...(item.isolationRelativePath === undefined ? {} : { isolationRelativePath: item.isolationRelativePath }) }));
        const rootIdentity = part.items[0].rootIdentity;
        return this.observeSlot(() => this.checked({ node, root: node.root,
          ...(rootIdentity === undefined ? {} : { rootIdentity }), action: "batch-observe", observationId, entries }));
      }));
      settled.forEach((outcome, k) => {
        if (outcome.status === "fulfilled") responses[s + k] = outcome.value;
        else failures[s + k] = outcome.reason;
      });
    }
    const answers = new Map(), duplicate = new Set();
    let roundIdentity;
    responses.forEach((result, index) => {
      if (!result) return;
      const mismatch = code => { responses[index] = null; failures[index] = Object.assign(Error(code), { code }); };
      // A response not bound to THIS round and root is untrusted wholesale.
      if (result.observationId !== observationId) return mismatch("ANSWER_MISMATCH");
      if (roundIdentity === undefined) roundIdentity = result.rootIdentity;
      else if (hash(roundIdentity) !== hash(result.rootIdentity)) return mismatch("ROOT_IDENTITY_CHANGED");
      for (const answered of Array.isArray(result.observations) ? result.observations : []) {
        if (answers.has(answered.key)) { answers.delete(answered.key); duplicate.add(answered.key); }
        else answers.set(answered.key, answered);
      }
    });
    const deriveState = (item, answered, observation) => {
      if (answered.error) return "unknown";
      const status = observation.status, iso = observation.isolationStatus;
      if (iso !== undefined) {
        // Same rule as the fast-chain verify: while the entry-bound isolation
        // tree stands (or went unanswered) the deletion is unfinished; a
        // same-name recreation there is new data, never counted as residue.
        if (observation.isolationChecked !== true || iso === "unknown" || iso === "present") return "unknown";
        if (status === "gone" || status === "replaced") return "completed";
        if (status !== "present") return "unknown";
        return item.row.batchExecuting || item.row.states[item.index] === "executing" || item.row.states[item.index] === "completed" ? "unknown" : "pending";
      }
      if (status === "gone") return "completed";
      if (status === "replaced") return item.archived ? "unknown" : "completed";
      if (status !== "present") return "unknown";
      if (observation.executorsChecked && observation.executors.length) return "executing";
      return item.row.batchExecuting || item.row.states[item.index] === "executing" ? "unknown" : "pending";
    };
    const observations = [];
    for (const target of targets) {
      const key = target.key;
      if (early.has(key)) { observations.push(early.get(key)); continue; }
      const item = plannedByKey.get(key), base = { key, relativePath: item.relativePath, type: item.type };
      const unknownWith = (code, message) => ({ ...base, executors: [], executorsChecked: false,
        ...(item.isolationRelativePath === undefined ? {} : { isolationChecked: false }), error: { code, message: message || code } });
      const index = batchIndex.get(item.key);
      // A failed batch answers for NOTHING it carried: its keys are unknown,
      // never "gone", while other batches' fresh facts stand untouched.
      if (failures[index]) { observations.push(unknownWith(failures[index].code || "OBSERVATION_UNAVAILABLE", failures[index].message)); continue; }
      if (duplicate.has(key)) { observations.push(unknownWith("DUPLICATE_ANSWER")); continue; }
      const answered = answers.get(key);
      if (!answered) { observations.push(unknownWith("ANSWER_MISSING")); continue; }
      const observation = { ...base, status: answered.status, target: answered.target,
        executors: Array.isArray(answered.executors) ? answered.executors : [], executorsChecked: answered.executorsChecked === true,
        ...(answered.isolationStatus !== undefined ? { isolationStatus: answered.isolationStatus, isolationChecked: answered.isolationChecked === true }
          : item.isolationRelativePath !== undefined ? { isolationStatus: "unknown", isolationChecked: false } : {}) };
      if (answered.error) observation.error = answered.error;
      if (item.row) observation.state = deriveState(item, answered, observation);
      observations.push(observation);
    }
    return { ok: true, observationId, capabilities: { batchCleanupObservation: 1, maxTargets: 5000 },
      ...(roundIdentity === undefined ? {} : { rootIdentity: roundIdentity }), observations };
  }
  async check(params) {
    const row = await this.read(params.token), index = params.index;
    if (!Number.isInteger(index) || !row.targets[index]) fail("INVALID_TARGET");
    if (isFastDeleteRow(row)) return this.fastVerify(row, index);
    if (row.observationMode) return this.observe(row, index);
    return this.checked({ node: row.node, root: row.node.root, rootIdentity: row.rootIdentity, target: row.targets[index],
      action: "check", deleted: row.action === "delete", receiptCompleted: row.states[index] === "completed" });
  }
  async confirm(params) {
    const row = await this.read(params.token);
    if (Date.now() > row.expiresAt) fail("PREVIEW_EXPIRED");
    if (params.confirm !== true || params.digest !== row.digest || hash(params.exactTargets) !== hash(row.targets.filter(t => !t.missing).map(t => t.absolutePath))) fail("CONFIRM_REQUIRED");
    if (params.phase !== row.confirmations + 1 || params.phase > (row.action === "delete" ? 2 : 1)) fail("CONFIRM_REQUIRED");
    row.confirmations = params.phase; await this.save(row);
    return { ok: true, token: row.token, digest: row.digest, confirmations: row.confirmations };
  }
  async execute(params) {
    const row = await this.read(params.token);
    if (params.digest !== row.digest || row.confirmations !== (row.action === "delete" ? 2 : 1)) fail("CONFIRM_REQUIRED");
    const index = params.index;
    if (!Number.isInteger(index) || !row.targets[index]) fail("INVALID_TARGET");
    if (row.states[index] === "absent") fail("NOT_AN_EXECUTABLE_TARGET");
    if (row.authorizationMode === "confirmed_paths" && row.action === "delete") {
      // One serial delete-fast RPC executes the whole confirmed batch; the
      // engine re-checks every entry identity before touching anything.
      if (this.busy.has(row.token)) fail("OPERATION_BUSY");
      this.busy.add(row.token);
      try {
        return await this.lease(row.node, row.targets, async () => {
          const pending = row.targets.map((target, i) => ({ target, i })).filter(({ target, i }) => !target.missing && row.states[i] !== "completed");
          if (!pending.length) return { ok: true, alreadyCompleted: true, receipt: row.batchReceipt };
          if (row.batchExecuting) fail("DELETE_RECEIPT_UNCERTAIN");
          const entries = pending.map(({ target }) => ({ relativePath: target.relativePath, type: target.type, device: target.device, inode: target.inode,
            ...(target.type === "directory" && !target.archived && target.isolationName ? { isolationName: target.isolationName } : {}) }));
          row.batchExecuting = true;
          for (const { i } of pending) row.states[i] = "executing";
          await this.save(row);
          let result;
          try {
            result = await this.checked({ node: row.node, root: row.node.root, rootIdentity: row.rootIdentity, action: "delete-fast",
              authorizationMode: "confirmed_paths", operationId: row.operationId, entries });
          } catch (error) {
            // Only the engine's explicit zero-mutation fact makes a refusal
            // retryable. An error code alone proves nothing: TYPE_CHANGED or
            // ENTRY_IDENTITY_CHANGED can also raise mid-walk or during the
            // file-group recheck AFTER earlier unlinks (partial mutation), and
            // a lost/uncertain receipt must be resolved by active verify, not
            // by a blind second mutation RPC.
            if (error.mutationStarted === false && FAST_ZERO_MUTATION_CODES.has(error.code)) { row.batchExecuting = false; for (const { i } of pending) row.states[i] = "pending"; await this.save(row); }
            throw error;
          }
          for (const { i } of pending) row.states[i] = "completed";
          row.batchExecuting = false;
          row.batchReceipt = result.receipt;
          row.metrics = { ...(row.metrics || {}), executeRpcCalls: (row.metrics?.executeRpcCalls || 0) + 1,
            deleteMetrics: result.receipt?.metrics || null };
          await this.save(row);
          return result;
        });
      } finally { this.busy.delete(row.token); }
    }
    if (row.observationMode) {
      const key = row.token + ":" + index;
      if (row.observationMode === "filesystem" && this.localExecutions.has(key)) return { ok: true, state: "executing" };
      const proof = await this.observe(row, index);
      if (["completed", "executing"].includes(proof.state)) return proof;
      if (proof.state !== "pending") fail("CLEANUP_TARGET_CHANGED");
      if (row.authorizationMode !== "confirmed_paths") await this.activity(row.node);
      const request = { node: row.node, root: row.node.root, rootIdentity: row.rootIdentity,
        action: row.observationMode === "tmux" ? "managed-start" : row.action,
        cleanupAction: row.action, operationId: row.operationId, target: row.targets[index],
        tmuxSessionPrefix: row.tmuxSessionPrefix || params.tmuxSessionPrefix || "simple" };
      // A lost response cannot leave a local busy flag that blocks later observations.
      row.states[index] = "executing"; await this.save(row);
      if (row.observationMode === "filesystem") {
        if (this.localExecutions.has(key)) return { ok: true, state: "executing" };
        const execution = this.checked(request); this.localExecutions.set(key, execution);
        try { return await execution; } finally { if (this.localExecutions.get(key) === execution) this.localExecutions.delete(key); }
      }
      try { return await this.checked(request); }
      catch (error) {
        // A live OS mutation lock refused admission before any window was
        // created. The client may retry this same confirmed request, while
        // lifecycle checks continue reading actual tmux/filesystem evidence.
        if (row.observationMode === "tmux" && error.code === "OPERATION_BUSY") {
          row.states[index] = "pending"; await this.save(row);
          return { ok: true, state: "waiting", reason: "CLEANUP_MUTATION_BUSY", notStarted: true };
        }
        throw error;
      }
    }
    if (this.busy.has(row.token)) fail("OPERATION_BUSY");
    this.busy.add(row.token);
    try {
      return await this.lease(row.node, row.targets, async () => {
        await this.activity(row.node);
        if (row.states[index] === "completed") return { ok: true, alreadyCompleted: true, receipt: row.receipts[index] };
        const request = { node: row.node, root: row.node.root, rootIdentity: row.rootIdentity, action: row.action,
          operationId: row.operationId, target: row.targets[index] };
        if (row.states[index] === "executing") {
          if (row.action === "delete") fail("DELETE_RECEIPT_UNCERTAIN");
          try {
            const settled = await this.checked({ ...request, action: "settle", settledAction: row.action });
            row.states[index] = "completed"; (row.receipts ||= {})[index] = settled.receipt; await this.save(row);
            return { ok: true, receipt: settled.receipt, settled: true };
          } catch (error) {
            if (error.code !== "SOURCE_RECREATED_OR_NOT_MOVED") throw error;
            // The remote lock must have settled; an unchanged source with absent destination can retry.
            const unchanged = await this.checked({ ...request, action: "inspect", archived: row.action === "restore",
              ...(row.action === "isolate" ? { isolate: true } : {}) });
            if (unchanged.target.fingerprint !== request.target.fingerprint || hash(unchanged.rootIdentity) !== hash(row.rootIdentity)) fail("SOURCE_RECREATED_OR_CHANGED");
            row.states[index] = "pending"; await this.save(row);
          }
        }
        // Preflight the complete node batch again before the first mutation.
        for (let i = 0; i < row.targets.length; i++) {
          if (row.states[i] === "completed") continue;
          const result = await this.checked({ ...request, action: "inspect", archived: row.action === "restore",
            ...(row.action === "isolate" ? { isolate: true } : {}), target: row.targets[i] });
          if (hash(result.rootIdentity) !== hash(row.rootIdentity) || Boolean(result.target.missing) !== Boolean(row.targets[i].missing)
            || result.target.fingerprint !== row.targets[i].fingerprint) fail("PREVIEW_CHANGED");
        }
        row.states[index] = "executing"; await this.save(row);
        const result = await this.checked(request);
        row.states[index] = "completed"; (row.receipts ||= {})[index] = result.receipt; await this.save(row);
        return result;
      });
    } finally { this.busy.delete(row.token); }
  }
  async observe(row, index) {
    if (row.observationMode === "filesystem" && this.localExecutions.has(row.token + ":" + index))
      return { ok: true, state: "executing", executor: { kind: "active_local_transfer" } };
    const frozen = row.targets[index];
    const compact = row.observationMode === "tmux" && ["executing", "completed"].includes(row.states[index]);
    const target = compact ? Object.fromEntries(["relativePath", "destination", "type", "fingerprint", "contentFingerprint", "inode", "fingerprintMode", "authorizationMode", "chunked", "count"]
      .filter(key => frozen[key] !== undefined).map(key => [key, frozen[key]])) : frozen;
    return this.checked({ node: row.node, root: row.node.root, rootIdentity: row.rootIdentity,
      action: "managed-observe", cleanupAction: row.action, localObservation: row.observationMode === "filesystem",
      operationId: row.operationId, target,
      ...(compact ? { frozenTargetDigest: row.targetDigests?.[index] || targetHash(frozen) } : {}) });
  }
  async status(params) {
    const row = await this.read(params.token);
    if (isFastDeleteRow(row)) {
      // Batched active queries refresh the whole selection in bounded
      // read-only RPCs (fastVerify chunks by expanded entries), never per file.
      const indexes = row.targets.map((_, i) => i).filter(i => !row.targets[i].missing && row.states[i] !== "absent");
      delete row.statusQueryError; // a stale round's error must not outlive a fresh successful round
      try {
        const proofs = await this.fastVerify(row, indexes);
        row.observations = row.observations || [];
        let queryError;
        for (const i of indexes) {
          const proof = proofs[i];
          if (proof.ok === false) queryError ||= proof.queryError;
          // Absence of evidence never erases accounted truth: an ordinary
          // batch failure, a dropped original row, or a short answer that
          // dropped ONLY the isolation twin row keeps the entry completed and
          // its earlier observation intact. Received counter-evidence always
          // outranks unrelated missing rows: a twin row that answers present
          // demotes even when the original row went unanswered in the same
          // round, and an explicit ROOT_IDENTITY_CHANGED refusal (the engine
          // rejecting the frozen root identity, distinguishable by code from
          // transport noise, which never carries engine error codes) demotes
          // too - completion is never masked against fresh contradiction.
          const identityCountered = proof.ok === false && proof.queryError === "ROOT_IDENTITY_CHANGED";
          if (row.states[i] === "completed" && !identityCountered && proof.isolationStatus !== "present" &&
              (proof.ok === false || proof.status === "missing" || proof.isolationStatus === "missing")) continue;
          row.observations[i] = proof;
          row.states[i] = proof.state === "completed" ? "completed" : proof.state === "pending" && row.states[i] === "pending" ? "pending" : "unknown";
        }
        if (queryError) row.statusQueryError = queryError;
        // An active query that accounts for every entry resolves a lost receipt;
        // the resolved truth is persisted so a later rerun sees alreadyCompleted.
        if (row.batchExecuting && row.targets.every((target, i) => target.missing || row.states[i] === "completed")) row.batchExecuting = false;
        await this.save(row);
      } catch (error) { row.statusQueryError = error.code || error.message; }
      return row;
    }
    if (row.observationMode) {
      row.observations = [];
      for (let index = 0; index < row.targets.length; index++) {
        try {
          const proof = await this.observe(row, index);
          row.observations.push(proof); row.states[index] = proof.state;
        } catch(error) { row.observations.push({ state: "unknown", queryError: error.message }); row.states[index] = "unknown"; }
      }
    }
    return row;
  }
  /** Settle an already-authorized receipt before coordinator preflight. Never starts a new move. */
  async settle(params) {
    const row = await this.read(params.token), index = params.index, target = row.targets[index];
    if (params.digest !== row.digest || !Number.isInteger(index) || !target || row.confirmations !== (row.action === "delete" ? 2 : 1)) fail("CONFIRM_REQUIRED");
    if (isFastDeleteRow(row)) return this.fastVerify(row, index);
    if (row.observationMode) return this.observe(row, index);
    if (row.action === "delete") fail("DELETE_RECEIPT_UNCERTAIN");
    if (this.busy.has(row.token)) fail("OPERATION_BUSY");
    this.busy.add(row.token);
    try {
      return await this.lease(row.node, row.targets, async () => {
        await this.activity(row.node);
        if (row.states[index] === "completed") { await this.verify(params); return { ok: true, state: "completed", receipt: row.receipts[index] }; }
        if (!["pending", "executing"].includes(row.states[index])) fail("RECEIPT_UNVERIFIED");
        const request = { node: row.node, root: row.node.root, rootIdentity: row.rootIdentity, operationId: row.operationId, target };
        if (row.states[index] === "executing") {
          try {
            const settled = await this.checked({ ...request, action: "settle", settledAction: row.action });
            row.states[index] = "completed"; (row.receipts ||= {})[index] = settled.receipt; await this.save(row);
            return { ok: true, state: "completed", receipt: settled.receipt };
          } catch (error) { if (error.code !== "SOURCE_RECREATED_OR_NOT_MOVED") throw error; }
        }
        const unchanged = await this.checked({ ...request, action: "inspect", archived: row.action === "restore",
          ...(row.action === "isolate" ? { isolate: true } : {}) });
        if (unchanged.target.fingerprint !== target.fingerprint || hash(unchanged.rootIdentity) !== hash(row.rootIdentity)) fail("SOURCE_RECREATED_OR_CHANGED");
        row.states[index] = "pending"; await this.save(row); return { ok: true, state: "pending" };
      });
    } finally { this.busy.delete(row.token); }
  }
  async verify(params) {
    const row = await this.read(params.token), target = row.targets[params.index];
    if (isFastDeleteRow(row) && target) {
      const proof = await this.fastVerify(row, params.index);
      if (proof.state !== "completed") fail("CLEANUP_NOT_VERIFIED");
      return proof;
    }
    if (row.observationMode && target) {
      const proof = await this.observe(row, params.index);
      if (proof.state !== "completed") fail("CLEANUP_NOT_VERIFIED");
      return proof;
    }
    if (!target || row.states[params.index] !== "completed") fail("RECEIPT_UNVERIFIED");
    return this.checked({ node: row.node, root: row.node.root, rootIdentity: row.rootIdentity, target, action: "verify", deleted: row.action === "delete" });
  }
}
module.exports = { CleanupFileApi, fail, hash, transferBusySnapshot, busyEvidence, TERMINAL_TRANSFER_STATUSES, runtimePrepareRequest, runtimeProgramRelativePath, RUNTIME_PREPARE_BOOTSTRAP, remoteRuntimePrepareCommand, remoteRuntimeCommand, REMOTE_COMMAND_BUDGET };
