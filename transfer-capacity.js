"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
class TransferCapacity {
  constructor({ concurrency = 2, maxPending = 64 } = {}) { this.context = new AsyncLocalStorage(); this.active = 0; this.workers = new Map(); this.pending = []; this.concurrency = concurrency; this.maxPending = maxPending; }
  run(keys, signal, work) {
    if (this.context.getStore()) return work();
    const unique = [...new Set(keys.length ? keys : ["unresolved-target"])];
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.pending.length >= this.maxPending) return Promise.reject(new Error("TRANSFER_CAPACITY_EXCEEDED"));
    return new Promise((resolve, reject) => {
      const row = { keys: unique, work, resolve, reject, signal };
      row.abort = () => {
        const index = this.pending.indexOf(row);
        if (index < 0) return;
        this.pending.splice(index, 1); signal.removeEventListener("abort", row.abort);
        reject(signal.reason || new Error("传输已取消")); this.drain();
      };
      signal?.addEventListener("abort", row.abort, { once: true });
      this.pending.push(row); this.drain();
    });
  }
  drain() {
    for (let i = 0; i < this.pending.length && this.active < this.concurrency;) {
      const row = this.pending[i];
      if (row.keys.some(key => this.workers.has(key))) { i++; continue; }
      this.pending.splice(i, 1); row.signal?.removeEventListener("abort", row.abort);
      this.active++; for (const key of row.keys) this.workers.set(key, true);
      const promise = this.context.run(true, async () => { row.signal?.throwIfAborted(); return row.work(); });
      const release = () => { this.active--; for (const key of row.keys) this.workers.delete(key); this.drain(); };
      promise.then(value => { release(); row.resolve(value); }, error => { release(); row.reject(error); });
    }
  }
}
module.exports = { TransferCapacity };
