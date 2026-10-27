"use strict";
const test = require('node:test'), assert = require('node:assert/strict');
const fsSync = require('node:fs'), fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const http = require('node:http');
const { CleanupFileApi, fail, transferBusySnapshot, busyEvidence } = require('../cleanup-file-api');
const { LocalApiServer } = require('../api-server');
// EOL 接线（2026-10-23 合流返修）：合并候选 extension.js 在 Windows 树上为 CRLF（与 LF 源候选仅行尾差异，内容逐字节一致），
// 下面的切片锚点以 \n\n 定界函数边界。按 LF 归一只影响行尾表示，不改变切片出的真实生产函数体，任何锚点/断言不放宽。
const source = fsSync.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8').replace(/\r\n/g, '\n');

// 这些切片取的是已发布 extension.js 里的真实生产函数体：测试不另写一份谓词替身。
/** 取 [startMarker, endMarker) 之间的真实生产源码；endMarker 属于后面的构造，一律排除。 */
function slice(startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, 'production source missing: ' + label);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, 'production source end missing: ' + label);
  return source.slice(start, end);
}
const strip = (text, label) => {
  const trimmed = text.replace(/[;,]\s*$/, '');
  assert.ok(/\}$/.test(trimmed), 'sliced source must end on a closing brace: ' + label);
  return trimmed;
};
const activitySource = strip(slice('activity: async () => {', '\n    lease: (node, targets, work)', 'CleanupFileApi activity guard').replace(/^activity: /, ''), 'activity guard');
const snapshotSource = slice('function currentTransferBusySnapshot(', '\n\nfunction currentTransferApiInstanceId', 'currentTransferBusySnapshot');
// 0.2.104 起 activity 只是转调真实的 cleanupActivityGuard；守卫本体也取自生产源码，测试不重写谓词。
const guardSource = strip(slice('function cleanupActivityGuard(', '\n\nfunction startLocalApiServer(', 'cleanupActivityGuard'), 'cleanupActivityGuard');
const enqueueSource = slice('function enqueueWorkspaceUpload(', '\n\nasync function uploadChangedLocalFiles(', 'enqueueWorkspaceUpload');
const listSource = strip(slice(String.fromCharCode(34) + 'transfers.list' + String.fromCharCode(34) + ': async () => {',
  ',\n    ' + String.fromCharCode(34) + 'transfers.reconcile', 'transfers.list handler')
  .replace(new RegExp('^' + String.fromCharCode(34) + 'transfers\\.list' + String.fromCharCode(34) + ': '), ''), 'transfers.list handler');

function productionGuard(env) {
  const collections = Object.assign({ activeTransfers: new Map(), activeUploadOperations: new Map(), uploadQueues: new Map(),
    currentTransferApiInstanceId: () => '50924:test-instance' }, env);
  const currentTransferBusySnapshot = new Function('activeTransfers', 'activeUploadOperations', 'uploadQueues', 'currentTransferApiInstanceId', 'transferBusySnapshot',
    snapshotSource + '\nreturn currentTransferBusySnapshot;')(collections.activeTransfers, collections.activeUploadOperations, collections.uploadQueues,
    collections.currentTransferApiInstanceId, transferBusySnapshot);
  // apiRouteController 在此固定 “无自身控制器”，等价于非 API 路由（如上传/下载）里的守卫调用。
  const cleanupActivityGuard = new Function('currentTransferBusySnapshot', 'cleanupFail', 'apiRouteController',
    guardSource + '\nreturn cleanupActivityGuard;')(currentTransferBusySnapshot, fail, { getStore: () => null });
  const activity = new Function('cleanupActivityGuard', 'return ' + activitySource)(cleanupActivityGuard);
  const transfersList = new Function('listTransferOperationState', 'listActiveTransfers', 'currentTransferBusySnapshot',
    'return ' + listSource)(async () => ({ instanceId: '50924:test-instance', operations: [], settledOperations: [] }), () => [], currentTransferBusySnapshot);
  return Object.assign(collections, { activity, transfersList, currentTransferBusySnapshot });
}
// 0.2.102 上线时的原始守卫表达式：作为逐值等价基线，不是被测实现。
const frozenPredicate = state => [...state.activeTransfers.values()].some(row => !['completed', 'failed', 'cancelled'].includes(row.status))
  || state.activeUploadOperations.size || state.uploadQueues.size;
const states = [
  { label: '全空闲', activeTransfers: new Map(), activeUploadOperations: new Map(), uploadQueues: new Map() },
  { label: '仅传输 uploading', activeTransfers: new Map([['t1', { id: 't1', status: 'uploading' }]]), activeUploadOperations: new Map(), uploadQueues: new Map() },
  { label: '仅传输全终态', activeTransfers: new Map([['t1', { id: 't1', status: 'completed' }], ['t2', { id: 't2', status: 'failed' }], ['t3', { id: 't3', status: 'cancelled' }]]), activeUploadOperations: new Map(), uploadQueues: new Map() },
  { label: '仅上传操作', activeTransfers: new Map(), activeUploadOperations: new Map([['op1', { id: 'op1', stage: 'acquiring-lease' }]]), uploadQueues: new Map() },
  { label: '仅保存时上传队列', activeTransfers: new Map(), activeUploadOperations: new Map(), uploadQueues: new Map([['d:/gitrepo/multimodal', Promise.resolve()]]) },
  { label: '未知状态传输', activeTransfers: new Map([['t1', { id: 't1', status: undefined }], ['t2', { id: 't2', status: 'stalled' }]]), activeUploadOperations: new Map(), uploadQueues: new Map() },
  { label: '空串状态传输', activeTransfers: new Map([['t1', { id: 't1', status: '' }]]), activeUploadOperations: new Map(), uploadQueues: new Map() },
  { label: '终态+队列混合', activeTransfers: new Map([['t1', { id: 't1', status: 'completed' }]]), activeUploadOperations: new Map(), uploadQueues: new Map([['/home/zlk/proj', Promise.resolve()]]) },
  { label: '三者同时', activeTransfers: new Map([['t1', { id: 't1', status: 'downloading', operation: 'sync.serverToServer', phase: 'verify' }]]),
    activeUploadOperations: new Map([['op1', { id: 'op1', stage: 'uploading' }]]), uploadQueues: new Map([['a', Promise.resolve()], ['b', Promise.resolve()]]) },
];
const mk = state => new Map(state.activeTransfers), mu = state => new Map(state.activeUploadOperations), mq = state => new Map(state.uploadQueues);

test('三个集合各自独立致 busy，且拒绝瞬间就带着同一份投影', async () => {
  for (const state of states) {
    if (!frozenPredicate(state)) continue;
    const guard = productionGuard({ activeTransfers: mk(state), activeUploadOperations: mu(state), uploadQueues: mq(state) });
    await assert.rejects(guard.activity(), error => {
      assert.equal(error.code, 'ACTIVE_TRANSFER', state.label);
      const busy = error.apiData && error.apiData.busy;
      assert.ok(busy && busy.schemaVersion === 1, state.label + ' 必须带快照');
      assert.equal(busy.busy, true, state.label);
      assert.equal(typeof busy.observedAt === 'string' && busy.observedAt.length > 0, true, state.label + ' 缺 observedAt');
      assert.equal(busy.instanceId, '50924:test-instance', state.label + ' 缺 instanceId');
      assert.equal(error.apiData.reason, undefined, '忙快照不得挤掉既有 reason/blockingPath 字段位');
      const expectedTransfers = [...state.activeTransfers.values()].filter(row => !['completed', 'failed', 'cancelled'].includes(row.status)).length;
      assert.equal(busy.activeTransferCount, expectedTransfers, state.label + ' 活跃传输计数');
      assert.equal(busy.uploadOperationCount, state.activeUploadOperations.size, state.label + ' 上传操作计数');
      assert.equal(busy.uploadQueueCount, state.uploadQueues.size, state.label + ' 排队队列计数');
      return true;
    }, state.label + ' 必须被守卫拒绝');
  }
});

test('守卫活跃条件与 0.2.102 逐项等价，不去掉进程级保护', async () => {
  for (const state of states) {
    const guard = productionGuard({ activeTransfers: mk(state), activeUploadOperations: mu(state), uploadQueues: mq(state) });
    let threw = null;
    try { await guard.activity(); } catch (error) { threw = error; }
    assert.equal(Boolean(threw), Boolean(frozenPredicate(state)), state.label + ' 与冻结谓词不一致');
    assert.equal(Boolean(guard.currentTransferBusySnapshot().busy), Boolean(frozenPredicate(state)), state.label + ' 投影与冻结谓词不一致');
  }
});

test('全部终态后守卫放行且投影为 idle；未知/空状态继续 fail-closed', async () => {
  const idle = productionGuard({ activeTransfers: new Map([['t1', { id: 't1', status: 'completed' }]]), activeUploadOperations: new Map(), uploadQueues: new Map() });
  await idle.activity();
  assert.deepEqual(await idle.transfersList().then(row => row.busy.activeTransferCount), 0);
  assert.equal((await idle.transfersList()).busy.busy, false);
  for (const status of [undefined, '', 'stalled', 'unknown', 'queued']) {
    const guard = productionGuard({ activeTransfers: new Map([['t1', { id: 't1', status }]]), activeUploadOperations: new Map(), uploadQueues: new Map() });
    await assert.rejects(guard.activity(), error => {
      const row = error.apiData.busy.activeTransfers[0];
      assert.equal(row.status, status || 'unknown', '状态 ' + JSON.stringify(status) + ' 必须原样标出而非冒充终态');
      return true;
    }, '未知状态 ' + JSON.stringify(status) + ' 必须继续当忙');
  }
});

test('排队 Promise 成功或失败都按原语义出队并保留后继（真实 enqueueWorkspaceUpload）', async () => {
  const uploadQueues = new Map(), warnings = [];
  // 真实 enqueueWorkspaceUpload 只引用 vscode/formatError，注入这两项即可原样跑生产函数体。
  const enqueue = new Function('uploadQueues', 'vscode', 'formatError', enqueueSource + '\nreturn enqueueWorkspaceUpload;')(uploadQueues,
    { window: { showWarningMessage: text => warnings.push(text) } }, error => String(error && error.message || error));
  const order = [];
  let secondRan = false;
  const workspace = 'D:\\GitRepo\\MultiModal';
  enqueue(workspace, async () => { order.push('first-start'); await null; throw new Error('上传失败'); });
  assert.equal(uploadQueues.size, 1, '排队期间队列必须存在（守卫据此当忙）');
  enqueue(workspace, async () => { order.push('second'); secondRan = true; });
  assert.equal(uploadQueues.size, 1, '同工作区仍是单条链，不得变成两个忙位');
  const guard = productionGuard({ activeTransfers: new Map(), activeUploadOperations: new Map(), uploadQueues });
  assert.equal(guard.currentTransferBusySnapshot().busy, true, '排队中的保存时上传必须让守卫当忙');
  for (let index = 0; index < 80 && (order.length < 2 || uploadQueues.size > 0); index++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(secondRan, '前序失败不得吞掉后继');
  assert.deepEqual(order, ['first-start', 'second'], '队列必须按入队顺序串行执行');
  assert.equal(uploadQueues.size, 0, '链结束后必须删除队列项，否则忙永不解除');
  assert.equal(guard.currentTransferBusySnapshot().busy, false, '出队后守卫必须放行');
  assert.equal(warnings.length, 1, '失败仍按原语义只提示一次，不多写不漏提示');
  const settled = new Promise(resolve => enqueue('/home/zlk/Other Project', async () => resolve('ok')));
  assert.equal(await settled, 'ok', '成功路径的返回值仍由任务自己决定');
  for (let index = 0; index < 80 && uploadQueues.size > 0; index++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(uploadQueues.size, 0, '成功也必须删除队列项');
});

test('拒绝瞬间的快照与之后集合变化区分开，事后空闲不得改写已发生的拒绝原因', async () => {
  const guard = productionGuard({ activeTransfers: new Map([['t9', { id: 't9', status: 'uploading', operation: 'upload.files', phase: 'transfer' }]]),
    activeUploadOperations: new Map(), uploadQueues: new Map() });
  const error = await guard.activity().then(() => null, reason => reason);
  guard.activeTransfers.clear();
  const later = await guard.transfersList();
  assert.equal(later.busy.busy, false, '之后确实空闲了');
  assert.equal(error.apiData.busy.activeTransferCount, 1, '错误里的快照必须仍是拒绝那一刻的');
  assert.deepEqual(error.apiData.busy.activeTransfers, [{ id: 't9', status: 'uploading', operation: 'upload.files', phase: 'transfer', readOnlyObserver: false, selfAttempt: false }]);
  assert.equal(error.apiData.busy.blockingTransferCount, 1, '未证明只读的传输必须计入阻断数量');
  assert.equal(Date.parse(error.apiData.busy.observedAt) <= Date.parse(later.busy.observedAt), true, '快照时间必须是不晚于后续观测的那一次');
  assert.notEqual(error.apiData.busy.busy, later.busy.busy, '同一实例的两次观测必须能分出当时忙与事后闲');
  assert.equal(error.apiData.busy.observedAt, error.apiData.busy.observedAt && guard.currentTransferBusySnapshot(error.apiData.busy.observedAt).observedAt,
    '投影可按显式时间复算，说明时间戳来自拒绝那一刻而非事后重取');
});

test('快照不含原始工作区路径、主机或令牌，只有一向哈希', async () => {
  const workspace = 'D:\\GitRepo\\MultiModal';
  const guard = productionGuard({ activeTransfers: new Map([['t1', { id: 't1', status: 'uploading', localPath: workspace, remotePath: '/mnt/nwpu3/zlk/MultiModal/work/job0',
    host: 'nwpu3.internal.example' }]]), activeUploadOperations: new Map([['op1', { id: 'op1', stage: 'acquiring-lease' }]]),
    uploadQueues: new Map([[workspace, Promise.resolve()], ['/home/zlk/Other Project', Promise.resolve()]]) });
  const error = await guard.activity().then(() => null, reason => reason);
  const text = JSON.stringify(error.apiData);
  for (const secret of ['MultiModal', 'GitRepo', 'nwpu3.internal', '/mnt/nwpu3', 'zlk/Other', 'D:'])
    assert.equal(text.includes(secret), false, '快照泄露敏感片段：' + secret);
  const hashes = error.apiData.busy.uploadQueues.keyHashes;
  assert.equal(hashes.length, 2);
  assert.ok(hashes.every(key => /^[0-9a-f]{12}$/.test(key)), '队列键必须只剩短哈希');
  assert.notEqual(hashes[0], hashes[1]);
  const again = guard.currentTransferBusySnapshot('2026-10-21T07:17:18.000Z');
  assert.deepEqual(again.uploadQueues.keyHashes, hashes, '同一工作区的哈希必须稳定可关联');
  assert.equal(guard.currentTransferBusySnapshot('2026-10-21T07:17:18.000Z').uploadQueues.count, 2);
});

test('忙快照只能是自己这份形状，任意对象不得借道进入错误详情', () => {
  const plain = (() => { try { fail('SOME_CODE'); } catch (error) { return error; } })();
  assert.equal('busy' in plain.apiData, false);
  const smuggled = (() => { try { fail('SOME_CODE', 'SOME_CODE', { busy: { schemaVersion: 1, evil: 'x', activeTransfers: [{ secret: 'D:/x', status: 'a'.repeat(500) }] } }); } catch (error) { return error; } })();
  assert.deepEqual(smuggled.apiData.busy.activeTransfers, [{ status: 'a'.repeat(40), readOnlyObserver: false, selfAttempt: false }], '未知字段必须被丢弃、字符串必须截断，只读与自身豁免标记只能是白名单布尔');
  assert.equal('evil' in smuggled.apiData.busy, false);
  assert.equal(busyEvidence({ schemaVersion: 2 }), undefined);
  const withReason = (() => { try { fail('ACTIVE_TRANSFER', 'ACTIVE_TRANSFER', { reason: '原原因', busy: transferBusySnapshot({ uploadQueueKeys: ['k'] }, { observedAt: '2026-10-21T07:17:18.000Z', instanceId: 'i' }) }); } catch (error) { return error; } })();
  assert.equal(withReason.apiData.reason, '原原因', '新增字段不得挤掉既有 reason/blockingPath');
  assert.equal(withReason.apiData.busy.uploadQueueCount, 1);
});

test('真实 CleanupFileApi 守卫经真实 API 封套抵达调用方，零租约零传输', async () => {
  const calls = [];
  const guard = productionGuard({ activeTransfers: new Map(), activeUploadOperations: new Map([['op1', { id: 'op1', stage: 'acquiring-lease' }]]), uploadQueues: new Map() });
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'busy-snapshot-'));
  const cleanupApi = new CleanupFileApi({ storageRoot,
    activity: () => guard.activity(),
    lease: async () => { calls.push('lease'); throw new Error('lease must not be reached'); },
    transport: async request => { calls.push('transport:' + request.action); throw new Error('transport must not be reached'); } });
  const server = new LocalApiServer({ name: 'Test', version: '0.2.102', preferredPort: 24766, discoveryPath: '', methodOptions: { 'files.cleanup.preview': { readOnly: true, zeroWrites: true } },
    methods: {
      'files.cleanup.preview': params => cleanupApi.preview(params),
      'transfers.list': () => guard.transfersList(),
    } });
  await server.start();
  try {
    const request = payload => new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const req = http.request({ host: '127.0.0.1', port: server.port, path: '/api/v1/rpc', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer ' + server.token } },
        res => { let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve(JSON.parse(text))); });
      req.on('error', reject); req.end(body);
    });
    const refused = await request({ jsonrpc: '2.0', id: 1, method: 'files.cleanup.preview',
      params: { consumerRoot: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'consumer-root-')), node: { kind: 'remote', root: '/mnt/nwpu3/zlk/MultiModal', host: 'h', port: 22, user: 'u' }, action: 'isolate',
        targets: [{ relativePath: 'work/job0', type: 'directory', destination: 'clean_dir/work/job0' }] } });
    assert.equal(refused.error.data.code, 'ACTIVE_TRANSFER');
    assert.equal(refused.error.code, 2010);
    assert.equal(refused.error.data.busy.uploadOperationCount, 1, '封套里必须带着“是上传操作在忙”这份具体证据');
    assert.deepEqual(refused.error.data.busy.uploadOperations, [{ id: 'op1', stage: 'acquiring-lease' }]);
    assert.equal(JSON.stringify(refused.error.data).includes('/mnt/nwpu3'), false, '错误封套不得带目标路径');
    const listed = await request({ jsonrpc: '2.0', id: 2, method: 'transfers.list', params: {} });
    assert.equal(listed.result.busy.busy, true);
    assert.deepEqual(Object.assign({}, listed.result.busy, { observedAt: null }), Object.assign({}, refused.error.data.busy, { observedAt: null }),
      '守卫与只读路由必须给出同一份投影');
    assert.deepEqual(calls, [], '只读路由与守卫都不得触达租约或传输');
    assert.deepEqual(await fs.readdir(storageRoot), [], '诊断不得留下任何文件');
  } finally { await server.dispose ? await server.dispose() : null; }
});

// rev19 边界修正：终态判定必须按 status 原值（0.2.102 的 includes(row.status) 是同值比较），
// 任何先文本化再判定的写法都会把 new String('completed')/自定义 toString 从忙漏成空闲。
const typeAnomalies = [
  ["new String('completed')", new String('completed')],
  ["自定义 toString 返回 completed", { toString: () => 'completed' }],
  ["数组状态 ['completed']", ['completed']],
  ["对象状态", { code: 'completed' }],
  ["数字 0", 0], ["NaN", NaN], ["布尔 true", true],
  ["大写 COMPLETED", 'COMPLETED'], ["带尾空格 completed ", 'completed '],
  ["null 状态", null], ["undefined 状态", undefined], ["Symbol 状态", Symbol('completed')],
];
test('终态判定按 status 原值：类型异常表全部 fail-closed，与 0.2.102 谓词逐值一致', async () => {
  for (const [label, status] of typeAnomalies) {
    const state = { activeTransfers: new Map([['t1', { id: 't1', status }]]), activeUploadOperations: new Map(), uploadQueues: new Map() };
    const guard = productionGuard({ activeTransfers: mk(state), activeUploadOperations: mu(state), uploadQueues: mq(state) });
    assert.equal(Boolean(frozenPredicate(state)), true, label + '：0.2.102 原版必须判忙');
    let refused = '';
    try { await guard.activity(); } catch (error) { refused = error.apiData && error.apiData.code; }
    const snapshot = guard.currentTransferBusySnapshot();
    assert.equal(refused, 'ACTIVE_TRANSFER', label + '：守卫必须仍按传输忙拒绝');
    assert.equal(snapshot.busy, true, label + '：投影必须 fail-closed 判忙');
    assert.equal(snapshot.activeTransferCount, 1, label + '：异常状态行仍是活跃传输');
    const reported = snapshot.activeTransfers[0] && snapshot.activeTransfers[0].status;
    assert.ok(!['completed', 'failed', 'cancelled'].includes(reported), label + '：异常类型不得被文本化成终态，实际=' + String(reported));
  }
});
test('维护事实：真实生产投影仅豁免登记过的隔离区维护行，真实写入仍计忙，证据行只在事实成立时携带标记', async () => {
  const maintenance = { id: 'm1', status: 'running', operation: 'files.cleanup.isolatedMaintenanceDelete', remoteMutation: true, maintenanceCleanup: true };
  const guard = productionGuard({ activeTransfers: new Map([['m1', maintenance]]), activeUploadOperations: new Map(), uploadQueues: new Map() });
  await guard.activity();
  const snapshot = guard.currentTransferBusySnapshot();
  assert.equal(snapshot.busy, false, '仅维护删除在途时清理准入必须放行');
  assert.equal(snapshot.activeTransferCount, 1, '维护那一条必须原样保留为事实');
  assert.equal(snapshot.blockingTransferCount, 0);
  assert.equal(snapshot.maintenanceTransferCount, 1);
  assert.deepEqual(snapshot.activeTransfers[0], { id: 'm1', status: 'running', operation: 'files.cleanup.isolatedMaintenanceDelete',
    readOnlyObserver: false, selfAttempt: false, maintenanceCleanup: true }, '证据行只在维护事实成立时多出这一个布尔键');
  const mixed = productionGuard({ activeTransfers: new Map([['m1', maintenance],
    ['u1', { id: 'u1', status: 'running', operation: 'upload.files', remoteMutation: true }]]), activeUploadOperations: new Map(), uploadQueues: new Map() });
  const error = await mixed.activity().then(() => null, reason => reason);
  assert.equal(error.code, 'ACTIVE_TRANSFER', '真实上传与维护行同在时必须仍被拦下');
  assert.equal(error.apiData.busy.blockingTransferCount, 1, '阻断计数只点名真实上传');
  assert.equal(error.apiData.busy.maintenanceTransferCount, 1);
  assert.deepEqual(error.apiData.busy.activeTransfers.map(row => Boolean(row.maintenanceCleanup)), [true, false],
    '非维护行的证据形状保持不变，不得多出任何键');
  for (const [label, row] of [
    ['缺维护标记', { id: 'x', status: 'running', operation: 'files.cleanup.isolatedMaintenanceDelete', remoteMutation: true }],
    ['标记非布尔', { id: 'x', status: 'running', operation: 'files.cleanup.isolatedMaintenanceDelete', remoteMutation: true, maintenanceCleanup: 'yes' }],
    ['缺远端变更事实', { id: 'x', status: 'running', remoteMutation: false, maintenanceCleanup: true }],
    ['同时声明只读观测的自相矛盾行', { id: 'x', status: 'running', readObserver: true, remoteMutation: true, maintenanceCleanup: true }],
  ]) {
    const g = productionGuard({ activeTransfers: new Map([['x', row]]), activeUploadOperations: new Map(), uploadQueues: new Map() });
    await assert.rejects(g.activity(), reason => reason.code === 'ACTIVE_TRANSFER' && reason.apiData.busy.maintenanceTransferCount === 0, label);
  }
});

test('toString 抛异常的行与队列键仍按原值计忙并原样以 ACTIVE_TRANSFER 拒绝，不换成其它错误码', async () => {
  const boom = { toString() { throw new Error('hostile toString'); } };
  const guard = productionGuard({ activeTransfers: new Map([['t1', { id: boom, status: boom }]]), activeUploadOperations: new Map(),
    uploadQueues: new Map([[boom, Promise.resolve()]]) });
  let code = '', evidence = null;
  try { await guard.activity(); } catch (error) { code = error.apiData && error.apiData.code; evidence = error.apiData && error.apiData.busy; }
  assert.equal(code, 'ACTIVE_TRANSFER', '守卫不得因外部 toString 抛错而换成别的错误码');
  assert.equal(evidence.busy, true); assert.equal(evidence.activeTransferCount, 1); assert.equal(evidence.uploadQueueCount, 1);
  assert.equal(evidence.activeTransfers[0].status, 'unknown');
  assert.match(evidence.uploadQueues.keyHashes[0], /^[0-9a-f]{12}$/, '无法文本化的键也要有稳定哈希');
  const listed = await guard.transfersList();
  assert.equal(listed.busy.busy, true, '只读路由与守卫必须同结论');
});
