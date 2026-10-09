const test = require("node:test");
const assert = require("node:assert/strict");
const { TransferCapacity } = require("../transfer-capacity");
const turn = () => new Promise(resolve => setImmediate(resolve));
test("two global streams and one per Worker preserve independent progress", async () => {
  const pool = new TransferCapacity(), releases = [], started = [];
  const work = key => pool.run([key], undefined, () => new Promise(resolve => { started.push(key); releases.push(resolve); }));
  const a = work("a"), blockedA = work("a"), b = work("b"), c = work("c");
  await turn(); assert.deepEqual(started, ["a", "b"]); assert.equal(pool.active, 2);
  releases[1](); await b; await turn(); assert.deepEqual(started, ["a", "b", "c"]);
  releases[0](); await a; await turn(); assert.equal(started[3], "a");
  releases[2](); releases[3](); await Promise.all([blockedA, c]); assert.equal(pool.active, 0);
});
test("pending cancellation releases its ticket without starting work", async () => {
  const pool = new TransferCapacity(), abort = new AbortController(); let release;
  const held = pool.run(["a"], undefined, () => new Promise(resolve => { release = resolve; }));
  const queued = pool.run(["a"], abort.signal, () => assert.fail("cancelled request started"));
  abort.abort(new Error("cancelled")); await assert.rejects(queued, /cancelled/);
  assert.equal(pool.pending.length, 0); release(); await held;
});
test("genuine nested transfers share capacity and failures release it", async () => {
  const pool = new TransferCapacity();
  await assert.rejects(pool.run(["a"], undefined, () => pool.run(["a"], undefined, async () => { throw new Error("failed"); })), /failed/);
  assert.equal(pool.active, 0); assert.equal(pool.workers.size, 0);
});
