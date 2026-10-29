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
// 0.2.111 isolation completion receipt: every field below is a fact the engine
// observed AT MOVE TIME on the target node (rename committed, source name
// absent during the move, node-local managed-window sweep found no overlapping
// executor, registration landed). None of them is ever re-derived at deletion
// time; an incomplete or missing proof keeps the older two-confirmation review
// chain and never unlocks the background delete entry.
const isolateCompletionProof = (value, target) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.isolationCompletionProtocol !== 1 || value.renameCommitted !== true || value.sourceMissingAtMove !== true
      || value.registered !== true || value.executorsChecked !== true
      || !Array.isArray(value.executors) || value.executors.length !== 0) return null;
  if (value.sourceRelativePath !== target.relativePath || value.destinationRelativePath !== target.destination) return null;
  if (value.archiveBatch !== undefined && value.archiveBatch !== target.archiveBatch) return null;
  return value;
};
// Ledger-side proof sources for one isolate row target: the direct isolate
// receipt, or a managed-observe completion echo (nested or stored whole).
const ledgerCompletion = (row, index) => {
  const target = row.targets[index];
  const candidates = [];
  const receipt = row.receipts ? row.receipts[index] : undefined;
  if (receipt && typeof receipt === "object") candidates.push(receipt, receipt.completion);
  const observed = Array.isArray(row.observations) ? row.observations[index] : undefined;
  if (observed && typeof observed === "object") candidates.push(observed.completion);
  for (const value of candidates) { const proof = isolateCompletionProof(value, target); if (proof) return copy(proof); }
  return null;
};
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
// 隔离区维护删除的生产事实：只能由服务端路由在创建控制器时登记（maintenanceCleanup 严格 true
// 且 remoteMutation 严格 true —— 它仍是远端修改，只是范围被引擎限定在已登记隔离副本）。
// 方法名、客户端参数、非布尔标记都换不到豁免；同时声明只读观测身份的自相矛盾行也无效；
// 缺事实的行一律继续按写入计忙（fail closed）。
const maintenanceCleanupRow = row => Boolean(row) && row.maintenanceCleanup === true && row.remoteMutation === true && row.readObserver !== true;
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
      ...(row && row.operation ? { operation: busyText(row.operation) } : {}), ...(row && row.phase ? { phase: busyText(row.phase) } : {}),
      // 维护标记只在生产事实成立时随证据行携带；缺标记的行形状与 0.2.110 完全一致。
      ...(maintenanceCleanupRow(row) ? { maintenanceCleanup: true } : {}) }));
  // 隔离区维护删除不长期占用"传输忙"：它经引擎只动已登记隔离副本，与新的派发/上传互不等待；
  // 真实上传、下载、移动、隔离移动继续按写入计忙，本投影对非维护行的判定与 0.2.102/0.2.110 逐值一致。
  const blockingTransferCount = nonTerminalRows.filter(row => row.readOnlyObserver !== true && row.selfAttempt !== true && row.maintenanceCleanup !== true).length;
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
    maintenanceTransferCount: nonTerminalRows.filter(row => row.maintenanceCleanup === true).length,
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
    base.readOnlyObserver = value.readOnlyObserver === true; base.selfAttempt = value.selfAttempt === true;
    // 维护标记同样只认真布尔，且只在成立时出现（缺标记的行形状保持不变）。
    if (value.maintenanceCleanup === true) base.maintenanceCleanup = true;
    return base; };
  const transferRows = Array.isArray(snapshot.activeTransfers) ? snapshot.activeTransfers.map(transferRow).filter(Boolean).slice(0, MAX_BUSY_ROWS) : [];
  const evidence = {
    schemaVersion: 1, observedAt: busyText(snapshot.observedAt, 40), instanceId: busyText(snapshot.instanceId, 60),
    busy: snapshot.busy === true,
    activeTransferCount: counts("activeTransferCount") ?? transferRows.length,
    blockingTransferCount: counts("blockingTransferCount") ?? transferRows.filter(item => item.readOnlyObserver !== true).length,
    observerTransferCount: counts("observerTransferCount") ?? transferRows.filter(item => item.readOnlyObserver === true).length,
    maintenanceTransferCount: counts("maintenanceTransferCount") ?? transferRows.filter(item => item.maintenanceCleanup === true).length,
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

// r17-D consumerRoot: a cleanup token is an authorized-mutation batch and its ledger now lives
// INSIDE the consuming local project (the project that issued the cleanup), never in a shared
// global folder. row.node.root is the REMOTE target root and is never the local consumer. Every
// token read/write must carry the local absolute consumer root; memory previews, project files
// and legacy imports are all bound to it. The digest field set stays exactly as before —
// consumerRoot is ownership metadata, never a business field.
function requireConsumerRoot(value) {
  const root = String(value || "");
  if (!root || !path.isAbsolute(root) || /[\x00\r\n]/.test(root)) fail("CONSUMER_ROOT_INVALID");
  return root;
}
// Same managed-segment semantics as the companion plugin: every simple_cluster segment is a
// REAL directory created level by level (a linked managed tree would write THIS project's
// authorization ledger into another project), POSIX write-bit rule only — Windows st_mode
// carries no NTFS ACL semantics.
async function ensureManagedSegment(dir) {
  try { await fs.mkdir(dir, { mode: 0o700 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  const stat = await fs.lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("MANAGED_DIR_UNSAFE", "项目受管目录不得为链接或非目录：" + dir);
  if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) fail("MANAGED_DIR_UNSAFE", "项目受管目录允许组/其他用户写入：" + dir);
}
async function ensureConsumerCleanupDir(consumerRoot) {
  let current = path.join(consumerRoot, "simple_cluster");
  await ensureManagedSegment(current);
  for (const part of ["state", "simple-sftp", "cleanup-operations"]) {
    current = path.join(current, part);
    await ensureManagedSegment(current);
  }
  return current;
}

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
  /** ONE instance per window stays the design: observe slots, busy set and leases are global
   * read/mutation guards and must not be split into per-project instances. storageRoot is the
   * LEGACY global folder, kept ONLY as the read-only byte source for exact digest-verified
   * imports; every new record lives under the consuming project's managed tree. */
  constructor({ storageRoot, transport, activity, lease }) {
    this.storageRoot = storageRoot; this.transport = transport; this.activity = activity; this.lease = lease;
    this.previews = new Map(); this.busy = new Set(); this.localExecutions = new Map();
    this.observeInFlight = 0; this.observeWaiters = []; this.ledgerChains = new Map();
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
  /** Read a token's row bound to ONE verified local consumer root. An in-memory preview must
   * belong to the same project; the project location is the only writable source. A missing
   * project record may be restored from the untouched legacy global folder ONLY with the
   * caller's exact frozen digest reference (backendDigest byte-match), never by scanning or
   * guessing; a corrupt project record never falls back to legacy. */
  async read(token, consumerRoot, expectedDigest) {
    if (!/^[a-f0-9]{48}$/.test(String(token))) fail("INVALID_TOKEN");
    const root = requireConsumerRoot(consumerRoot);
    const memory = this.previews.get(token);
    if (memory) {
      if (memory.consumerRoot !== undefined && memory.consumerRoot !== root) fail("CONSUMER_ROOT_MISMATCH");
      return copy(memory);
    }
    const target = path.join(await ensureConsumerCleanupDir(root), token + ".json");
    let text;
    try { text = await fs.readFile(target, "utf8"); }
    catch (error) {
      if (error?.code !== "ENOENT") fail("PREVIEW_EXPIRED");
      // No project record yet. The legacy global folder is mixed and read-only: import happens
      // only for a token this project can prove with its frozen backend digest. No reference,
      // no import — the caller surfaces this stop code instead of the api guessing an owner.
      if (typeof expectedDigest !== "string") fail("LEGACY_IMPORT_UNBOUND");
      let legacyText;
      try { legacyText = await fs.readFile(path.join(this.storageRoot, token + ".json"), "utf8"); }
      catch { fail("PREVIEW_EXPIRED"); }
      let legacyRow;
      try { legacyRow = JSON.parse(legacyText); } catch { fail("TOKEN_DIGEST_MISMATCH"); }
      if (legacyRow?.token !== token || legacyRow?.digest !== expectedDigest) fail("TOKEN_DIGEST_MISMATCH");
      // Exact evidence established: publish the legacy BYTES at the project location. A record
      // that raced ahead at the target keeps its NEW value (link EEXIST), it is never clobbered.
      const temp = path.join(path.dirname(target), `.migrating-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`);
      let created = false;
      try {
        await fs.writeFile(temp, legacyText, { flag: "wx" }); // exclusive: never reuse any surviving temp
        created = true;
        try { await fs.link(temp, target); }
        catch (linkError) { if (linkError?.code !== "EEXIST") throw linkError; }
      } finally {
        if (created) await fs.rm(temp, { force: true }); // release only a temp THIS call created
      }
      try { text = await fs.readFile(target, "utf8"); }
      catch { fail("PREVIEW_EXPIRED"); } // raced release: re-preview re-establishes the ledger
    }
    let row;
    try { row = JSON.parse(text); } catch { fail("PREVIEW_CORRUPT"); } // corrupt project record: NO legacy fallback
    if (!row || row.token !== token) fail("PREVIEW_CORRUPT");
    if (row.consumerRoot !== undefined && row.consumerRoot !== root) fail("CONSUMER_ROOT_MISMATCH");
    row.consumerRoot = root;
    return copy(row);
  }
  /** Ownership is mandatory: a record without a verified consumer root is never written, and
   * the shared legacy folder is never a write target again. */
  async save(row) {
    const root = requireConsumerRoot(row.consumerRoot);
    await atomicWriteText(path.join(await ensureConsumerCleanupDir(root), row.token + ".json"), JSON.stringify(row));
    this.previews.set(row.token, copy(row));
  }
  /** r110 review round 2 (P1-2): ONE per-token serialization boundary for every related
   * ledger write - observation merges AND maintenance lifecycle saves. read() hands out an
   * independent copy and save() writes the whole row with no CAS, so two flows that each
   * read-mutate-save can erase each other even when each reloads just before saving: a reload
   * cannot protect the window in which the OTHER flow's save lands after this reload but
   * before this save completes. Queuing each token's read-mutate-save critical sections on
   * one promise chain (in this process, precedent: the localExecutions map) restores an
   * atomic update boundary with no cross-process lock. A settled chain entry removes itself,
   * and only while the map still points at it, so tokens never accumulate. */
  withLedgerWrite(token, task) {
    const previous = this.ledgerChains.get(token) || Promise.resolve();
    const step = previous.then(task);
    const guard = step.then(() => undefined, () => undefined);
    this.ledgerChains.set(token, guard);
    guard.then(() => { if (this.ledgerChains.get(token) === guard) this.ledgerChains.delete(token); });
    return step;
  }
  async persistObservationProgress(row, mutations, observations) {
    return this.withLedgerWrite(row.token, async () => {
      const fresh = await this.read(row.token, row.consumerRoot);
      for (const mutation of mutations) {
        if (!Number.isInteger(mutation.index) || fresh.states[mutation.index] === undefined) continue;
        if (fresh.states[mutation.index] === "completed") continue; // completed only advances from a completed proof
        fresh.states[mutation.index] = mutation.state;
      }
      if (observations !== undefined) fresh.observations = copy(observations);
      await this.save(fresh);
    });
  }
  /** r110b: the maintenance flow's isolatedDelete object is the authority for the lifecycle
   * field only; everything else (target states, observations) is taken from the current row
   * inside the same token boundary - the lifecycle never vanishes under an observer's stale
   * write, and a maintenance save never rewrites a fresher observation state. */
  async saveIsolatedDelete(row) {
    return this.withLedgerWrite(row.token, async () => {
      const fresh = await this.read(row.token, row.consumerRoot);
      fresh.isolatedDelete = copy(row.isolatedDelete);
      await this.save(fresh);
    });
  }
  async preview(params) {
    const consumerRoot = requireConsumerRoot(params.consumerRoot); // the LOCAL consuming project, never node.root
    const tmuxSessionPrefix = String(params.tmuxSessionPrefix || "simple").trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(tmuxSessionPrefix)) fail("INVALID_TMUX_SESSION_PREFIX");
    for (const [token, preview] of this.previews) if (Date.now() > preview.expiresAt) this.previews.delete(token);
    if (this.previews.size >= 4096) fail("CLEANUP_PREVIEW_CAPACITY_EXCEEDED");
    const { node, action = "move", targets } = params;
    if (params.authorizationMode !== undefined && params.authorizationMode !== "confirmed_paths") fail("INVALID_AUTHORIZATION_MODE");
    // Staged-slot reclaim authorizations are recorded EXPLICITLY and travel with the frozen ledger
    // row: "auto_expiry_reclaim" is the automatic claim-scoped policy, "single_confirmation_release"
    // is the exact-preview user-confirmed release. Both are isolate-only; nothing else accepts them
    // and they never change the confirmation counts, digests or delete rules of any other chain.
    const reclaimAuthorizationSource = params.authorizationSource;
    if (reclaimAuthorizationSource !== undefined
      && (action !== "isolate" || !["auto_expiry_reclaim", "single_confirmation_release"].includes(reclaimAuthorizationSource))) fail("INVALID_AUTHORIZATION_SOURCE");
    // P1-3 ruling: an expiry/single-confirmation reclaim may only ride an EXPLICIT journal
    // binding — identity + committed generation + terminal moment + expiry threshold for the
    // exact slot. The binding is ownership metadata on the frozen row (outside the digest
    // preimage, like reclaimAuthorizationSource) and is handed to the engine's isolate so the
    // eligibility can be re-proven UNDER the slot lock at rename time. Malformed or unrelated
    // bindings are refused outright; nothing implicit is ever inferred.
    const stagedJournal = params.stagedJournal;
    if (stagedJournal !== undefined) {
      if (action !== "isolate" || !reclaimAuthorizationSource
        || !stagedJournal || typeof stagedJournal !== "object" || Array.isArray(stagedJournal)
        || !/^[0-9a-f]{64}$/.test(String(stagedJournal.identity || ""))
        || !/^[0-9a-f]{64}$/.test(String(stagedJournal.generation || ""))
        || stagedJournal.status !== "committed"
        || !(Number.isInteger(stagedJournal.expiryMs) && stagedJournal.expiryMs > 0)
        || !(stagedJournal.terminalAt === null || (Number.isInteger(stagedJournal.terminalAt) && stagedJournal.terminalAt > 0))
        // 0.2.114: WHO authorized the isolation is an explicit boolean, never a truthy stand-in;
        // ABSENT means true, so every 0.2.113 caller keeps expiry behaviour byte-for-byte.
        || !(stagedJournal.requireExpired === undefined || typeof stagedJournal.requireExpired === "boolean")) fail("INVALID_STAGED_JOURNAL_BINDING");
    }
    // The mode freezes with the preview (0.2.114): it joins the digest preimage, so flipping it
    // between preview → confirm → execute breaks the exact-digest check, and execute can only
    // ever replay the frozen value stored on the row. expiryMs stays required and > 0 in BOTH
    // modes — nobody smuggles 0 to switch the age rule off implicitly.
    const frozenRequireExpired = stagedJournal === undefined ? undefined : (stagedJournal.requireExpired === undefined ? true : stagedJournal.requireExpired);
    const pathOnly = params.authorizationMode === "confirmed_paths";
    // Confirmed paths only ever authorize permanent deletion; a move/restore
    if (pathOnly && action !== "delete") fail("INVALID_ACTION");
    const observationMode = params.observationMode === "managed_tmux" || pathOnly ? node?.kind === "local" ? "filesystem" : "tmux" : undefined;
    // Public batch entry: pathOnly (confirmed permanent deletion) rides the
    // batched fast chain and accepts the full engine FAST_BATCH_LIMIT of 5000
    // targets; move/restore/isolate keep their own per-target 500 limit.
    if (!node?.root || !["move", "delete", "restore", "isolate"].includes(action) || !Array.isArray(targets) || !targets.length || targets.length > (pathOnly ? 5000 : 500)) fail("INVALID_REQUEST");
    if (pathOnly) return await this.previewFast(node, targets, tmuxSessionPrefix, consumerRoot);
    if (!pathOnly) await this.activity(node);
    const rows = []; let identity;
    // Per-backend capability proof for the background-delete chain: EVERY
    // isolate inspect answer of THIS backend must carry the engine's
    // backgroundIsolatedDelete flag. An older engine that never answers it
    // keeps safety silent for this backend, and SE's per-backend check then
    // keeps the whole plan on the old downgrade chain — the plugin never
    // advertises a capability the connected backend did not show.
    const isolateEngineProof = [];
    // Same-source proof for the user-confirmed early release (0.2.114): ONLY staged-slot inspect
    // answers carry the engine's userConfirmedSlotRelease flag, so a mixed batch, a non-staged
    // target or an older engine keeps the safety flag silent — never advertised for free.
    const userReleaseEngineProof = [];
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
      if (action === "isolate") { isolateEngineProof.push(result.backgroundIsolatedDelete === 1); userReleaseEngineProof.push(result.userConfirmedSlotRelease === 1); }
      rows.push({ ...copy(target), ...result.target, destination: target.destination });
    }
    const backgroundIsolatedDelete = action === "isolate" && isolateEngineProof.length === rows.length
      && isolateEngineProof.every(Boolean) ? 1 : undefined;
    const userConfirmedSlotRelease = action === "isolate" && userReleaseEngineProof.length === rows.length
      && userReleaseEngineProof.every(Boolean) ? 1 : undefined;
    const row = { token: crypto.randomBytes(24).toString("hex"), operationId: "cleanup-" + crypto.randomBytes(16).toString("hex"), consumerRoot, node: copy(node), rootIdentity: identity,
      action, observationMode, authorizationMode: pathOnly ? "confirmed_paths" : undefined, reclaimAuthorizationSource,
      // The stored binding carries the EXPLICIT mode (0.2.114): execute replays this copy verbatim,
      // so the engine always sees the frozen requireExpired, never a caller-time re-guess.
      stagedJournal: stagedJournal ? copy({ ...stagedJournal, requireExpired: frozenRequireExpired }) : undefined, targets: rows, safety: { gitRepositoryAncestors: true, readOnlyReceiptCheck: true, formalJobOwner: true, immutableArchiveBatch: true, batchPreviewCapacity: 4096, managedObservation: 1, confirmedPathDeletion: 1, confirmedPathMetadata: 1, confirmedPathNestedRepositories: 1, isolateFast: action === "isolate" ? 1 : undefined, requiredInputGuard: action === "isolate" ? 1 : undefined, isolationCompletionReceipt: backgroundIsolatedDelete, backgroundIsolatedDelete, userConfirmedSlotRelease, registeredIsolationDeletion: 1, subtreeSingleWriter: 1, serverWindowSelfClose: 1, chunkedFrozenManifest: 1, pinnedRuntimeProgram: 1, handleScan: pathOnly ? "confirmed_paths" : observationMode ? "managed_tmux" : "visible_same_user_processes" }, expiresAt: Date.now() + 30 * 60 * 1000, confirmations: 0, states: rows.map(row => row.missing ? "absent" : "pending") };
    row.tmuxSessionPrefix = tmuxSessionPrefix;
    row.targetDigests = rows.map(targetHash);
    // requireExpired joins the digest preimage when a binding froze it (0.2.114 contract ③):
    // previews that differ only in the mode get different digests, so a mode flip can never
    // survive the exact-digest check from confirm to execute. Without a binding the key is
    // undefined and JSON.stringify drops it — every existing (0.2.113) digest is byte-identical.
    row.digest = hash({ node: row.node, rootIdentity: identity, action, targets: rows, safety: row.safety, tmuxSessionPrefix, requireExpired: frozenRequireExpired });
    this.previews.set(row.token, copy(row)); // Preview does not write a journal or a remote hash cache.
    return copy(row);
  }
  /** v1.9 confirmed selection: entry identity binds, one batched read-only
   * metadata transfer per chunk, bounded parallel reads; mutation stays one
   * serial delete-fast call. Directories isolate by non-overwriting rename. */
  async previewFast(node, targets, tmuxSessionPrefix, consumerRoot) {
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
    const row = { token: crypto.randomBytes(24).toString("hex"), operationId, consumerRoot, node: copy(node), rootIdentity: identity,
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
    // An executor fact from another consumer's preview never answers for this project.
    const filterRoot = params.consumerRoot === undefined ? undefined : requireConsumerRoot(params.consumerRoot);
    if (params.observeExecutors === true && params.node.kind === "local") {
      result.executorsChecked = true; result.executors = [];
      for (const [key] of this.localExecutions) {
        const [token, index] = key.split(":"), row = this.previews.get(token), target = row?.targets[Number(index)];
        if (filterRoot !== undefined && row?.consumerRoot !== filterRoot) continue;
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
          rowsByKey.set(ci + " " + answered.relativePath + "\u0000" + answered.type, answered);
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
        const entry = rowsByKey.get(ci + " " + entries[orig].relativePath + "\u0000" + entries[orig].type) || { status: "missing" };
        const archived = Boolean(target.archived);
        let state;
        const proofExtra = {};
        if (iso !== null) {
          const isoRow = rowsByKey.get(ci + " " + entries[iso].relativePath + "\u0000" + "directory") || { status: "missing" };
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
    // Every token read inside the round binds the caller's local consumer root; a round that
    // carries backend references without one is refused at REQUEST level, not per target.
    const consumerRoot = targets.some(target => target?.backendToken !== undefined || target?.backendIndex !== undefined)
      ? requireConsumerRoot(params.consumerRoot) : undefined;
    for (const target of targets) {
      const key = target?.key, rel = target?.relativePath, type = target?.type;
      if (typeof key !== "string" || !key || seen.has(key) || !["file", "directory"].includes(type)) fail("INVALID_REQUEST");
      if (!observedPath(rel)) fail("INVALID_REQUEST");
      if (rel.split("/").includes(".git")) fail("PROTECTED_PATH");
      if (rel.startsWith("clean_dir/") && !/^clean_dir\/job-[a-f0-9]{48}\//.test(rel)) fail("UNSAFE_DESTINATION");
      seen.add(key);
      let device = target.device, inode = target.inode, row, archived = false, deleteLifecycle;
      let isolationRelativePath = target.isolationRelativePath, rootIdentity = params.rootIdentity;
      if (target.backendToken !== undefined || target.backendIndex !== undefined) {
        if (typeof target.backendToken !== "string" || !Number.isInteger(target.backendIndex) || target.backendIndex < 0
            || isolationRelativePath !== undefined && typeof isolationRelativePath !== "string"
            || target.backendDigest !== undefined && typeof target.backendDigest !== "string") fail("INVALID_REQUEST");
        const unknown = code => { early.set(key, { key, relativePath: rel, type, state: "unknown", executors: [], executorsChecked: false,
          ...(isolationRelativePath !== undefined ? { isolationChecked: false } : {}), error: { code, message: code } }); };
        const snapshot = rowSnapshots.get(target.backendToken);
        if (snapshot === ROW_READ_FAILED) { unknown("TOKEN_UNAVAILABLE"); continue; }
        if (snapshot !== undefined) row = snapshot;
        // The round's stop codes (attribution, unbound legacy, corrupt) surface per target as
        // that target's honest unknown instead of being flattened into TOKEN_UNAVAILABLE.
        else try { row = await this.read(target.backendToken, consumerRoot, typeof target.backendDigest === "string" ? target.backendDigest : undefined); rowSnapshots.set(target.backendToken, row); }
        catch (error) { rowSnapshots.set(target.backendToken, ROW_READ_FAILED); unknown(String(error?.code || "TOKEN_UNAVAILABLE")); continue; }
        // A raced-in project record keeps its own value; if it no longer matches THIS target's
        // frozen reference, the target answers unknown rather than borrowing foreign facts.
        if (typeof target.backendDigest === "string" && row.digest !== target.backendDigest) { unknown("TOKEN_DIGEST_MISMATCH"); continue; }
        // Cross-node or cross-root token reuse is refused per target, never
        // answered with the wrong root's facts.
        if (!sameNode(row.node, node) || rootIdentity !== undefined && hash(row.rootIdentity) !== hash(rootIdentity)) { unknown("TOKEN_NODE_MISMATCH"); continue; }
        const frozen = row.targets[target.backendIndex];
        // 0.2.111: an isolate token that owns a background-delete lifecycle may
        // ALSO be observed through its registered destination paths. The
        // binding still comes from the frozen ledger row only — a caller claim
        // the row contradicts stays an explicit unknown, never a probe.
        const lifecycle = row.isolatedDelete && typeof row.isolatedDelete === "object" ? row.isolatedDelete : undefined;
        const destinationBound = Boolean(frozen) && !frozen.missing && frozen.type === type
          && lifecycle !== undefined && frozen.destination === rel;
        // The deletion lifecycle semantics below apply ONLY to the destination
        // rows; a source-path observation of the same token keeps the existing
        // state derivation untouched.
        if (destinationBound) deleteLifecycle = lifecycle;
        if (!frozen || frozen.type !== type || (frozen.relativePath !== rel && !destinationBound)) { unknown("TOKEN_TARGET_MISMATCH"); continue; }
        device = frozen.device; inode = frozen.inode; rootIdentity = row.rootIdentity; archived = Boolean(frozen.archived) || destinationBound;
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
        deleteLifecycle, index: row ? target.backendIndex : undefined };
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
      if (item.deleteLifecycle) {
        // Background-delete observation of one registered destination:
        // completion additionally requires the LEDGER lifecycle to say
        // completed — while the delete is accepted/executing/unknown, an
        // absent destination is not proof (the mutation answer may have been
        // lost), and a still-present or replaced path is never residue that
        // authorizes another deletion from here.
        if (item.deleteLifecycle.phase === "completed") return status === "gone" || status === "replaced" ? "completed" : "unknown";
        if (status === "present") return item.deleteLifecycle.phase === "executing" ? "executing" : "pending";
        return "unknown";
      }
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
      // Every non-answer is an EXPLICIT unknown: SE must never mistake a dropped,
      // duplicated or failed-batch row for absence, and never read a bare error
      // as "no verdict yet". Answered rows keep deriveState semantics untouched.
      const unknownWith = (code, message) => ({ ...base, state: "unknown", executors: [], executorsChecked: false,
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
    const row = await this.read(params.token, params.consumerRoot, typeof params.backendDigest === "string" ? params.backendDigest : undefined), index = params.index;
    if (!Number.isInteger(index) || !row.targets[index]) fail("INVALID_TARGET");
    if (isFastDeleteRow(row)) return this.fastVerify(row, index);
    if (row.observationMode) {
      // r108: a completed observation is durable before the answer returns. The
      // ledger must never keep saying "executing" after the engine proved the
      // move completed; a background delete reads ONLY persisted states.
      const proof = await this.observe(row, index);
      if (proof && proof.state === "completed" && row.states[index] !== "completed") { row.states[index] = "completed"; await this.persistObservationProgress(row, [{ index, state: "completed" }]); }
      return proof;
    }
    return this.checked({ node: row.node, root: row.node.root, rootIdentity: row.rootIdentity, target: row.targets[index],
      action: "check", deleted: row.action === "delete", receiptCompleted: row.states[index] === "completed" });
  }
  async previewIsolationParents(params) {
    const tokens = params.isolationTokens ?? [params.isolationToken];
    if (!Array.isArray(tokens) || !tokens.length || tokens.length > 500 || new Set(tokens).size !== tokens.length) fail("INVALID_REQUEST");
    const originals = [];
    for (const token of tokens) originals.push(await this.read(token, params.consumerRoot));
    const original = originals[0];
    if (originals.some(row => row.action !== "isolate")) fail("NOT_ISOLATION_TOKEN");
    if (originals.some(row => hash(row.node) !== hash(original.node) || hash(row.rootIdentity) !== hash(original.rootIdentity))) fail("ROOT_IDENTITY_CHANGED");
    const destinations = [...new Set(originals.flatMap(row => row.targets.filter(target => !target.missing).map(target => target.destination)))];
    if (new Set(destinations.map(destination => destination.split("/").slice(0, 2).join("/"))).size !== 1) fail("EMPTY_ISOLATION_SCOPE_INVALID");
    if (!destinations.length) return { ok: true, eligible: false, targets: [] };
    const result = await this.checked({ node: original.node, root: original.node.root, rootIdentity: original.rootIdentity,
      action: "inspect-isolation-parents", destinations, forReplacement: params.forReplacement === true });
    if (hash(result.rootIdentity) !== hash(original.rootIdentity)) fail("ROOT_IDENTITY_CHANGED");
    if (!result.eligible || (!result.targets?.length && params.forReplacement !== true)) return { ok: true, eligible: false, targets: [], reason: result.reason };
    const row = { token: crypto.randomBytes(24).toString("hex"), operationId: "cleanup-" + crypto.randomBytes(16).toString("hex"),
      consumerRoot: original.consumerRoot, node: copy(original.node), rootIdentity: copy(original.rootIdentity),
      action: "delete", authorizationMode: "confirmed_paths", isolationParentCleanup: true,
      sourceIsolationToken: original.token, sourceIsolationTokens: tokens, destinations, includeIsolatedArtifacts: params.forReplacement === true,
      targets: copy(result.targets), confirmations: 0, expiresAt: Date.now() + 30 * 60 * 1000,
      states: result.targets.map(() => "pending"), safety: { emptyDirectoriesOnly: 1, parentCwdRequired: 1, doubleConfirmation: 1 } };
    row.confirmationPaths = [...row.targets.map(target => target.absolutePath), ...(row.includeIsolatedArtifacts
      ? destinations.map(destination => original.node.kind === "local" ? path.join(original.node.root, destination)
        : path.posix.join(original.node.root, destination)) : [])];
    row.digest = hash({ node: row.node, rootIdentity: row.rootIdentity, sourceIsolationTokens: row.sourceIsolationTokens,
      targets: row.targets, destinations, confirmationPaths: row.confirmationPaths, safety: row.safety });
    this.previews.set(row.token, copy(row));
    return { ...copy(row), eligible: true };
  }
  async executeIsolationParents(row, params) {
    if (params.index !== 0 || row.confirmations !== 2 || params.digest !== row.digest) fail("CONFIRM_REQUIRED");
    if (row.isolationParentsCompleted) return { ok: true, state: "completed", receipt: row.parentReceipt };
    if (this.busy.has(row.token) || row.parentOutcome === "executing") fail("OPERATION_BUSY");
    if (row.parentOutcome === "unknown") fail("OPERATION_OUTCOME_UNKNOWN");
    this.busy.add(row.token);
    try {
      return await this.lease(row.node, row.targets, async () => {
        row.parentOutcome = "executing"; await this.save(row);
        let result;
        try { result = await this.checked({ node: row.node, root: row.node.root, rootIdentity: row.rootIdentity,
          action: "prune-isolation-parents", parentConfirmations: 2, destinations: row.destinations, entries: row.targets }); }
        catch (error) { row.parentOutcome = "unknown"; await this.save(row); throw error; }
        if (result.state !== "completed") fail("CLEANUP_NOT_VERIFIED");
        row.parentOutcome = "completed"; row.isolationParentsCompleted = true; row.parentReceipt = result.receipt;
        // Keep completion identity, not an extra archived file/path inventory.
        row.targets = []; row.states = []; row.confirmationPaths = []; row.destinations = [];
        await this.save(row);
        return result;
      });
    } finally { this.busy.delete(row.token); }
  }
  async confirm(params) {
    const row = await this.read(params.token, params.consumerRoot, typeof params.digest === "string" ? params.digest : undefined);
    if (Date.now() > row.expiresAt) fail("PREVIEW_EXPIRED");
    const exact = row.isolationParentCleanup ? row.confirmationPaths : row.targets.filter(t => !t.missing).map(t => t.absolutePath);
    if (params.confirm !== true || params.digest !== row.digest || hash(params.exactTargets) !== hash(exact)) fail("CONFIRM_REQUIRED");
    if (params.phase !== row.confirmations + 1 || params.phase > (row.action === "delete" ? 2 : 1)) fail("CONFIRM_REQUIRED");
    row.confirmations = params.phase; await this.save(row);
    return { ok: true, token: row.token, digest: row.digest, confirmations: row.confirmations };
  }
  async execute(params) {
    const row = await this.read(params.token, params.consumerRoot, typeof params.digest === "string" ? params.digest : undefined);
    if (row.isolationParentCleanup) return this.executeIsolationParents(row, params);
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
      if (["completed", "executing"].includes(proof.state)) {
        // r108: completion proved at execute-time lands in the ledger before the
        // return; only a completed proof may write completed, and an already
        // completed row is never rewritten. The returned proof is untouched.
        if (proof.state === "completed" && row.states[index] !== "completed") { row.states[index] = "completed"; await this.persistObservationProgress(row, [{ index, state: "completed" }]); }
        return proof;
      }
      if (proof.state !== "pending") fail("CLEANUP_TARGET_CHANGED");
      if (row.authorizationMode !== "confirmed_paths") await this.activity(row.node);
      const request = { node: row.node, root: row.node.root, rootIdentity: row.rootIdentity,
        action: row.observationMode === "tmux" ? "managed-start" : row.action,
        cleanupAction: row.action, operationId: row.operationId, target: row.targets[index],
        tmuxSessionPrefix: row.tmuxSessionPrefix || params.tmuxSessionPrefix || "simple" };
      // A lost response cannot leave a local busy flag that blocks later observations.
      // r110: this write must also merge (never whole-copy), or a stale round could erase a
      // sibling target's completed written while this observation was in flight.
      row.states[index] = "executing"; await this.persistObservationProgress(row, [{ index, state: "executing" }]);
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
          // r110b (P1-1): this rollback copy predates the managed-start attempt, so a sibling
          // completion or a maintenance lifecycle persisted during that window must survive;
          // the rollback advances only its own target, and a target already proved completed
          // is never rolled back.
          row.states[index] = "pending"; await this.persistObservationProgress(row, [{ index, state: "pending" }]);
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
          operationId: row.operationId, target: row.targets[index],
          // The engine re-proves the reclaim eligibility from THIS binding under the slot lock
          // immediately before the rename (settle never re-moves, so it needs nothing).
          ...(row.stagedJournal ? { stagedJournal: copy(row.stagedJournal) } : {}) };
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
    const row = await this.read(params.token, params.consumerRoot, typeof params.backendDigest === "string" ? params.backendDigest : undefined);
    if (row.isolationParentCleanup) {
      if (row.isolationParentsCompleted || !row.parentOutcome || this.busy.has(row.token)) return row;
      try {
        const proof = await this.checked({ node: row.node, root: row.node.root, rootIdentity: row.rootIdentity,
          action: "check-isolation-parents", destinations: row.destinations, entries: row.targets });
        if (hash(proof.rootIdentity) !== hash(row.rootIdentity)) fail("ROOT_IDENTITY_CHANGED");
        row.parentOutcome = proof.state === "completed" ? "completed" : "unknown";
        if (proof.state === "completed") {
          row.isolationParentsCompleted = true; row.parentReceipt = { phase: "completed", verifiedBy: "active_absence" };
          row.targets = []; row.states = []; row.confirmationPaths = []; row.destinations = [];
        }
        delete row.statusQueryError; await this.save(row);
      } catch (error) { row.statusQueryError = String(error.code || error.message); }
      return row;
    }
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
      const progress = [];
      for (let index = 0; index < row.targets.length; index++) {
        try {
          const proof = await this.observe(row, index);
          row.observations.push(proof);
          // r108 accounting (mirrors the batched fast-delete rules): completed is reached
          // only through a completed proof, and missing or degraded evidence can never
          // erase an already-persisted completion.
          if (!(row.states[index] === "completed" && proof.state !== "completed")) row.states[index] = proof.state;
        } catch(error) { row.observations.push({ state: "unknown", queryError: error.message }); if (row.states[index] !== "completed") row.states[index] = "unknown"; }
        progress.push({ index, state: row.states[index] });
      }
      // The ledger is durable after every full status round: a reader that never
      // calls status (or a later background-delete admission) sees the same truth.
      // r110: merged per-index against the current row (completed is sticky there too),
      // so a slow round cannot erase completions or lifecycle written mid-round.
      await this.persistObservationProgress(row, progress, row.observations);
    }
    return row;
  }
  /** Settle an already-authorized receipt before coordinator preflight. Never starts a new move. */
  async settle(params) {
    const row = await this.read(params.token, params.consumerRoot, typeof params.digest === "string" ? params.digest : undefined), index = params.index, target = row.targets[index];
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
  /** 0.2.111 background permanent deletion of ONE registered isolation token.
   * Wire contract (verbatim, published by SE 0.5.414): method
   * files.cleanup.isolatedMaintenanceDelete, params exactly
   * { token, digest, targets: [{ index, relativePath, destination }] },
   * answer { ok, state, operationId } where state is "accepted" |
   * "already_accepted" | "failed" — accepted is deliberately NEVER worded as
   * "deleted", and any other value is the caller's unknown channel. The
   * caller bindings are a cross-check ONLY: each must equal the ledger target
   * at that index exactly; they never contribute a path to delete and a
   * replaced or extended destination is refused (TARGET_BINDINGS_MISMATCH).
   * The delete set is derived exclusively from THIS ledger row's registered
   * destinations. No consumerRoot arrives with this call: without it the row
   * is located in THIS plugin process's ledger only and the frozen digest
   * must match byte-for-byte; a non-resident record fails as PREVIEW_EXPIRED
   * instead of ever guessing an owner by scanning, and those rows keep the
   * manual two-confirmation chain. */
  async isolatedMaintenanceDelete(params) {
    let row;
    if (params.consumerRoot === undefined) {
      if (!/^[a-f0-9]{48}$/.test(String(params.token))) fail("INVALID_TOKEN");
      const memory = this.previews.get(String(params.token));
      if (!memory) fail("PREVIEW_EXPIRED", undefined, { reason: "隔离 token 不在当前插件进程台账中，后台删除不猜测归属，请走两次确认人工审核链" });
      row = copy(memory);
    } else {
      row = await this.read(params.token, params.consumerRoot, typeof params.digest === "string" ? params.digest : undefined);
    }
    if (typeof params.digest !== "string" || params.digest !== row.digest) fail("CONFIRM_REQUIRED", undefined, { reason: "后台删除必须绑定该隔离 token 的冻结摘要" });
    if (row.action !== "isolate") fail("NOT_ISOLATION_TOKEN", "后台删除入口只接受已登记的隔离 token，永久删除的通用确认链不变");
    if (params.parentCleanupToken !== undefined) {
      const parents = await this.read(params.parentCleanupToken, params.consumerRoot);
      if (!parents.isolationParentCleanup || !parents.sourceIsolationTokens.includes(row.token) || parents.confirmations !== 2
          || !parents.includeIsolatedArtifacts || hash(parents.node) !== hash(row.node)) fail("CONFIRM_REQUIRED");
    }
    // Caller bindings { index, relativePath, destination } are verified ONLY.
    if (params.targets !== undefined) {
      if (!Array.isArray(params.targets)) fail("INVALID_REQUEST");
      const claimed = new Set();
      for (const binding of params.targets) {
        if (!binding || !Number.isInteger(binding.index) || binding.index < 0 || binding.index >= row.targets.length
            || typeof binding.relativePath !== "string" || typeof binding.destination !== "string") fail("TARGET_BINDINGS_MISMATCH");
        const target = row.targets[binding.index];
        if (target.relativePath !== binding.relativePath || target.destination !== binding.destination) fail("TARGET_BINDINGS_MISMATCH");
        if (claimed.has(binding.index)) fail("TARGET_BINDINGS_MISMATCH");
        claimed.add(binding.index);
      }
    }
    if (this.busy.has(row.token)) return { ok: true, state: "already_accepted", operationId: row.operationId,
      reason: "同一 token 的后台删除正在进行中，不创建第二个删除执行器" };
    // Engine-side protections (unchanged guarantees): only clean_dir/job-<48hex>/…
    // subtrees whose registration state is "isolated" may be deleted (unregistered
    // refuses, NOT_REGISTERED_ISOLATION); the destination equals the registered path
    // exactly, entry device+inode must match the frozen identity, and the
    // safe-root/ancestor-link/direct-parent/mount guards hold; hard links only lose
    // the isolated name (unlink), and neither the source paths, clean_dir/.operations
    // nor the MANIFEST are touched. The move-stage executor facts already bound into
    // the completion receipt are the executor evidence; no extra executor query runs
    // at deletion time. Lifecycle (accepted → executing → completed/failed/unknown)
    // is persisted in row.isolatedDelete; an unknown outcome is resolved by a
    // read-only re-inspect and is NEVER blindly re-executed. This entry is a
    // maintenance channel: it deliberately does not hold the transfer-busy admission
    // lock, because it only ever mutates the registered isolated copies (engine-
    // enforced), never live paths — real transfers still register and count as busy
    // exactly as before. Isolation itself still refuses to move paths while any real
    // transfer is busy.
    // Derive the delete set from the ledger alone and re-check the shape.
    const derived = [];
    for (let index = 0; index < row.targets.length; index++) {
      const target = row.targets[index];
      if (target.missing) continue; // absent at preview: never isolated, nothing to delete
      if (typeof target.destination !== "string" || typeof target.archiveBatch !== "string"
          || !/^clean_dir\/job-[a-f0-9]{48}\//.test(target.destination)
          || target.destination !== "clean_dir/" + target.archiveBatch + "/" + target.relativePath)
        fail("UNSAFE_DESTINATION", "登记目的地与隔离批次派生路径不一致，拒绝后台删除");
      if (row.states[index] !== "completed") fail("NOT_ISOLATED_COMPLETE", "该 token 存在未完成隔离或结果未知的目标，整批不启动后台删除");
      derived.push({ index, target });
    }
    if (!derived.length) fail("NOT_AN_EXECUTABLE_TARGET", "该隔离 token 没有已登记的可删除目标");
    const inspectSet = () => this.checked({ node: row.node, root: row.node.root, action: "batch-inspect", authorizationMode: "confirmed_paths",
      operationId: row.operationId, targets: derived.map(({ target }) => ({ relativePath: target.destination, type: target.type, device: target.device, inode: target.inode })) });
    const answersByKey = inspected => { const map = new Map();
      // type 只有 file/directory 两种取值，"路径 + 空格 + 类型" 的组合键是单射的，不会串号。
      for (const answer of Array.isArray(inspected.targets) ? inspected.targets : []) map.set(String(answer.relativePath) + " " + String(answer.type), answer);
      return map; };
    const lifecycle = row.isolatedDelete;
    // "accepted"/"already_accepted" both only ever mean "maintenance was
    // accepted" — never "deleted"; the internal phase and receipt hold the truth.
    if (lifecycle && lifecycle.phase === "completed")
      return { ok: true, state: "already_accepted", operationId: row.operationId, isolatedDelete: copy(lifecycle) };
    if (lifecycle && ["accepted", "executing", "unknown"].includes(lifecycle.phase)) {
      // A lost mutation answer is resolved by read-only facts, never by a
      // second mutation RPC: completion needs every destination gone AND the
      // deletion record persisted; anything else stays uncertain.
      const inspected = await inspectSet();
      const answers = answersByKey(inspected);
      const resolved = derived.every(({ target }) => { const answer = answers.get(target.destination + " " + target.type);
        return Boolean(answer) && answer.missing === true && answer.isolationState === "deleted"; });
      if (!resolved) return { ok: true, state: "unknown", operationId: row.operationId, isolatedDelete: copy(lifecycle),
        reason: "上一次后台删除结果未知：只读复检显示尚未全部删除，稍后再查即可，绝不重复执行删除" };
      row.isolatedDelete = { ...copy(lifecycle), phase: "completed", verifiedBy: "isolation_deleted", completedAt: new Date().toISOString() };
      await this.saveIsolatedDelete(row);
      return { ok: true, state: "already_accepted", operationId: row.operationId, verifiedBy: "isolation_deleted", isolatedDelete: copy(row.isolatedDelete) };
    }
    this.busy.add(row.token);
    try {
      return await this.lease(row.node, row.targets, async () => {
        // Registration truth per destination, in ONE read-only batched RPC:
        // archived shape, state "isolated", frozen device+inode (the engine
        // refuses identity drift), plus the persisted move-moment completion
        // facts where the ledger itself lacks them.
        const inspected = await inspectSet();
        const answers = answersByKey(inspected);
        const entries = []; const alreadyDone = [];
        for (const { index, target } of derived) {
          const answer = answers.get(target.destination + " " + target.type);
          if (!answer) fail("OBSERVATION_MISSING", "登记目的地缺少复检答案，按未知处理，不启动删除");
          if (answer.archived !== true) fail("UNSAFE_DESTINATION", "复检结果不属于已登记隔离区形状");
          if (answer.missing === true) {
            if (answer.isolationState === "deleted") { alreadyDone.push(target.destination); continue; }
            fail("NOT_REGISTERED_ISOLATION", "登记目的地缺失且无删除记录：结果未知，拒绝删除，不重复任何移动");
          }
          if (answer.isolationState !== "isolated") fail("NOT_REGISTERED_ISOLATION", "只有登记为 isolated 的隔离副本可以后台删除");
          const proof = ledgerCompletion(row, index) || isolateCompletionProof(answer.isolationCompletion, target);
          if (!proof) fail("NOT_ISOLATION_COMPLETION_RECEIPT", "缺少 rename 成功、移动时源缺失与登记完成的移动时回执，保留原两次确认人工审核链");
          entries.push({ relativePath: target.destination, type: target.type, device: String(answer.device ?? target.device), inode: String(answer.inode ?? target.inode) });
        }
        row.isolatedDelete = { capability: "isolationBackgroundDelete", protocol: 1, phase: "accepted", operationId: row.operationId,
          acceptedAt: new Date().toISOString(), alreadyDeleted: alreadyDone,
          ...(row.reclaimAuthorizationSource ? { reclaimAuthorizationSource: row.reclaimAuthorizationSource } : {}),
          targets: entries.map(entry => ({ destinationRelativePath: entry.relativePath, type: entry.type })) };
        await this.saveIsolatedDelete(row); // durable acceptance BEFORE any mutation
        if (!entries.length) {
          row.isolatedDelete.phase = "completed"; row.isolatedDelete.verifiedBy = "isolation_deleted";
          row.isolatedDelete.completedAt = new Date().toISOString();
          await this.saveIsolatedDelete(row);
          return { ok: true, state: "already_accepted", verifiedBy: "isolation_deleted", operationId: row.operationId,
            isolatedDelete: copy(row.isolatedDelete) };
        }
        row.isolatedDelete.phase = "executing"; await this.saveIsolatedDelete(row);
        let result;
        try {
          // One serial delete-fast RPC over the derived set; the engine is the
          // same single confirmed-path executor as the manual chain.
          result = await this.checked({ node: row.node, root: row.node.root, rootIdentity: row.rootIdentity, action: "delete-fast",
            authorizationMode: "confirmed_paths", operationId: row.operationId, entries });
        } catch (error) {
          // Only the engine's explicit zero-mutation fact makes the refusal
          // retryable ("failed"); anything else stays unknown for a read-only
          // resolve. The caller never sees a thrown maintenance error: SE must
          // be able to log the reason without any failure reaching its
          // dispatch chain, and a retry can never create a second executor.
          const zeroMutation = error.mutationStarted === false && FAST_ZERO_MUTATION_CODES.has(error.code);
          row.isolatedDelete.phase = zeroMutation ? "failed" : "unknown";
          row.isolatedDelete.error = { code: String(error && error.code || "UNVERIFIED_RESPONSE"), at: new Date().toISOString() };
          await this.saveIsolatedDelete(row);
          return { ok: true, state: zeroMutation ? "failed" : "unknown", operationId: row.operationId,
            reason: String(error && error.code || "UNVERIFIED_RESPONSE") + (error && error.message ? ": " + String(error.message).slice(0, 200) : ""),
            isolatedDelete: copy(row.isolatedDelete) };
        }
        row.isolatedDelete.phase = "completed";
        row.isolatedDelete.receipt = result.receipt;
        row.isolatedDelete.completedAt = new Date().toISOString();
        // A ledger-write failure here reaches the caller as an error, but the
        // engine-side truth (all destinations gone + persisted deleted markers)
        // lets the next call resolve to already_accepted; the engine refuses
        // any re-mutation of those entries anyway.
        await this.saveIsolatedDelete(row);
        return { ok: true, state: "accepted", operationId: row.operationId,
          isolatedDelete: copy(row.isolatedDelete), receipt: result.receipt };
      });
    } finally { this.busy.delete(row.token); }
  }
  async verify(params) {
    const row = await this.read(params.token, params.consumerRoot, typeof params.backendDigest === "string" ? params.backendDigest : undefined), target = row.targets[params.index];
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
