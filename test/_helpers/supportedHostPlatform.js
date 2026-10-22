"use strict";
// 隔离纯函数夹具：把 extension.js 中的打包/传输编排函数切片进 vm 沙箱执行。
// 平台事实（win32 批量命令通道 / darwin 内存转发分支）只作为沙箱内 process 字段注入，
// 绝不修改真实进程或生产模块；每个用例显式注入 batch/relay/inspect 传输，断言保留原语义。
// 真正的 pwsh/Windows 宿主门禁仍由 host_windows 在真实 Windows 执行，本夹具不能替代。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "extension.js"), "utf8");

function functionSlice(name) {
  const asyncMark = `async function ${name}(`;
  const syncMark = `function ${name}(`;
  let start = SOURCE.indexOf(asyncMark);
  if (start < 0) start = SOURCE.indexOf(syncMark);
  if (start < 0) throw new Error(`production function missing: ${name}`);
  let end = SOURCE.indexOf("\n}", start);
  // 逐行找到与该函数同级收尾的 "\n}"（函数体内嵌套 } 均带缩进）。
  let cursor = start;
  for (;;) {
    const next = SOURCE.indexOf("\n}", cursor + 1);
    if (next < 0) throw new Error(`unterminated slice: ${name}`);
    const after = SOURCE.slice(next + 2, next + 3);
    if (after === "\n" || after === "" || SOURCE.slice(next + 2, next + 4) === "\r\n") { end = next + 2; break; }
    cursor = next;
  }
  return SOURCE.slice(start, end);
}

function rangeSlice(startMark, endMark) {
  const start = SOURCE.indexOf(startMark);
  const end = SOURCE.indexOf(endMark, start + startMark.length);
  if (start < 0 || end < 0) throw new Error(`slice marks missing: ${startMark}`);
  return SOURCE.slice(start, end);
}

const COMMON_FUNCTIONS = [
  "partitionTransferPaths", "transferCompression", "requestedTransferCompression",
  "tarPackingCommand", "stagedTarUnpackingCommand", "directTarBatchCommand",
  "chunkTransferCommand", "compressionStreamCommand", "shellQuote", "stagedReceiverInvocation",
];
const TRANSFER_RANGE = rangeSlice("async function transferChunkedServerFile(", "async function syncServerToServerFpsync(");
const FPSYNC_RANGE = rangeSlice("async function syncServerToServerFpsyncCore(", "async function syncFromRemoteCore(");
const PROBE_RANGE = rangeSlice("async function negotiateTransferCompression(", "function tarPackingCommand(");
const REAL_BATCH_RANGE = rangeSlice("function remoteBatchStage(", "function hashQuiescenceHelpers(");
const MAPPED_CONSTANTS = rangeSlice("const MAPPED_DOWNLOAD_DEFAULT_MAX_FILE_BYTES", "function assertSafeScopedLocalPaths(");
const MAPPED_CHAIN = rangeSlice("let mappedDownloadTransport = null;", "function cleanupMappedStagingFiles(");
const MAPPED_TAIL = ["cleanupMappedStagingFiles", "mappedStagingPath", "openMappedStagingStream", "assertMappedAncestorChain", "createTarByteReader",
  "requireApiConfirmation", "buildApiConfirmationPreview", "isRememberedTransferPath", "transferPathConfirmationKey",
  "createTransferPreview", "appendProcessOutput", "formatProcessFailure", "getSshArgs", "toPosixPath", "transferTimeoutMs",
  "downloadScopeBlockedPath", "normalizeSshPort", "parseMappedTarHeader", "readTarField", "writeStreamChunk", "closeWriteStream"]
  .map(functionSlice);
const API_METHOD_SOURCE = (() => {
  const start = SOURCE.indexOf('"sync.downloadMappedPaths": async (params = {}) => {');
  const end = SOURCE.indexOf('"sync.planLogPaths"', start);
  if (start < 0 || end < 0) throw new Error("downloadMappedPaths api method slice missing");
  return SOURCE.slice(start + '"sync.downloadMappedPaths": '.length, end).replace(/,\s*$/, "");
})();
const REPO_ROOT = path.join(__dirname, "..", "..");
const POLICY = require(path.join(REPO_ROOT, "compression-policy"));

// options: { platform, batch(target,command,paths,timeout,transport), relay(...), controller,
//            outcomeUnknown, parallel, maxBatchBytes, fpsync:{ inspectSource, inspectDestination,
//            inspectScope, selectCompression, ensureAuth, syncTarget, timeoutMs, confirmation } }
function createTransferHarness(options = {}) {
  const platform = options.platform;
  if (platform !== "win32" && platform !== "darwin") throw new Error("夹具只覆盖 win32/darwin 分支事实");
  const leaseCalls = [];
  const fsync = options.fpsync || {};
  const mappedLease = { local: [], host: [], file: [] };
  const mappedEvents = [];
  const activeTransfers = new Map();
  const storeRef = { value: options.controller };
  let mappedSeq = 0;
  const sandbox = {
    require, fs, path, os, console, Buffer, JSON, Math, Number, String, Boolean, Array, Object, Set, Map, Symbol, Error,
    Date, Promise, RegExp, isNaN, parseInt, parseFloat, structuredClone, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, queueMicrotask,
    __dirname: path.join(__dirname, "..", ".."),
    process: { platform, arch: platform === "darwin" ? "arm64" : "x64", pid: 4242, hrtime: process.hrtime },
    crypto: require("node:crypto"),
    FPSYNC_PARALLEL_STREAMS: options.parallel == null ? 2 : options.parallel,
    FPSYNC_MAX_BATCH_BYTES: options.maxBatchBytes == null ? 512 * 1024 * 1024 : options.maxBatchBytes,
    transferContext: {
      getStore: () => storeRef.value,
      run: (controller, work) => {
        const previous = storeRef.value;
        storeRef.value = controller;
        try { return work(); } finally { storeRef.value = previous; }
      },
    },
    remoteTransferOutcomeUnknown: () => Boolean(options.outcomeUnknown),
    withFileResourceLease: (operation, project, paths, server, work) => {
      leaseCalls.push({ operation, project, server, count: (paths || []).length });
      return Promise.resolve().then(work);
    },
    remoteResourceServer: (sftp) => String(sftp.host).toLowerCase() + ":" + Number(sftp.port || 22),
    runRemoteBatchSsh: (...args) => options.batch
      ? Promise.resolve().then(() => options.batch(...args))
      : Promise.reject(new Error("batch transport not injected")),
    relayTarFilesCore: (...args) => options.relay
      ? Promise.resolve().then(() => options.relay(...args))
      : Promise.reject(new Error("relay not injected")),
    relayTarFiles: (...args) => sandbox.relayTarFilesCore(...args),
    formatError: (error) => String(error?.message || error || ""),
    ensureMacTransferAuthentication: fsync.ensureAuth || (async () => {}),
    directSyncTarget: fsync.syncTarget || ((value) => value),
    directSyncRelativePath: fsync.syncRelativePath || ((value) => String(value)),
    transferTimeoutMs: (_source, sourceOptions) => sourceOptions?.timeoutMs ?? (fsync.timeoutMs == null ? 120000 : fsync.timeoutMs),
    confirmationRequired: fsync.confirmation || ((detail) => Object.assign(new Error("CONFIRM_REQUIRED"), { apiCode: 2001, detail })),
    inspectRemoteBatchFiles: async (target, files, timeoutMs) => {
      if (!fsync.inspect) throw new Error("fpsync inspect not injected");
      const payload = await fsync.inspect(target, files, timeoutMs);
      return { cacheHits: 0, cacheRehash: 0, digestReads: 0, cacheQueries: 0, ...payload };
    },
    inspectRemoteScope: async (target, relativePath, directory, timeoutMs) => {
      if (!fsync.inspectScope) throw new Error("fpsync scope inspect not injected");
      const payload = await fsync.inspectScope(target, relativePath, directory, timeoutMs);
      return { cacheHits: 0, cacheRehash: 0, digestReads: 0, cacheQueries: 0, ...payload };
    },
    selectTransferCompression: fsync.selectCompression || (async () => ({ compression: options.compression || "gzip", reason: "harness", sampleBytes: 0 })),
    // 探针模式（options.probe）：切片真实 negotiate/select 链，闭包传输变量在沙箱内显式可见。
    compressionProbeTransport: null, remoteBatchTransport: null, mappedDownloadTransport: null,
    chooseSampleFiles: POLICY.chooseSampleFiles, chooseCompression: POLICY.chooseCompression,
    SAMPLE_TIMEOUT_MS: POLICY.SAMPLE_TIMEOUT_MS,
    compressionHistory: new POLICY.CompressionHistory(),
    compressionSampleScript: fs.readFileSync(path.join(REPO_ROOT, "compression-sample.py"), "utf8"),
    execSsh: () => { throw new Error("harness 不允许真实 execSsh"); },
    watchTransferProcess: () => { throw new Error("harness 不允许真实进程监视"); },
    // realBatch 模式：真实 runRemoteBatchSsh/remoteBatchStage/transferErrorLog 切片生效，
    // spawn 在调用时刻从宿主 child_process 解析（测试可注入子进程替身），spawnSsh/进程监视为显式替身。
    ...(options.realBatch ? {
      spawn: (...args) => require("node:child_process").spawn(...args),
      spawnSsh: (sftp, command, childOptions, launch, extra) =>
        (launch || sandbox.spawn)("ssh", Array.isArray(extra) ? extra.slice() : [], childOptions),
      watchTransferProcess: () => ({ receive() {} }),
    } : {}),
    // mapped 模式：真实映射下载编排/规范化/解包链切片；平台事实、工作区解析、租约、容量、
    // 传输注册表与事件总线都是沙箱内显式注入的可移植替身。
    ...(options.mapped ? {
      WSP: require(path.join(REPO_ROOT, "workspace-path.js")),
      localPathText: undefined, // 下方覆盖为 workspace-path.js 真实实现
      normalizeMacRelativePath: undefined,
      resolveLocalWorkspacePath: (value) => { mappedLease.local.push(value); return value; },
      withHostOperationLease: (actionType, actionLabel, localPath, operation) => {
        mappedLease.host.push({ actionType, actionLabel });
        return Promise.resolve().then(operation);
      },
      withFileResourceLease: (operation, project, paths, server, work) => {
        mappedLease.file.push({ operation, project, count: (paths || []).length });
        return Promise.resolve().then(work);
      },
      withTransferCapacity: (_options, work) => Promise.resolve().then(work),
      transferCapacity: { name: "transfer" }, memoryResultCapacity: { name: "memory" },
      apiTransferSftp: (params) => params.server ? { ...params.server, username: params.server.user, port: params.server.port || 22 } : {},
      publishLocalApiEvent: (type, data) => { mappedEvents.push({ type, data }); },
      extensionContext: { globalState: { get: (_key, fallback) => fallback } },
      PATH_CONFIRMATIONS_STATE: "simple-sftp-path-confirmations.v1",
      classifySftpFailure: (error) => error,
      createTransferController: (info) => {
        const id = info.id;
        const listeners = [];
        const record = { id, operationId: id, operation: info.operation, localPath: info.localPath, remotePath: info.remotePath, host: info.host, transferredBytes: 0 };
        activeTransfers.set(id, record);
        return {
          id, operationId: id, operation: info.operation,
          get transferredBytes() { return record.transferredBytes; },
          set transferredBytes(value) { record.transferredBytes = value; },
          set totalBytes(value) { record.totalBytes = value; },
          onCancel: (fn) => { listeners.push(fn); },
          dispose: () => { activeTransfers.delete(id); },
          __cancel: (reason) => listeners.forEach(fn => fn(reason)),
        };
      },
      nextTransferId: (operation) => `mapped-sandbox-${++mappedSeq}:${operation}`,
      trackTransferResource: () => {},
      listActiveTransfers: () => Array.from(activeTransfers.values()),
    } : {}),
  };
  if (options.mapped) {
    // 真实平台感知路径助手（同 Mac 生产分支），非替身。
    sandbox.localPathText = sandbox.WSP.localPathText;
    sandbox.normalizeMacRelativePath = sandbox.WSP.normalizeMacRelativePath;
  }
  vm.createContext(sandbox);
  const program = [
    options.realBatch ? REAL_BATCH_RANGE : "",
    options.mapped ? MAPPED_CONSTANTS : "",
    ...COMMON_FUNCTIONS.map(functionSlice),
    options.probe || options.mapped ? PROBE_RANGE : "",
    options.mapped ? MAPPED_TAIL.join("\n") : "",
    TRANSFER_RANGE,
    options.fpsync ? FPSYNC_RANGE : "",
    options.mapped ? MAPPED_CHAIN : "",
    options.mapped ? `this.downloadMappedPathsMethod = ${API_METHOD_SOURCE};` : "",
  ].join("\n");
  vm.runInContext(`${program}\nthis.transferPartitionedTar = transferPartitionedTar;`
    + (options.fpsync ? "this.syncServerToServerFpsyncCore = syncServerToServerFpsyncCore;" : "")
    + (options.mapped ? "this.setMappedDownloadTransport = setMappedDownloadTransport;"
      + "this.downloadMappedPaths = downloadMappedPaths;"
      + "this.normalizeMappedDownloadEntries = normalizeMappedDownloadEntries;"
      + "this.openMappedDownloadStream = openMappedDownloadStream;" : ""), sandbox, { filename: "extension-slice.js" });
  return { sandbox, leaseCalls, mappedLease, mappedEvents, activeTransfers };
}

module.exports = { createTransferHarness, functionSlice, rangeSlice };
