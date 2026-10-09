const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { ProgressInactivity } = require('../progress-inactivity');
function fixture() {
  const source=fs.readFileSync(require.resolve('../extension.js'),'utf8');
  const start=source.indexOf('function createTransferController('), end=source.indexOf('function transferTimeoutMs(',start);
  const events=[];
  const context={ProgressInactivity,Date,Set,Object,Number,Math,queueMicrotask,
    transferContext:{getStore:()=>undefined},activeTransfers:new Map(),localApiServer:{publish:e=>events.push(e)}};
  vm.createContext(context);
  vm.runInContext(source.slice(start,end)+'; this.create=createTransferController; this.list=listActiveTransfers;',context);
  return {...context,events};
}
test('transfer list and events expose true counters and phases; cancellation reaches listeners',()=>{
  const f=fixture();const c=f.create({id:'t',operation:'upload'});let cancels=0;
  c.onCancel(()=>cancels++);
  c.transferredBytes=100;
  c.updateProgress({phase:'unpacking',processedFiles:2});
  const row=f.list()[0];
  assert.equal(row.processedBytes,100); assert.equal(row.processedFiles,2);
  assert.equal(row.phase,'unpacking'); assert.ok(row.lastProgressAt);
  const events=f.events.length;
  assert.equal(c.updateProgress({phase:'unpacking',processedFiles:2}),false);
  assert.equal(f.events.length,events);
  c.cancel('test'); assert.equal(cancels,1);
  c.transferredBytes=200;
  assert.equal(c.transferredBytes,100);
  assert.equal(c.updateProgress({status:'completed'}),false);
  c.dispose(); assert.equal(f.list().length,0);
});

test('parallel wire scopes aggregate once, hash bytes never inflate network totals',()=>{
  const f=fixture();const c=f.create({id:'t',operation:'sync'});
  c.updateProgress({phase:'transferring',metric:'wire',scope:'one',processedBytes:100});
  c.updateProgress({phase:'transferring',metric:'wire',scope:'two',processedBytes:50});
  c.updateProgress({phase:'transferring',metric:'wire',scope:'one',processedBytes:100});
  c.updateProgress({phase:'hashing',scope:'hash',processedBytes:9999,processedFiles:3});
  assert.equal(c.transferredBytes,150);
  assert.equal(f.list()[0].phase,'hashing');
  let notified=0;
  const subscription=c.onProgress(()=>notified++);
  c.updateProgress({phase:'publishing',scope:'receiver',processedFiles:1});
  assert.equal(notified,1);
  subscription.dispose();c.dispose();
});

test('hash diagnostics stay scoped while difference counts survive stream phase changes', () => {
  const f = fixture(); const c = f.create({id:'diagnostics',operation:'sync.serverToServerFpsync'});
  try {
    Object.assign(c, {unchangedFiles:4,missingFiles:1,differentFiles:1});
    c.updateProgress({phase:'hashing',scope:'source',processedFiles:6,cacheHits:5,cacheRehash:1,cacheStatus:'ready'});
    assert.equal(f.list()[0].cacheHits,5); assert.equal(f.events.at(-1).data.cacheStatus,'ready');
    c.updateProgress({phase:'hashing',scope:'destination',processedFiles:3,cacheHits:0,cacheRehash:3,cacheStatus:'write-failed'});
    assert.equal(f.list()[0].cacheHits,0); assert.equal(f.list()[0].cacheRehash,3);
    c.updateProgress({phase:'unpacking',processedBytes:100});
    assert.equal(f.list()[0].cacheHits,undefined); assert.equal(f.events.at(-1).data.cacheStatus,undefined);
    assert.equal(f.list()[0].unchangedFiles,4); assert.equal(f.list()[0].missingFiles,1); assert.equal(f.list()[0].differentFiles,1);
  } finally { c.dispose(); }
});

test('committed file progress survives parallel stage resets and is exposed to SSE and polling',()=>{
  const f=fixture();const c=f.create({id:'sync',operation:'sync.serverToServerFpsync'});
  try {
    c.updateProgress({phase:'transferring',scope:'groups',processedFiles:2,completedFiles:2,totalFiles:6,completedGroups:1,totalGroups:3});
    c.updateProgress({phase:'unpacking',scope:'child-b',processedFiles:0,processedBytes:1024});
    c.updateProgress({phase:'verifying',scope:'child-c',processedFiles:0,processedBytes:2048});
    let row=f.list()[0];
    assert.equal(row.processedFiles,0,'stage-local counts are kept separate');
    assert.equal(row.completedFiles,2);assert.equal(row.totalFiles,6);
    assert.equal(row.completedGroups,1);assert.equal(row.totalGroups,3);
    assert.equal(f.events.at(-1).data.completedFiles,2);
    c.updateProgress({phase:'transferring',scope:'groups',processedFiles:6,completedFiles:6,totalFiles:6,completedGroups:3,totalGroups:3});
    row=f.list()[0];assert.equal(row.completedFiles,6);assert.equal(row.completedGroups,3);
    c.updateProgress({phase:'unpacking',scope:'late-child',processedFiles:0,completedFiles:0,completedGroups:0,processedBytes:4096});
    assert.equal(f.list()[0].completedFiles,6,'late evidence must not reset committed totals');
  } finally {c.dispose();}
});
