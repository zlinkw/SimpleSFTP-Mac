const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ResourceOperationLeaseManager } = require('../resource-operation-lease');
test('paired updater blocks new SFTP transfers while existing owners finish', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-update-drain-')), leasePath = path.join(root, 'lease.json');
  const manager = new ResourceOperationLeaseManager({ leasePath, windowId: os.hostname() + ':' + process.pid + ':test', ownerAlive: () => true });
  const input = { pluginId: 'simple-local.simple-sftp-mac', workspaceUri: 'file://' + root, hostProjectPath: root, actionType: 'transfer' };
  const lease = await manager.acquire(input);
  try {
    fs.writeFileSync(leasePath, JSON.stringify({ actionType: 'mac-preview-update', expiresAt: new Date(Date.now() + 30000).toISOString() }), 'utf8');
    await lease.assertHeld(); await assert.rejects(manager.acquire(input), /全局锁/);
  } finally { await lease.release(); }
});
test('other legacy locks and invalid resource owners remain blocked', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-update-owner-')), leasePath = path.join(root, 'lease.json');
  const manager = new ResourceOperationLeaseManager({ leasePath, windowId: os.hostname() + ':' + process.pid + ':test', ownerAlive: () => true });
  const input = { pluginId: 'simple-local.simple-sftp-mac', workspaceUri: 'file://' + root, hostProjectPath: root, actionType: 'transfer' };
  const lease = await manager.acquire(input);
  try {
    fs.writeFileSync(leasePath, JSON.stringify({ actionType: 'other-operation', expiresAt: new Date(Date.now() + 30000).toISOString() }), 'utf8');
    await assert.rejects(lease.assertHeld(), /全局锁/);
    fs.writeFileSync(leasePath, JSON.stringify({ actionType: 'mac-preview-update', expiresAt: new Date(Date.now() + 30000).toISOString() }), 'utf8');
    fs.writeFileSync(lease.record.resourceFile, JSON.stringify({ windowId: 'foreign', leases: [] }), 'utf8');
    await assert.rejects(lease.assertHeld(), /持有证明/);
  } finally { await lease.release(); }
});
