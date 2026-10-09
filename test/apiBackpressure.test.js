const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { LocalApiServer } = require("../api-server.js");

class FakeRequest extends EventEmitter {}

class FakeResponse extends EventEmitter {
  constructor({ backpressure = true, throwOnWrite = false } = {}) {
    super();
    this.backpressure = backpressure;
    this.throwOnWrite = throwOnWrite;
    this.writableLength = 0;
    this.writableEnded = false;
    this.destroyed = false;
    this.statusCode = 0;
    this.frames = [];
    this.headers = {};
  }

  writeHead(status, headers = {}) {
    this.statusCode = status;
    this.headers = headers;
  }

  write(frame) {
    if (this.throwOnWrite) throw new Error("peer closed");
    const text = String(frame);
    this.frames.push(text);
    this.writableLength += Buffer.byteLength(text, "utf8");
    return !this.backpressure;
  }

  end(frame) {
    if (frame !== undefined) this.write(frame);
    this.writableEnded = true;
    this.emit("close");
  }
}

function openStream(server, since = 0) {
  const request = new FakeRequest();
  const response = new FakeResponse();
  server.streamEvents(request, response, new URL(`http://127.0.0.1/api/v1/events?since=${since}`));
  return { request, response };
}
test("event cap waits for buffered replay to drain", async () => {
  const server = new LocalApiServer({ maxEvents: 2 });
  server.publish({ type: "progress", data: 1 }); server.publish({ type: "progress", data: 2 });
  const stream = openStream(server);
  assert.equal(stream.response.frames.length, 1); assert.equal(stream.response.writableEnded, false);
  stream.response.writableLength = 0; stream.response.backpressure = false; stream.response.emit("drain");
  assert.equal(stream.response.frames.length, 2); assert.equal(stream.response.writableEnded, true);
  await server.dispose();
});

test("SSE pauses writes, drains queued frames, and emits snapshot gap at bounded overrun", async () => {
  const server = new LocalApiServer({ name: "test", version: "1", token: "t", maxSsePendingBytes: 512, sseTimeoutMs: 5000 });
  const stream = openStream(server);
  try {
    server.publish({ type: "progress", data: { value: 1 } });
    server.publish({ type: "progress", data: { value: 2 } });
    assert.equal(stream.response.frames.length, 1);
    assert.equal(server.listeners.size, 1);
    stream.response.writableLength = 0;
    stream.response.backpressure = false;
    stream.response.emit("drain");
    assert.equal(stream.response.frames.length, 2);
    assert.match(stream.response.frames[1], /"value":2/);

    for (let index = 0; index < 12; index += 1) {
      server.publish({ type: "progress", data: { text: "x".repeat(96), index } });
      if (stream.response.writableEnded) break;
    }
    assert.equal(stream.response.writableEnded, true);
    assert.ok(stream.response.frames.some((frame) => frame.includes('"code":"journal_gap"') && frame.includes('"snapshotRequired":true')));
    assert.ok(stream.response.writableLength <= server.maxSsePendingBytes);
    assert.equal(server.listeners.size, 0);
  } finally {
    await server.dispose();
  }
});

test("SSE subscriber count and replay history are bounded", async () => {
  const server = new LocalApiServer({ name: "test", version: "1", token: "t", maxSseClients: 1, maxEventBufferBytes: 1024, sseTimeoutMs: 5000 });
  try {
    const first = openStream(server);
    const second = openStream(server);
    assert.equal(second.response.statusCode, 200);
    assert.equal(second.response.writableEnded, true);
    assert.ok(second.response.frames.some((frame) => frame.includes('"reason":"subscriber_limit"') && frame.includes('"snapshotRequired":true')));
    first.request.emit("aborted");
    assert.equal(server.listeners.size, 0);

    for (let index = 0; index < 20; index += 1) server.publish({ type: "history", data: { text: "h".repeat(150), index } });
    assert.ok(server.events.length < 20);
    assert.ok(server.eventBufferBytes <= server.maxEventBufferBytes);

    const replay = openStream(server, 0);
    assert.equal(replay.response.writableEnded, true);
    assert.ok(replay.response.frames.some((frame) => frame.includes('"code":"journal_gap"')));
  } finally {
    await server.dispose();
  }
});

test("disconnected SSE peer cannot break event publication", async () => {
  const server = new LocalApiServer({ name: "test", version: "1", token: "t", sseTimeoutMs: 5000 });
  const request = new FakeRequest();
  const response = new FakeResponse({ throwOnWrite: true });
  server.streamEvents(request, response, new URL("http://127.0.0.1/api/v1/events"));
  try {
    assert.doesNotThrow(() => server.publish({ type: "progress", data: { value: 1 } }));
    assert.equal(server.listeners.size, 0);
    assert.equal(server.sseClosers.size, 0);
  } finally {
    await server.dispose();
  }
});
