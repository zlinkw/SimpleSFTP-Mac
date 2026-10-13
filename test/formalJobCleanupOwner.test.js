const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const guard = path.resolve(__dirname, '../cleanup-files.py');
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'simple-formal-owner-readonly-')));
  const owner = { workflowId: 'workflow', commandId: 'command', globalJobId: 'workflow:1', index: 1, case: 'case', seed: 42,
    planRevision: 'a'.repeat(64), codeFingerprint: 'b'.repeat(64), outputDir: 'work_dirs/job', collectionResultCsv: 'tmp/result/job.csv',
    resultPathPolicy: 'declared', expectedState: 'failed', workerId: 'source-worker' };
  const record = { ...owner, schemaVersion: 1, state: 'failed', configHash: 'c'.repeat(64) };
  delete record.resultPathPolicy; delete record.expectedState; delete record.workerId;
  fs.mkdirSync(path.join(root, owner.outputDir), { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp/result'), { recursive: true });
  fs.writeFileSync(path.join(root, owner.outputDir, 'formal_job_owner.json'), JSON.stringify(record), 'utf8');
  fs.writeFileSync(path.join(root, owner.outputDir, 'failure.log'), 'original failure\n', 'utf8');
  fs.writeFileSync(path.join(root, owner.collectionResultCsv), 'partial\n', 'utf8');
  return { root, owner, record };
}
function inspect(f, type = 'directory', expectedOwner = f.owner) {
  const rel = type === 'directory' ? f.owner.outputDir : f.owner.collectionResultCsv;
  const proc = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-X', 'utf8', guard], {
    input: JSON.stringify({ root: f.root, action: 'inspect', target: { relativePath: rel, type, destination: 'clean_dir/' + rel, expectedOwner } }),
    encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(fs.existsSync(path.join(f.root, 'clean_dir')), false, 'preview must remain zero-write');
  return JSON.parse(proc.stdout);
}
test('formal directory and exact external CSV bind to complete owner identity without any attempt or writes', () => {
  const f = fixture();
  for (const type of ['directory', 'file']) {
    const report = inspect(f, type);
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.match(report.target.formalOwnerSha256, /^[a-f0-9]{64}$/);
    assert.match(report.target.fingerprint, /^[a-f0-9]{64}$/);
  }
  assert.equal(fs.readFileSync(path.join(f.root, f.owner.outputDir, 'failure.log'), 'utf8'), 'original failure\n');
});
test('foreign identity, active owner, unknown config and owner changes reject or invalidate fingerprints', () => {
  const f = fixture();
  const before = inspect(f, 'file');
  assert.equal(inspect(f, 'directory', { ...f.owner, commandId: 'foreign' }).error.code, 'FORMAL_JOB_OWNER_MISMATCH');
  for (const change of [{ state: 'running' }, { configHash: '' }, { globalJobId: 'other:1' }, { index: true }, { schemaVersion: true }]) {
    fs.writeFileSync(path.join(f.root, f.owner.outputDir, 'formal_job_owner.json'), JSON.stringify({ ...f.record, ...change }), 'utf8');
    assert.equal(inspect(f).ok, false, JSON.stringify(change));
  }
  fs.writeFileSync(path.join(f.root, f.owner.outputDir, 'formal_job_owner.json'), JSON.stringify({ ...f.record, extraAudit: 'changed' }), 'utf8');
  assert.notEqual(inspect(f, 'file').target.fingerprint, before.target.fingerprint);
});
test('read-only receipt checks accept the frozen formal owner and invalidate changes without any mutation', () => {
  const f = fixture(), report = inspect(f, 'file');
  const target = { ...report.target, type: 'file', relativePath: f.owner.collectionResultCsv,
    destination: 'clean_dir/' + f.owner.collectionResultCsv, expectedOwner: f.owner };
  const request = { root: f.root, rootIdentity: report.rootIdentity, action: 'check', target };
  const check = () => {
    const proc = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-X', 'utf8', guard], {
      input: JSON.stringify(request), encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(proc.status, 0, proc.stderr);
    return JSON.parse(proc.stdout);
  };
  assert.equal(check().state, 'pending');
  fs.writeFileSync(path.join(f.root, f.owner.outputDir, 'formal_job_owner.json'), JSON.stringify({ ...f.record, audit: 'new' }), 'utf8');
  assert.equal(check().error.code, 'SOURCE_RECREATED_OR_CHANGED');
  assert.equal(fs.existsSync(path.join(f.root, 'clean_dir')), false);
});
test('file API freezes a declared archive batch in its read-only preview and rejects traversal or changed layout', async () => {
  const f = fixture(), { CleanupFileApi } = require('../cleanup-file-api');
  const api = new CleanupFileApi({ storageRoot: f.root, activity: async () => {}, lease: async () => { throw Error('no execution authorized'); },
    transport: async request => {
      const proc = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-X', 'utf8', guard], {
        input: JSON.stringify(request), encoding: 'utf8', timeout: 10000, windowsHide: true });
      assert.equal(proc.status, 0, proc.stderr); return JSON.parse(proc.stdout);
    } });
  const batch = 'job-' + 'a'.repeat(48), target = { relativePath: f.owner.outputDir, type: 'directory', archiveBatch: batch,
    destination: 'clean_dir/' + batch + '/' + f.owner.outputDir, expectedOwner: f.owner };
  const params = { node: { id: 'local', kind: 'local', root: f.root }, targets: [target] };
  const preview = await api.preview(params);
  assert.equal(preview.targets[0].archiveBatch, batch);
  assert.equal(preview.targets[0].destination, target.destination);
  assert.equal(preview.safety.immutableArchiveBatch, true);
  await assert.rejects(api.preview({ ...params, targets: [{ ...target, archiveBatch: '../escape' }] }), /UNSAFE_ARCHIVE_BATCH/);
  await assert.rejects(api.preview({ ...params, targets: [{ ...target, destination: 'clean_dir/other/' + target.relativePath }] }), /UNSAFE_DESTINATION/);
  assert.equal(fs.existsSync(path.join(f.root, 'clean_dir')), false);
});
