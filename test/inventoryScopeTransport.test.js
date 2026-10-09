const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../extension.js'), 'utf8');
function fixture() {
  const calls = [];
  const context = {
    Buffer, JSON, Array, String,
    directSyncTarget: value => value, directSyncRelativePath: value => value,
    projectTreePathAllowed: () => true, projectInventoryScript: () => 'inventory-script',
    shellQuote: value => JSON.stringify(value), transferTimeoutMs: () => 1,
    runSsh: async (...args) => { calls.push({ kind: 'argv', args }); return JSON.stringify({ files: {} }); },
    runRemoteBatchSsh: async (...args) => { calls.push({ kind: 'stdin', args }); return JSON.stringify({ files: {} }); },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function projectInventory('), source.indexOf('async function projectFileStats(')) + ';this.run=projectInventory;', context);
  return { ...context, calls };
}
test('large exact scopes travel in bounded stdin and never enter the SSH command', async () => {
  const f = fixture();
  const paths = Array.from({ length: 5000 }, (_, i) => `outputs/run-${i}/result.csv`);
  await f.run({ source: { remotePath: '/project' }, relativePath: '.', scopePaths: paths, recursive: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].kind, 'stdin');
  assert.deepEqual(Array.from(f.calls[0].args[2]), paths);
  assert.ok(f.calls[0].args[1].length < 500);
  assert.equal(f.calls[0].args[4].remoteMutation, false);
});
test('oversized scopes reject before spawning and old unscoped inventory stays compatible', async () => {
  const f = fixture();
  await assert.rejects(f.run({ source: { remotePath: '/project' }, scopePaths: Array(5001).fill('a') }), /5000/);
  await assert.rejects(f.run({ source: { remotePath: '/project' }, scopePaths: ['x'.repeat(1048577)] }), /MiB|1048576/);
  assert.equal(f.calls.length, 0);
  await f.run({ source: { remotePath: '/project' }, relativePath: '.', recursive: false });
  assert.equal(f.calls[0].kind, 'argv');
});
