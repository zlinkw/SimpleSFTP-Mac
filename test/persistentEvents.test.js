const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { LocalApiServer } = require('../api-server');

test('default event stream stays open past 64 events; retained journal remains bounded', () => {
  const server = new LocalApiServer();
  const response = new EventEmitter();
  let writes = 0, ends = 0;
  response.writeHead = () => {};
  response.write = () => { writes++; return true; };
  response.end = () => { ends++; };
  server.streamEvents(new EventEmitter(), response, new URL('http://localhost/api/v1/events'));
  for (let i = 0; i < 200; i++) server.publish({ type: 'transfer', data: i });
  assert.equal(writes, 200);
  assert.equal(ends, 0);
  assert.equal(server.events.length, 128);
  assert.equal(server.sseTimeoutMs, 0);
  response.emit('close');
  assert.equal(server.listeners.size, 0);
  assert.equal(ends, 0);
});

test('explicit finite stream remains compatible during replay', () => {
  const server = new LocalApiServer({ maxEvents: 2 });
  server.publish({ type: 'one' }); server.publish({ type: 'two' });
  const response = new EventEmitter();
  response.writeHead = () => {}; response.write = () => true;
  let ended = false; response.end = () => { ended = true; };
  server.streamEvents(new EventEmitter(), response, new URL('http://localhost/api/v1/events'));
  assert.equal(ended, true);
  assert.equal(server.listeners.size, 0);
});
