"use strict";

// One active durable write and one replaceable snapshot, shared by all waiters.
class LatestSnapshotWriter {
  constructor(write) { this.write = write; this.active = undefined; this.pending = undefined; }
  enqueue(value) {
    this.pending = value;
    if (!this.active) {
      this.active = Promise.resolve().then(async () => {
        try {
          while (this.pending !== undefined) {
            const next = this.pending;
            this.pending = undefined;
            await this.write(next);
          }
        } finally { this.active = undefined; }
      });
    }
    return this.active;
  }
}
module.exports = { LatestSnapshotWriter };
