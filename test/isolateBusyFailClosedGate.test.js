const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), Module = require("node:module");
// 安全决定（2026-10-21 返修）：受控隔离的在途写检查保持保守失败关闭——任何非只读在途传输存在即拒绝
// 隔离预览/执行，绝不按“host 字符串不同/路径词法不相交”放行：
// · 真实 API controller 只记录 params.source?.host||params.host（extension.js 生产事实），
//   sync.serverToServer 等写目的端可与记录端点不同；不同 DNS/IP 也可能是同机/共享存储；
// · 同端点下 symlink/.. /挂载别名可把词法不同路径映射到同一物理子树；
// · 预览→执行之间的新写入必须被执行阶段再检查拦住（检查-变更不原子，任何“先放行”都不成立）。
// 本回归用真实注册链（vscode stub + 真实扩展加载）+ 真实 CleanupFileApi + 真实生产守卫驱动；
// 传输行由真实 API 参数形状按生产同一提取式生成。不连任何真实主机；断言拒绝时零写入调用。
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
const ext = require("../extension.js");
restore();
const { __test } = ext;
const { CleanupFileApi } = require("../cleanup-file-api.js");
const extensionSource = fs.readFileSync(path.resolve(__dirname, "../extension.js"), "utf8");

// 生产事实钉：controller 的 host 提取式与保守守卫结构必须保持；快路径词法放行不得以任何形式回来。
test("production facts: host extraction stays source-first and the lexical fast path stays absent", () => {
  assert.match(extensionSource, /host: params\.source\?\.host \|\| params\.host \|\| ""/, "真实 API 行只记录 source/host 之一，必须保持为失败关闭的前提");
  assert.ok(!/rowHost\s*!==\s*nodeHost/.test(extensionSource), "禁止按 host 字符串不同直接放行");
  assert.ok(!/isolateActivityBlockedRows/.test(extensionSource), "禁止路径词法不相交的隔离快路径");
  assert.ok(!/isolateActivityBlockedRows/.test(fs.readFileSync(path.resolve(__dirname, "../cleanup-file-api.js"), "utf8")));
});

const identity = root => { const tag = crypto.createHash("sha256").update(String(root)).digest("hex").slice(0, 8); return { dev: "d" + tag, ino: "r" + tag, path: String(root) }; };
const shape = (root, target) => ({ relativePath: target.relativePath, type: target.type, absolutePath: String(root) + "/" + target.relativePath,
  fingerprint: "fp-" + String(root).length + "-" + target.relativePath, device: "dev-" + String(root).length, inode: "ino-" + target.relativePath.length,
  size: 4096, inventory: [], archived: false });
const receipt = (root, target) => ({ relativePath: target.relativePath, destination: target.destination, moved: true, absolutePath: String(root) + "/" + target.destination, metrics: {} });
const idleLease = async (_node, _targets, work) => work();
const rows = [];
function transfer(row) { const controller = __test.createTransferController(row); rows.push(controller); return controller; }
function settleAll() { for (const row of rows.splice(0)) { try { row.status = "completed"; } catch {} } }
test.afterEach(settleAll);
// 生产同一提取式：真实 API 参数 → controller 行（host 取 source?.host||host，remotePath 取顶层）。
function transferFromApiParams(name, params, remoteMutation) {
  return transfer({ id: name + "#params", operation: name, localPath: params.localPath || params.localBase || "",
    remotePath: params.remotePath || "", host: params.source?.host || params.host || "", observeOnlyIdle: true,
    readObserver: false, remoteMutation: remoteMutation === true });
}

function fixture() {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "iso-failclosed-"));
  const consumerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "iso-failclosed-project-"));
  const state = { consumerRoot, calls: [], mutations: 0, checkState: "pending", startGate: Promise.resolve() };
  const transport = async request => {
    const action = String(request.action || ""); const root = request.root; state.calls.push(action);
    if (action === "inspect") return { ok: true, rootIdentity: identity(root), target: shape(root, request.target) };
    // 与真实链一致：隔离写入发生前观测必须还是 pending——execute 的 activity 门只在 pending 分支被触达。
    if (action === "managed-observe") { const st = state.mutations > 0 ? "completed" : "pending";
      return Object.assign({ ok: true, rootIdentity: identity(root), state: st }, st === "completed" ? { receipt: receipt(root, request.target) } : {}); }
    if (action === "managed-start" || action === "isolate" || action === "move") { state.mutations += 1; await state.startGate;
      return { ok: true, rootIdentity: identity(root), receipt: receipt(root, request.target) }; }
    if (action === "check") return { ok: true, rootIdentity: identity(root), state: state.checkState };
    return { ok: false, error: { code: "FIXTURE_REFUSES_" + action.toUpperCase().replace(/-/g, "_") } };
  };
  const api = new CleanupFileApi({ storageRoot, transport, lease: idleLease,
    // 与生产接线同形透传全部实参：基线只传 node；任何“缩锁”变种的 gate 也必须抵达守卫，
    // 否则行为用例无法证明守卫面对的是真实调用形状。
    activity: async (...args) => { __test.cleanupActivityGuard(undefined, args[1] ?? null); } });
  __test.setTransferSettlementTestContext({ cleanupApi: api, globalState: { get: (_k, d) => d, update: async () => {} }, instanceId: "iso-failclosed-test" });
  state.methods = __test.createLocalApiMethods();
  return state;
}
const NODES = {
  nwpu3: { id: "nwpu3", kind: "worker", host: "nwpu3.invalid", port: 22, user: "u", root: "/srv/nwpu3.invalid/proj", projectPath: "/srv/nwpu3.invalid/proj" },
  jqg: { id: "jqg", kind: "worker", host: "jqg.invalid", port: 22, user: "u", root: "/srv/jqg.invalid/proj", projectPath: "/srv/jqg.invalid/proj" },
  win: { id: "local", kind: "local", root: "D:/GitRepo/MultiModal/proj", projectPath: "D:/GitRepo/MultiModal/proj" },
};
const nodeFor = id => Object.assign({}, NODES[id]);
function isolateTarget(node, relativePath) {
  const archiveBatch = "job-" + crypto.createHash("sha256").update(node.root + "|" + relativePath).digest("hex").slice(0, 48);
  return { relativePath, type: "directory", destination: "clean_dir/" + archiveBatch + "/" + relativePath, archiveBatch };
}
async function previewIsolate(state, nodeId, relativePath) {
  const node = nodeFor(nodeId); const target = isolateTarget(node, relativePath);
  const preview = await state.methods["files.cleanup.preview"]({ consumerRoot: state.consumerRoot, node, action: "isolate", observationMode: "managed_tmux", targets: [target] });
  const approved = { consumerRoot: state.consumerRoot, token: preview.token, digest: preview.digest, index: 0 };
  await state.methods["files.cleanup.confirm"](Object.assign({}, approved, { phase: 1, confirm: true, exactTargets: [preview.targets[0].absolutePath] }));
  return Object.assign({ node }, approved);
}

test("serverToServer 参数形状（记录 source 端点、写目的端另一台）必须拒绝目的端隔离：host 记录根本不可证", async () => {
  const state = fixture();
  const node = NODES.nwpu3;
  // 真实 sync.serverToServer 参数：写目的端 params.host=目的节点，但行 host 取 params.source.host（生产表达式）。
  const params = { source: { id: "a", host: "A.internal", remotePath: "/srv/A/proj/work/job9/data.bin", port: 22, username: "u" },
    host: node.host, remotePath: node.root + "/work/job0/data.bin" };
  transferFromApiParams("sync.serverToServer", params, true);
  await assert.rejects(() => previewIsolate(state, "nwpu3", "work/job0"), /ACTIVE_TRANSFER/);
  assert.equal(state.mutations, 0, "拒绝必须发生在任何写入调用之前");
});
test("host 别名指向同一物理机（字符串不同）必须拒绝：DNS/IP 不同不代表不同机器", async () => {
  const state = fixture();
  const node = NODES.nwpu3;
  transferFromApiParams("upload.files", { localPath: "D:/x", remotePath: node.root + "/work/other/data.bin",
    host: "nwpu3-alias.internal" }, true);
  await assert.rejects(() => previewIsolate(state, "nwpu3", "work/job0"), /ACTIVE_TRANSFER/);
  assert.equal(state.mutations, 0);
});
test("共享根/挂载别名（同端点、词法不同路径可能同一物理子树）必须拒绝：词法比较不是物理证明", async () => {
  const state = fixture();
  const node = NODES.nwpu3;
  for (const p of ["/mnt/shared-nwpu3/job0-copy", node.root + "/work/../work/job0/data.bin", node.root + "/./work/job0"]) {
    const row = fixture();
    transferFromApiParams("upload.files", { localPath: "D:/x", remotePath: p, host: node.host }, true);
    await assert.rejects(() => previewIsolate(row, "nwpu3", "work/job0"), /ACTIVE_TRANSFER/, "词法变体必须拒：" + p);
    assert.equal(row.mutations, 0);
  }
});
test("预览后、执行前出现的新写入必须被执行阶段再检查拒绝（检查-变更不原子）", async () => {
  const state = fixture();
  const job = await previewIsolate(state, "nwpu3", "work/job0"); // 预览时空闲
  transferFromApiParams("upload.files", { localPath: "D:/x", remotePath: NODES.nwpu3.root + "/work/other/data.bin",
    host: NODES.nwpu3.host }, true);
  await assert.rejects(() => state.methods["files.cleanup.execute"](job), /ACTIVE_TRANSFER/);
  assert.equal(state.mutations, 0, "被拒执行不得触达任何写入");
});
test("缺 host 或缺路径的在途行无法证明端点与写集，必须拒绝", async () => {
  for (const bad of [
    { localPath: "D:/x", remotePath: NODES.nwpu3.root + "/work/other", host: "" },
    { localPath: "", remotePath: "", host: NODES.nwpu3.host },
  ]) {
    const state = fixture();
    transferFromApiParams("upload.files", bad, true);
    await assert.rejects(() => previewIsolate(state, "nwpu3", "work/job0"), /ACTIVE_TRANSFER/);
    assert.equal(state.mutations, 0);
  }
});
test("另一台非环回端点上的在途写也必须拒绝（跨端点不可证同机，保守失败关闭）", async () => {
  const state = fixture();
  transferFromApiParams("upload.files", { localPath: "D:/x", remotePath: NODES.nwpu3.root + "/work/job9/data.bin",
    host: NODES.jqg.host }, true);
  await assert.rejects(() => previewIsolate(state, "nwpu3", "work/job0"), /ACTIVE_TRANSFER/);
  assert.equal(state.mutations, 0);
});
test("本机节点隔离同样保守：任何本机在途写句柄都拒绝", async () => {
  const state = fixture();
  transferFromApiParams("downloadMappedPaths", { localPath: "D:/GitRepo/MultiModal/proj/work/job0/part.pt", remotePath: "u@somewhere:/x", host: "somewhere.invalid" }, true);
  await assert.rejects(() => previewIsolate(state, "win", "work/job0"), /ACTIVE_TRANSFER/);
  assert.equal(state.mutations, 0);
});
test("纯只读观测行从不计入阻断（既有语义保持，非快路径）", async () => {
  const state = fixture();
  transfer({ id: "ro#1", operation: "sync.projectInventory", localPath: "D:/x", remotePath: NODES.nwpu3.root + "/work/job0/x",
    host: NODES.nwpu3.host, remoteMutation: false, readObserver: true });
  const job = await previewIsolate(state, "nwpu3", "work/job0");
  assert.ok(job.token, "只读观测不得把已确认链挡在预览外");
});
