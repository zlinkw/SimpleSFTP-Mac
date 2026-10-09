const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const source = fs.readFileSync(require.resolve('../extension.js'), 'utf8');
function fixture(options = {}, names = [], fileStep = true) {
  const updates = [];
  const parent = { transferredBytes: 0, processedFiles: 0, onCancel: () => ({ dispose() {} }), updateProgress: value => updates.push(value) };
  const context = {
    Set, Date, Number, Math, Error,
    ProgressInactivity: class { update() {} dispose() {} },
    transferContext: { getStore: () => parent }, currentApiRequestContext: () => undefined, trackTransferResource() {},
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function watchTransferProcess('), source.indexOf('function runSsh(', source.indexOf('function watchTransferProcess('))) + ';this.watch=watchTransferProcess;', context);
  const child = new EventEmitter(); child.pid = 42; child.stderr = new PassThrough(); child.kill = () => {};
  const monitor = context.watch(child, () => {}, fileStep, names, false, options);
  return { updates, child, monitor };
}
test('control JSON is not transferred bytes and filename phase is explicit', () => {
  const f = fixture({ stdoutBytesArePayload: false, filenamePhase: 'verifying' }, ['a.csv']);
  f.monitor.receive(Buffer.from('{"files":{"a.csv":{"size":9000}}}'));
  assert.equal(f.updates.some(update => update.processedBytes > 0), false);
  f.child.stderr.write('a.csv\n');
  assert.equal(f.updates.at(-1).phase, 'verifying');
  f.child.emit('close');
});
test('incremental wire telemetry feeds true progress, duplicates and hash bytes stay separate', () => {
  const f = fixture({ stdoutBytesArePayload: false });
  f.child.stderr.write('SIMPLE_COMPRESSION_WIRE 1024\n');
  assert.equal(f.updates.at(-1).phase, 'transferring');
  assert.equal(f.updates.at(-1).metric, 'wire');
  assert.equal(f.updates.at(-1).processedBytes, 1024);
  const count = f.updates.length;
  f.child.stderr.write('SIMPLE_COMPRESSION_WIRE 1024\nSIMPLE_COMPRESSION_WIRE 5\n');
  assert.equal(f.updates.length, count);
  f.child.stderr.write('SIMPLE_PROGRESS {"phase":"verifying","processedBytes":8192}\n');
  assert.equal(f.updates.at(-1).metric, undefined);
  assert.equal(f.updates.at(-1).phase, 'verifying');
  f.child.emit('close');
});
test('wire scopes distinguish parallel streams while sharing one relay identity', () => {
  const f = fixture({ wireScope: 'relay-identity' });
  f.monitor.receive(Buffer.alloc(100));
  assert.equal(f.updates.at(-1).scope, 'relay-identity');
  assert.equal(f.updates.at(-1).metric, 'wire');
  f.child.emit('close');
});

test('hash cache telemetry travels with real progress but cannot become wire bytes or keepalive', () => {
  const f = fixture({ stdoutBytesArePayload: false });
  f.child.stderr.write('SIMPLE_PROGRESS {"phase":"hashing","cacheHits":50,"cacheRehash":2,"cacheStatus":"ready"}\n');
  assert.equal(f.updates.length, 0);
  f.child.stderr.write('SIMPLE_PROGRESS {"phase":"hashing","processedFiles":52,"processedBytes":4096,"cacheHits":50,"cacheRehash":2,"cacheStatus":"ready"}\n');
  assert.equal(f.updates.at(-1).cacheHits, 50); assert.equal(f.updates.at(-1).cacheRehash, 2);
  assert.equal(f.updates.at(-1).cacheStatus, 'ready'); assert.equal(f.updates.at(-1).metric, undefined);
  f.child.emit('close');
});
test('control response bytes and malformed progress cannot masquerade as transfer work', () => {
  const f = fixture({}, [], false);
  f.monitor.receive(Buffer.alloc(400));
  f.child.stderr.write('SIMPLE_PROGRESS {"phase":"arbitrary","processedBytes":50}\n');
  f.child.stderr.write('SIMPLE_PROGRESS {"phase":"hashing","processedBytes":-1}\n');
  f.child.stderr.write('SIMPLE_PROGRESS {"phase":"hashing","processedBytes":9007199254740992}\n');
  assert.equal(f.updates.length, 0);
  f.child.stderr.write('SIMPLE_PROGRESS {"phase":"hashing","processedBytes":512,"processedFiles":2,"metric":"wire"}\n');
  assert.equal(f.updates.at(-1).processedBytes, 512);
  assert.equal(f.updates.at(-1).metric, undefined);
  f.child.emit('close');
});

test('production wire counter forwards a short open pipe and reports bytes before EOF', async () => {
  let code;
  const context = { shellQuote: value => { code = value; return 'counter'; } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function compressionStreamCommand('), source.indexOf('function tarUnpackingCommand(')) + ';this.command=compressionStreamCommand;', context);
  context.command('none', true);
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-progress-evidence-'));
  const file = path.join(evidence, 'counter.py'); fs.writeFileSync(file, code, 'utf8');
  const child = spawn('python', ['-B', '-X', 'utf8', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let timer, output=Buffer.alloc(0), stderr='';
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    const observed = new Promise((resolve,reject) => {
      child.once('error',reject);
      child.stdout.on('data',chunk=>{output=Buffer.concat([output,chunk]);if(output.length===100 && /SIMPLE_COMPRESSION_WIRE 100/.test(stderr)) resolve();});
      child.stderr.on('data',chunk=>{stderr+=chunk.toString('utf8');if(output.length===100 && /SIMPLE_COMPRESSION_WIRE 100/.test(stderr)) resolve();});
      timer=setTimeout(()=>reject(new Error('wire counter buffered data until EOF')),2000);
    });
    child.stdin.write(Buffer.alloc(100,7));
    await observed;clearTimeout(timer);
    assert.deepEqual(output,Buffer.alloc(100,7));
    child.stdin.end();
    assert.equal(await closed,0);
  } finally {clearTimeout(timer);if(child.exitCode===null)child.kill();await closed;}
});
