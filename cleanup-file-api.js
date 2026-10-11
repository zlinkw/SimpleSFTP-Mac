"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { atomicWriteText } = require("./state-store");
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const copy = value => JSON.parse(JSON.stringify(value));
function fail(code, message = code) { const error = new Error(message); error.code = code; error.apiCode = code === "CONFIRM_REQUIRED" ? 2001 : 2010; error.apiData = { code }; throw error; }

/** A path capability authorizes one frozen batch, never a later or remembered path. */
class CleanupFileApi {
  constructor({ storageRoot, transport, activity, lease }) {
    this.storageRoot = storageRoot; this.transport = transport; this.activity = activity; this.lease = lease;
    this.previews = new Map(); this.busy = new Set();
  }
  async checked(request) {
    const value = await this.transport(copy(request));
    if (!value?.ok) fail(value?.error?.code || "UNVERIFIED_RESPONSE", value?.error?.message);
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
    for (const [token, preview] of this.previews) if (Date.now() > preview.expiresAt) this.previews.delete(token);
    if (this.previews.size >= 32) this.previews.delete(this.previews.keys().next().value);
    const { node, action = "move", targets } = params;
    if (!node?.root || !["move", "delete", "restore"].includes(action) || !Array.isArray(targets) || !targets.length || targets.length > 500) fail("INVALID_REQUEST");
    await this.activity(node);
    const rows = []; let identity;
    for (const target of targets) {
      if (!target || !["file", "directory"].includes(target.type)) fail("UNCERTAIN_TYPE");
      if (action === "restore" ? !target.relativePath?.startsWith("clean_dir/") || target.destination !== target.relativePath.slice(10)
        : target.destination !== "clean_dir/" + target.relativePath) fail("UNSAFE_DESTINATION");
      const result = await this.checked({ node, root: node.root, action: "inspect", archived: action === "restore", target });
      if (identity && hash(identity) !== hash(result.rootIdentity)) fail("ROOT_IDENTITY_CHANGED");
      identity = result.rootIdentity;
      rows.push({ ...copy(target), ...result.target, destination: target.destination });
    }
    const row = { token: crypto.randomBytes(24).toString("hex"), operationId: "cleanup-" + crypto.randomBytes(16).toString("hex"), node: copy(node), rootIdentity: identity,
      action, targets: rows, safety: { gitRepositoryAncestors: true, readOnlyReceiptCheck: true }, expiresAt: Date.now() + 30 * 60 * 1000, confirmations: 0, states: rows.map(row => row.missing ? "absent" : "pending") };
    row.digest = hash({ node: row.node, rootIdentity: identity, action, targets: rows, safety: row.safety });
    this.previews.set(row.token, copy(row)); // Preview does not write a journal or a remote hash cache.
    return copy(row);
  }
  async inspect(params) {
    if (!params.node?.root || !["file", "directory"].includes(params.target?.type)) fail("INVALID_REQUEST");
    return this.checked({ node: params.node, root: params.node.root, action: "inventory", target: params.target, allowMissing: params.allowMissing === true });
  }
  /** Read-only observation of a frozen receipt. Never settles audit state or starts a file operation. */
  async check(params) {
    const row = await this.read(params.token), index = params.index;
    if (!Number.isInteger(index) || !row.targets[index]) fail("INVALID_TARGET");
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
            const unchanged = await this.checked({ ...request, action: "inspect", archived: row.action === "restore" });
            if (unchanged.target.fingerprint !== request.target.fingerprint || hash(unchanged.rootIdentity) !== hash(row.rootIdentity)) fail("SOURCE_RECREATED_OR_CHANGED");
            row.states[index] = "pending"; await this.save(row);
          }
        }
        // Preflight the complete node batch again before the first mutation.
        for (let i = 0; i < row.targets.length; i++) {
          if (row.states[i] === "completed") continue;
          const result = await this.checked({ ...request, action: "inspect", archived: row.action === "restore", target: row.targets[i] });
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
  async status(params) { return this.read(params.token); }
  /** Settle an already-authorized receipt before coordinator preflight. Never starts a new move. */
  async settle(params) {
    const row = await this.read(params.token), index = params.index, target = row.targets[index];
    if (params.digest !== row.digest || !Number.isInteger(index) || !target || row.confirmations !== (row.action === "delete" ? 2 : 1)) fail("CONFIRM_REQUIRED");
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
        const unchanged = await this.checked({ ...request, action: "inspect", archived: row.action === "restore" });
        if (unchanged.target.fingerprint !== target.fingerprint || hash(unchanged.rootIdentity) !== hash(row.rootIdentity)) fail("SOURCE_RECREATED_OR_CHANGED");
        row.states[index] = "pending"; await this.save(row); return { ok: true, state: "pending" };
      });
    } finally { this.busy.delete(row.token); }
  }
  async verify(params) {
    const row = await this.read(params.token), target = row.targets[params.index];
    if (!target || row.states[params.index] !== "completed") fail("RECEIPT_UNVERIFIED");
    return this.checked({ node: row.node, root: row.node.root, rootIdentity: row.rootIdentity, target, action: "verify", deleted: row.action === "delete" });
  }
}
module.exports = { CleanupFileApi, fail, hash };
