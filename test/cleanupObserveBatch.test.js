const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const __CONSUMER__ = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'consumer-root-'));
const {spawnSync}=require('node:child_process');
const os=require('node:os');
// v1.10 contract tests for the public read-only recovery round
// files.cleanup.observeBatch (cleanup-file-api observeBatch + engine
// batch-observe): one caller round shares one engine sweep per batch, stays
// inside the caller's 1/2 read budget (instance cap 2), answers per contract
// key with CURRENT facts, refuses cross-node/root token reuse, and degrades
// missing, duplicated, reordered or failed answers to explicit unknowns -
// never to "gone". Pure fake transport plus the FakeOS engine fixture; no
// real deletion, no runner, nothing here authorizes execution.
const {CleanupFileApi}=require('../cleanup-file-api');
const IDENTITY={path:'/srv/proj',device:'7',inode:'100',machine:'host',user:'0'};
const JOB='clean_dir/job-'+('a'.repeat(48));
const NODE={kind:'local',root:'/srv/proj'};
const isoName=rel=>'iso_'+rel.slice('out/'.length);
const expanded=entries=>entries.reduce((sum,e)=>sum+(e.isolationRelativePath?2:1),0);
function harness(options={}){
  const calls=[],stats={observeRpcs:[],active:0,peak:0,per:{},perPeak:{}};
  const transport=async request=>{
    calls.push(request);
    if(request.action==='batch-inspect'){
      return {ok:true,rootIdentity:IDENTITY,metrics:{entryReads:request.targets.length},
        capabilities:{confirmedPathFastDelete:1,batchEntryInspect:1},
        targets:request.targets.map(t=>({relativePath:t.relativePath,type:t.type,absolutePath:'/srv/proj/'+t.relativePath,
          device:'7',inode:'2'+t.relativePath,
          ...(t.relativePath.startsWith(JOB+'/')?{archived:true}
            :t.type==='directory'?{isolationName:isoName(t.relativePath)}:{})}))};
    }
    if(request.action==='batch-observe'){
      if(request.entries.length>5000||expanded(request.entries)>5000)
        throw Object.assign(Error('FAST_BATCH_INVALID'),{code:'FAST_BATCH_INVALID'});
      if(request.observationId===undefined)throw Object.assign(Error('INVALID_REQUEST'),{code:'INVALID_REQUEST'});
      stats.observeRpcs.push(expanded(request.entries));
      const n = stats.observeRpcs.length; // fixed at entry: delayed batches keep their own round number
      const round=request.observationId;
      stats.active++;stats.peak=Math.max(stats.peak,stats.active);
      stats.per[round]=(stats.per[round]||0)+1;stats.perPeak[round]=Math.max(stats.perPeak[round]||0,stats.per[round]);
      try{
        if(options.delay)await new Promise(resolve=>setTimeout(resolve,10));
        if(options.observeFails&&options.observeFails(request,n))
          throw Object.assign(Error('OBSERVE_ROUND_FAILED'),{code:'OBSERVE_ROUND_FAILED'});
        if(options.identityDrift)return {ok:false,error:{code:'ROOT_IDENTITY_CHANGED'}};
        let rows=request.entries.map(e=>options.observe?options.observe(e,n):{key:e.key,status:'present',
          target:{missing:false,type:e.type,absolutePath:'/srv/proj/'+e.relativePath,device:e.device||'7',inode:e.inode||'9'+e.relativePath},
          executors:[],executorsChecked:true,
          ...(e.isolationRelativePath?{isolationStatus:'present',isolationChecked:true}:{})});
        if(options.dropRow)for(let k=rows.length-1;k>=0;k--)if(options.dropRow(rows[k]))rows.splice(k,1);
        if(options.duplicateRow){const dup=rows.find(options.duplicateRow);if(dup)rows.push({...dup});}
        if(options.shuffleRows)rows.reverse();
        return {ok:true,observationId:options.wrongRound?'other-round':request.observationId,
          rootIdentity:options.wrongIdentity&&n>1?{...IDENTITY,inode:'666'}:IDENTITY,
          capabilities:{batchCleanupObservation:1,maxTargets:5000},observations:rows,metrics:{}};
      } finally{ stats.active--; stats.per[round] -= 1; }
    }
    if(request.action==='inspect')
      return {ok:true,rootIdentity:IDENTITY,target:{type:request.target.type,absolutePath:'/srv/proj/'+request.target.relativePath,
        fingerprint:'top-'+request.target.relativePath,device:'7',inode:'2'+request.target.relativePath,fingerprintMode:'top_level',inventory:[]}};
    throw Object.assign(Error('UNEXPECTED_ACTION'),{code:'UNEXPECTED_ACTION'});
  };
  const storageRoot=fs.mkdtempSync(path.join(os.tmpdir(),'observe-batch-'));
  const api=new CleanupFileApi({storageRoot,transport,activity:async()=>({}),lease:async(n,t,run)=>run()});
  return {api,calls,stats,storageRoot};
}
const dirs=n=>Array.from({length:n},(_,i)=>({relativePath:'out/d'+i,type:'directory'}));
const residue=n=>dirs(n).map((t,i)=>({key:'k'+i,...t,isolationRelativePath:'out/iso_d'+i}));
async function confirmed(api,targets){
  const row=await api.preview({consumerRoot: __CONSUMER__, node:NODE,action:'delete',authorizationMode:'confirmed_paths',targets});
  const exact=row.targets.filter(t=>!t.missing).map(t=>t.absolutePath);
  await api.confirm({consumerRoot: __CONSUMER__, token:row.token,digest:row.digest,confirm:true,phase:1,exactTargets:exact});
  await api.confirm({consumerRoot: __CONSUMER__, token:row.token,digest:row.digest,confirm:true,phase:2,exactTargets:exact});
  return row;
}
const observe=(api,targets,options={})=>api.observeBatch({consumerRoot: __CONSUMER__, node:options.node||NODE,observationId:options.observationId||'round-1',
  readConcurrency:options.readConcurrency??2,...(options.rootIdentity===undefined?{}:{rootIdentity:options.rootIdentity}),targets});

test('one round answers 1200 residue dirs in ONE expanded batch with the contract echo',async()=>{
  const {api,calls,stats}=harness();
  const res=await observe(api,residue(1200),{observationId:'round-a'});
  assert.deepEqual(stats.observeRpcs,[2400],'original+isolation ride together, counted as expanded entries');
  assert.equal(calls.length,1,'1200 residue targets must never become per-file queries');
  assert.equal(res.observationId,'round-a');
  assert.deepEqual(res.capabilities,{batchCleanupObservation:1,maxTargets:5000});
  assert.deepEqual(res.rootIdentity,IDENTITY);
  assert.equal(res.observations.length,1200);
  const first=res.observations[0];
  assert.deepEqual({key:first.key,relativePath:first.relativePath,type:first.type,status:first.status},
    {key:'k0',relativePath:'out/d0',type:'directory',status:'present'});
  assert.equal(first.target.missing,false);assert.equal(first.executorsChecked,true);
  assert.deepEqual(first.isolationStatus,'present');assert.equal(first.isolationChecked,true);
  assert.equal(first.state,undefined,'no token means no claimed state');
  assert.ok(res.observations.every(o=>o.error===undefined));
});
test('5000/6200 grow in batches across requests, and 3000 isolation dirs pack expanded, never one RPC per file',async()=>{
  const files=n=>Array.from({length:n},(_,i)=>({key:'f'+i,relativePath:'out/f'+i+'.log',type:'file'}));
  const one=harness();
  await observe(one.api,files(5000)); // public cap: one request carries <=5000 original targets
  await assert.rejects(observe(one.api,files(6200)),/INVALID_REQUEST/,'6200 originals need two rounds, never one oversized RPC');
  await observe(one.api,files(1200));
  assert.deepEqual(one.stats.observeRpcs,[5000,1200],'the rounds keep growing bounded batch by batch');
  assert.ok(one.stats.peak<=2);
  const two=harness();
  await observe(two.api,residue(3000));
  assert.deepEqual(two.stats.observeRpcs,[5000,1000],'expanded 6000 -> [5000,1000], pairs never split');
  const three=harness();
  await observe(three.api,residue(5000));
  assert.deepEqual(three.stats.observeRpcs,[5000,5000],'5000 originals with twins split by EXPANDED entries');
});
test('read budget is honoured: peak 1 with readConcurrency=1, peak 2 with 2, instance-wide cap 2 across rounds',async()=>{
  const slow=harness({delay:true});
  await observe(slow.api,residue(3000),{readConcurrency:1});
  assert.equal(slow.stats.peak,1,'readConcurrency=1 keeps a single engine read in flight');
  const fast=harness({delay:true});
  await observe(fast.api,residue(3000),{readConcurrency:2});
  assert.ok(fast.stats.peak>=1&&fast.stats.peak<=2);
  const shared=harness({delay:true}); // two concurrent calls splitting the SAME global budget
  await Promise.all([observe(shared.api,residue(3000),{readConcurrency:2,observationId:'round-x'}),
    observe(shared.api,residue(3000),{readConcurrency:2,observationId:'round-y'})]);
  assert.equal(shared.stats.peak,2,'B API instance never exceeds two read-only requests in flight in total');
});
test('the next round re-queries the filesystem: fresh facts replace stale ones, nothing is cached',async()=>{
  let round=0;
  const {api,stats}=harness({observe:e=>{
    const present=round===0||e.key!=='k1';
    return {key:e.key,status:present?'present':'gone',
      target:present?{missing:false,type:e.type,absolutePath:'/srv/proj/'+e.relativePath,device:'7',inode:'9'+e.relativePath}
        :{missing:true,type:e.type,absolutePath:'/srv/proj/'+e.relativePath},
      executors:[],executorsChecked:true,...(e.isolationRelativePath?{isolationStatus:present?'present':'gone',isolationChecked:true}:{})};
  }});
  const first=await observe(api,residue(3));
  assert.ok(first.observations.every(o=>o.status==='present'));
  round=1;
  const second=await observe(api,residue(3));
  assert.equal(second.observations[1].status,'gone','the new round observes the new fact');
  assert.deepEqual(stats.observeRpcs,[6,6],'two rounds really issued two fresh requests');
});
test('backend tokens bind to the frozen target, node and root, and carry frozen identity plus the explicit isolation mapping',async()=>{
  const seen=[];
  const {api,calls}=harness({observe:e=>{seen.push(e);return {key:e.key,status:e.relativePath.includes('iso_')?'gone':'gone',
    target:{missing:true,type:e.type,absolutePath:'/srv/proj/'+e.relativePath},executors:[],executorsChecked:true,
    ...(e.isolationRelativePath?{isolationStatus:'gone',isolationChecked:true}:{})};}});
  const row=await confirmed(api,dirs(2)); // out/d0..d1 gain isolationName iso_dX in the frozen row
  const res=await observe(api,[
    {key:'a',relativePath:'out/d0',type:'directory',backendToken:row.token,backendIndex:0,device:'9',inode:'99'},
    {key:'b',relativePath:'out/d1',type:'directory',backendToken:row.token,backendIndex:1,isolationRelativePath:'elsewhere/wrong'},
    {key:'x',relativePath:'out/d0',type:'directory',backendToken:row.token,backendIndex:9},
    {key:'u',relativePath:'out/d0',type:'directory',backendToken:'f'.repeat(48),backendIndex:0},
  ]);
  const entry=seen.find(e=>e.key==='a');
  assert.equal(entry.device,'7');
  assert.equal(entry.inode,'2out/d0');
  assert.notEqual(entry.device,'9');
  assert.equal(entry.isolationRelativePath,'out/iso_d0','the frozen mapping is probed, never guessed');
  const byKey=Object.fromEntries(res.observations.map(o=>[o.key,o]));
  assert.equal(byKey.a.state,'completed','isolation gone + original gone settles the frozen entry as completed');
  assert.equal(byKey.b.error.code,'TOKEN_TARGET_MISMATCH','an isolation claim the row contradicts is refused, not probed');
  assert.equal(byKey.b.state,'unknown');
  assert.equal(byKey.x.error.code,'TOKEN_TARGET_MISMATCH');
  assert.equal(byKey.u.error.code,'LEGACY_IMPORT_UNBOUND','a cold token with no frozen digest reference stops at the owner contract; it never borrows facts');
  assert.ok(!seen.some(e=>['b','x','u'].includes(e.key)),'refused targets never ride the wire with wrong facts');
  // same token, different node / different root: refused per target
  const cross=await observe(api,[{key:'a',relativePath:'out/d0',type:'directory',backendToken:row.token,backendIndex:0}],
    {node:{kind:'ssh',host:'h1',root:'/srv/proj'}});
  assert.equal(cross.observations[0].error.code,'TOKEN_NODE_MISMATCH');
  const crossRoot=await observe(api,[{key:'a',relativePath:'out/d0',type:'directory',backendToken:row.token,backendIndex:0}],
    {rootIdentity:{...IDENTITY,inode:'666'}});
  assert.equal(crossRoot.observations[0].error.code,'TOKEN_NODE_MISMATCH');
});
test('token rows answer the existing state semantics, including live executors and archived replacement',async()=>{
  const rows={
    live:{key:'live',status:'present',target:{missing:false,type:'file',absolutePath:'/srv/proj/out/live',device:'7',inode:'9'},
      executors:[{windowId:'@1',paneId:'%1'}],executorsChecked:true},
    hold:{key:'hold',status:'present',target:{missing:false,type:'directory',absolutePath:'/srv/proj/out/hold',device:'7',inode:'9'},
      executors:[],executorsChecked:true,isolationStatus:'gone',isolationChecked:true},
    drift:{key:'drift',status:'replaced',target:{missing:false,type:'file',absolutePath:'/srv/proj/out/back',device:'8',inode:'4242'},
      executors:[],executorsChecked:true},
    arch:{key:'arch',status:'replaced',target:{missing:false,type:'directory',absolutePath:'/srv/proj/'+JOB+'/out1',device:'8',inode:'4300'},
      executors:[],executorsChecked:true},
  };
  const {api}=harness({observe:e=>rows[e.key]||{key:e.key,status:'present',
    target:{missing:false,type:e.type,absolutePath:'/srv/proj/'+e.relativePath,device:'7',inode:'9'},executors:[],executorsChecked:true}});
  const row=await confirmed(api,[{relativePath:'out/live',type:'file'},{relativePath:'out/hold',type:'directory'},
    {relativePath:'out/back',type:'file'},{relativePath:JOB+'/out1',type:'directory',destination:JOB+'/out1'}]);
  const res=await observe(api,[
    {key:'live',relativePath:'out/live',type:'file',backendToken:row.token,backendIndex:0},
    {key:'hold',relativePath:'out/hold',type:'directory',backendToken:row.token,backendIndex:1},
    {key:'drift',relativePath:'out/back',type:'file',backendToken:row.token,backendIndex:2},
    {key:'arch',relativePath:JOB+'/out1',type:'directory',backendToken:row.token,backendIndex:3},
  ]);
  const byKey=Object.fromEntries(res.observations.map(o=>[o.key,o]));
  assert.equal(byKey.live.state,'executing','a live managed window on the exact path is executor evidence');
  assert.deepEqual(byKey.live.executors,[{windowId:'@1',paneId:'%1'}]);
  assert.equal(byKey.hold.state,'pending','no isolation residue and the original standing is pending');
  assert.equal(byKey.drift.state,'completed','same-name replacement is new data, the frozen entry is gone');
  assert.equal(byKey.arch.state,'unknown','archived replacement is new data at a reused path, not proof');
});
test('missing, duplicated, reordered and failed answers stay explicit unknowns and never contaminate siblings',async()=>{
  const marks=new Set(['k2']);
  const dropped=harness({dropRow:r=>r.key==='k3',shuffleRows:true,observe:e=>({key:e.key,status:marks.has(e.key)?'gone':'present',
    target:{missing:marks.has(e.key),type:e.type,absolutePath:'/srv/proj/'+e.relativePath,device:'7',inode:'9'+e.relativePath},
    executors:[],executorsChecked:true})});
  const res=await observe(dropped.api,[...Array.from({length:5},(_,i)=>({key:'k'+i,relativePath:'out/d'+i,type:'file'}))]);
  const byKey=Object.fromEntries(res.observations.map(o=>[o.key,o]));
  assert.equal(byKey.k2.status,'gone','shuffled rows are matched by key, never by position');
  assert.equal(byKey.k3.error.code,'ANSWER_MISSING');assert.equal(byKey.k3.executorsChecked,false);
  assert.equal(byKey.k3.status,undefined,'an unanswered key is unknown, never silently absent');
  assert.equal(byKey.k0.status,'present','other keys keep their fresh facts');

  const dup=harness({duplicateRow:r=>r.key==='k1'});
  const res2=await observe(dup.api,[{key:'k1',relativePath:'out/d1',type:'file'}]);
  assert.equal(res2.observations[0].error.code,'DUPLICATE_ANSWER','a duplicated key is trusted by nobody');

  const failed=harness({delay:true,observeFails:(r,n)=>n===2});
  const res3=await observe(failed.api,residue(3000)); // expanded 6000 -> [5000,1000], second batch dies
  assert.equal(res3.observations.filter(o=>o.error&&o.error.code==='OBSERVE_ROUND_FAILED').length,500);
  assert.equal(res3.observations.filter(o=>o.status==='present').length,2500,'the surviving batch keeps its facts');
  // 0.2.111 契约变更（经裁决）：非应答行由隐式缺字段改为显式 state:'unknown'（unknown≠完成）；
  // 无台账行的存活应答仍按 :92「no token means no claimed state」不声明 state。
  assert.ok(res3.observations.every(o=>((o.error&&o.error.code==='OBSERVE_ROUND_FAILED')?o.state==='unknown':o.state===undefined)&&o.status!=='gone'),'a failed batch never writes anything off');

  const drift=harness({identityDrift:true});
  const res4=await observe(drift.api,residue(2));
  assert.ok(res4.observations.every(o=>o.error.code==='ROOT_IDENTITY_CHANGED'));
  assert.equal(res4.rootIdentity,undefined,'a round without a single trustworthy batch claims no root identity');

  const round=harness({wrongRound:true});
  const res5=await observe(round.api,residue(2));
  assert.ok(res5.observations.every(o=>o.error.code==='ANSWER_MISMATCH'),'answers not bound to this round are untrusted');

  const moved=harness({wrongIdentity:true});
  const res6=await observe(moved.api,residue(3000)); // identity shifts mid-round on the second batch
  const split=res6.observations.filter(o=>o.error&&o.error.code==='ROOT_IDENTITY_CHANGED').length;
  assert.equal(split,500,'the batch whose root identity moved is unknown, the first batch stands');
});
test('engine per-row refusals pass through as row errors with their own unknowns',async()=>{
  const {api}=harness({observe:e=>e.key==='bad'
    ? {key:e.key,error:{code:'UNSAFE_PATH',message:'/etc/passwd'},executors:[],executorsChecked:false}
    : {key:e.key,status:'present',target:{missing:false,type:e.type,absolutePath:'/srv/proj/'+e.relativePath,device:'7',inode:'9'},executors:[],executorsChecked:true}});
  const res=await observe(api,[{key:'bad',relativePath:'out/bad',type:'file'},{key:'good',relativePath:'out/good',type:'file'}]);
  const byKey=Object.fromEntries(res.observations.map(o=>[o.key,o]));
  assert.equal(byKey.bad.error.code,'UNSAFE_PATH');assert.equal(byKey.bad.executorsChecked,false);
  assert.equal(byKey.good.status,'present');assert.equal(byKey.good.error,undefined);
});
test('a token frozen under a stable worker id never answers for another worker id on the same endpoint',async()=>{
  // Reviewer probe P1/P1b (r19): host/port/user/root match but the transport
  // terminates on a different worker; the frozen evidence must be refused as
  // TOKEN_NODE_MISMATCH/unknown, never laundered into completed.
  const {api,calls}=harness({observe:e=>({key:e.key,status:'gone',
    target:{missing:true,type:e.type,absolutePath:'/srv/proj/'+e.relativePath},executors:[],executorsChecked:true,
    ...(e.isolationRelativePath?{isolationStatus:'gone',isolationChecked:true}:{})})});
  const W1={id:'w1',kind:'remote',root:'/srv/proj',host:'h',user:'u',port:22};
  const row=await api.preview({consumerRoot: __CONSUMER__, node:W1,action:'delete',authorizationMode:'confirmed_paths',targets:[{relativePath:'out/d0',type:'directory'}]});
  const exact=row.targets.filter(t=>!t.missing).map(t=>t.absolutePath);
  await api.confirm({consumerRoot: __CONSUMER__, token:row.token,digest:row.digest,confirm:true,phase:1,exactTargets:exact});
  await api.confirm({consumerRoot: __CONSUMER__, token:row.token,digest:row.digest,confirm:true,phase:2,exactTargets:exact});
  const tokenTarget=[{key:'a',relativePath:'out/d0',type:'directory',backendToken:row.token,backendIndex:0}];
  const before=calls.length;
  const cross=await observe(api,tokenTarget,{node:{...W1,id:'w2'}});
  assert.equal(cross.observations[0].error.code,'TOKEN_NODE_MISMATCH','same ssh endpoint fields but another worker id is not the frozen node');
  assert.equal(cross.observations[0].state,'unknown','the wrong worker never receives a completed verdict');
  assert.equal(calls.length,before,'the refused token never reaches the wire');
  const same=await observe(api,tokenTarget,{node:W1});
  assert.equal(same.observations[0].error,undefined);
  assert.equal(same.observations[0].state,'completed','the same id is still the same node (P1b)');
  // sync-scope compatibility: a side without any id keeps the field-only match.
  const halfA=await observe(api,tokenTarget,{node:{kind:'remote',root:'/srv/proj',host:'h',user:'u',port:22}});
  assert.equal(halfA.observations[0].error,undefined,'an id-free observer stays compatible with an id-frozen row');
  const anon=await api.preview({consumerRoot: __CONSUMER__, node:{kind:'remote',root:'/srv/proj',host:'h2',user:'u',port:22},action:'delete',
    authorizationMode:'confirmed_paths',targets:[{relativePath:'out/d1',type:'directory'}]});
  const anonExact=anon.targets.filter(t=>!t.missing).map(t=>t.absolutePath);
  await api.confirm({consumerRoot: __CONSUMER__, token:anon.token,digest:anon.digest,confirm:true,phase:1,exactTargets:anonExact});
  await api.confirm({consumerRoot: __CONSUMER__, token:anon.token,digest:anon.digest,confirm:true,phase:2,exactTargets:anonExact});
  const halfB=await observe(api,[{key:'b',relativePath:'out/d1',type:'directory',backendToken:anon.token,backendIndex:0}],
    {node:{id:'w9',kind:'remote',root:'/srv/proj',host:'h2',user:'u',port:22}});
  assert.equal(halfB.observations[0].error,undefined,'an id-free frozen row stays compatible with an id-carrying observer');
});

test('the instance read budget is two slots shared across requests, and failed reads release theirs',async()=>{
  // Reviewer probe P2a/P2b (r19): per-request readConcurrency bounds only that
  // request (via its batch windows); two concurrent readConcurrency=1 rounds
  // must be able to occupy both global slots together, never queue at 1.
  const {api,stats}=harness({delay:true,observeFails:(request,n)=>request.observationId==='rx'&&request.entries[0].key==='k0'});
  const [first,second]=await Promise.all([
    observe(api,residue(3000),{observationId:'rx',readConcurrency:1}),
    observe(api,residue(3000),{observationId:'ry',readConcurrency:1}),
  ]);
  assert.equal(stats.peak,2,'two rc=1 rounds may hold both global slots together (P2a)');
  assert.equal(stats.perPeak.rx,1,'round rx keeps its own in-flight ceiling at one');
  assert.equal(stats.perPeak.ry,1,'round ry keeps its own in-flight ceiling at one');
  assert.equal(stats.observeRpcs.reduce((a,b)=>a+b,0),12000,'both rounds read their whole residue');
  assert.equal(Object.values(first.observations).filter(o=>o.error&&o.error.code==='OBSERVE_ROUND_FAILED').length,2500,
    'only the failed batch of rx is unknown');
  assert.equal(Object.values(second.observations).filter(o=>!o.error).length,3000,'ry is untouched by the sibling failure');
  assert.equal(api.observeInFlight,0,'failed and completed reads all released their slots');
  const later=await observe(api,residue(2),{observationId:'rz'});
  assert.ok(Object.values(later.observations).every(o=>!o.error),'a later round runs right after failures freed the slots');
  // P2b: two readConcurrency=2 rounds still stack to at most two global slots.
  const shared=harness({delay:true});
  const [p,q]=await Promise.all([
    shared.api.observeBatch({consumerRoot: __CONSUMER__, node:NODE,observationId:'p',readConcurrency:2,targets:residue(3000).map(t=>({...t,key:'p'+t.key}))}),
    shared.api.observeBatch({consumerRoot: __CONSUMER__, node:NODE,observationId:'q',readConcurrency:2,targets:residue(3000).map(t=>({...t,key:'q'+t.key}))}),
  ]);
  assert.equal(shared.stats.peak,2,'rc=2 rounds share exactly two slots');
  assert.equal(stats.perPeak.p,undefined);
  assert.equal(Object.keys(p.observations).length,3000);
  assert.equal(Object.keys(q.observations).length,3000);
});

async function tokenRow(api,rels,node=NODE){
  const row=await api.preview({consumerRoot: __CONSUMER__, node,action:'delete',authorizationMode:'confirmed_paths',
    targets:rels.map(rel=>({relativePath:rel,type:'file'}))});
  const exact=row.targets.filter(t=>!t.missing).map(t=>t.absolutePath);
  await api.confirm({consumerRoot: __CONSUMER__, token:row.token,digest:row.digest,confirm:true,phase:1,exactTargets:exact});
  await api.confirm({consumerRoot: __CONSUMER__, token:row.token,digest:row.digest,confirm:true,phase:2,exactTargets:exact});
  return row;
}
const DEATH='f'.repeat(48);
test('one observeBatch call reads each backend token exactly once and re-reads across calls',async()=>{
  // Real rows on disk through the public API; read is the untouched production
  // read, wrapped only with a pass-through counter. One token carried by many
  // targets costs ONE read per call (JSON.parse of the full frozen row was
  // quadratic: 5000 targets x full row = blocked delivery); a broken token is
  // deduplicated in the same round, and the next public call reads fresh.
  const {api}=harness({observe:e=>({key:e.key,status:'gone',
    target:{missing:true,type:e.type,absolutePath:'/srv/proj/'+e.relativePath},executors:[],executorsChecked:true})});
  const reads={n:0};
  const realRead=api.read.bind(api);
  api.read=async (token,consumerRoot,expectedDigest)=>{ reads.n+=1; return realRead(token,consumerRoot,expectedDigest); };
  const one=await tokenRow(api,['out/a0','out/a1','out/a2']);
  const three=await tokenRow(api,['out/b0','out/b1','out/b2','out/b3']);
  const mine=(row,rels,from=0)=>rels.map((rel,i)=>({key:'k'+from+i,relativePath:rel,type:'file',backendToken:row.token,backendIndex:i}));
  reads.n=0;
  const first=await observe(api,[...mine(one,['out/a0','out/a1','out/a2']),...mine(three,['out/b0','out/b1','out/b2','out/b3'],100)]);
  assert.equal(reads.n,2,'two distinct tokens this round cost exactly two reads');
  assert.equal(Object.values(first.observations).filter(o=>o.state==='completed').length,7);
  const dead=mine({token:DEATH},['out/x0','out/x1','out/x2'],200);
  reads.n=0;
  const second=await observe(api,[...mine(one,['out/a0','out/a1','out/a2']),...dead]);
  assert.equal(reads.n,2,'the same token is re-read next call, and the dead token costs one deduplicated read');
  assert.equal(Object.values(second.observations).filter(o=>o.error&&['LEGACY_IMPORT_UNBOUND','TOKEN_UNAVAILABLE'].includes(o.error.code)).length,3,'dead rows stop at the owner contract (first read honest stop code, deduped followers unavailable), never contaminating live rows');
  assert.ok(second.observations.find(o=>o.key==='k00').state==='completed','the dead token never contaminates live rows');
  reads.n=0;
  const half=await observe(api,[...mine(one,['out/a0','out/a1','out/a2'],0).slice(0,2),{key:'dup',relativePath:'out/zz',type:'file',backendToken:one.token,backendIndex:9}]);
  assert.equal(reads.n,1,'duplicate and out-of-range rows share the single snapshot read');
  assert.equal(half.observations.find(o=>o.key==='dup').error.code,'TOKEN_TARGET_MISMATCH');
});

test('default-heap scale: 1200 and 5000 real-token rows stay linear, fresh, and byte-stable',async t=>{
  // Same public API and production read (counted through a pass-through
  // wrapper), real rows on disk, default V8 heap, no timeout widening. Warm
  // rounds measure the in-call snapshot win straight after preview/confirm
  // (read() legitimately answers from its memory previews); COLD rounds clear
  // ONLY this test api's memory previews first, so every read must hit the
  // row file on disk - the path an independent A-side status round takes.
  // Deterministic assertions stay about unique-token reads; timings ship as
  // t.diagnostic JSON captured by the investigating script, never hard pins.
  const {api,stats}=harness({observe:e=>({key:e.key,status:'gone',
    target:{missing:true,type:e.type,absolutePath:'/srv/proj/'+e.relativePath},executors:[],executorsChecked:true})});
  const reads={n:0,hitsDisk:false};
  const realRead=api.read.bind(api);
  api.read=async (token,consumerRoot,expectedDigest)=>{ reads.n+=1;
    // prove the cold round really goes to disk: preview cache cleared means
    // read() takes its fs branch (production behaviour, observed only)
    if(!api.previews.has(token))reads.hitsDisk=true;
    return realRead(token,consumerRoot,expectedDigest); };
  const rels=n=>Array.from({length:n},(_,i)=>'out/f'+String(i).padStart(5,'0'));
  const clock=()=>Number(process.hrtime.bigint())/1e6;
  const report={};
  for(const n of [1200,5000]){
    const row=await tokenRow(api,rels(n));
    const file=path.join(__CONSUMER__,'simple_cluster','state','simple-sftp','cleanup-operations',row.token+'.json');
    const bytesBefore=fs.readFileSync(file);
    const targets=rels(n).map((rel,i)=>({key:'k'+i,relativePath:rel,type:'file',backendToken:row.token,backendIndex:i}));
    reads.n=0;reads.hitsDisk=false;
    const mem0=process.memoryUsage(), t0=clock();
    const r1=await observe(api,targets);
    const ms=clock()-t0, mem1=process.memoryUsage();
    assert.equal(reads.n,1,'one token costs exactly one read at n='+n);
    assert.equal(reads.hitsDisk,false,'warm round answers from the preview memory cache (documented, not disk)');
    assert.equal(Object.values(r1.observations).filter(o=>o.state==='completed').length,n);
    assert.deepEqual(fs.readFileSync(file),bytesBefore,'observation never rewrites the frozen row');
    // COLD round: identical inputs, but this test api's preview cache entry is
    // cleared FIRST, so the single read must hit the existing row file.
    api.previews.delete(row.token);
    reads.n=0;reads.hitsDisk=false;
    const cMem0=process.memoryUsage(), cT0=clock();
    const r1c=await observe(api,targets);
    const cMs=clock()-cT0, cMem1=process.memoryUsage();
    assert.equal(reads.n,1,'the cold round still reads each token exactly once at n='+n);
    assert.equal(reads.hitsDisk,true,'the cold round genuinely goes through the on-disk row read');
    assert.equal(Object.values(r1c.observations).filter(o=>o.state==='completed').length,n);
    assert.deepEqual(fs.readFileSync(file),bytesBefore,'the cold observation never rewrites the row either');
    report[n]={warm:{reads:reads.n,ms:Math.round(ms*10)/10,heapUsedMB:Math.round(mem1.heapUsed/1048576),
      heapDeltaMB:Math.round((mem1.heapUsed-mem0.heapUsed)/1048576),rssMB:Math.round(mem1.rss/1048576)},
      cold:{reads:reads.n,diskRead:true,ms:Math.round(cMs*10)/10,heapUsedMB:Math.round(cMem1.heapUsed/1048576),
      heapDeltaMB:Math.round((cMem1.heapUsed-cMem0.heapUsed)/1048576),rssMB:Math.round(cMem1.rss/1048576)}};
    // Fresh round with a rewritten token row re-reads across calls: the frozen
    // facts of round one must not survive into round two's snapshot.
    const stale=JSON.parse(bytesBefore.toString());
    stale.targets[0].relativePath='out/elsewhere';
    fs.writeFileSync(file,JSON.stringify(stale));
    api.previews.delete(row.token);
    reads.n=0;
    const r2=await observe(api,targets.slice(0,5));
    assert.equal(reads.n,1,'the next public call reads the token again');
    assert.equal(r2.observations.find(o=>o.key==='k0').error.code,'TOKEN_TARGET_MISMATCH','round two answers from the rewritten row, not a cached snapshot');
  }
  // Multi-token accounting and dead-token isolation at 600+600 in one call.
  const a=await tokenRow(api,rels(600).map(r=>'a/'+r));
  const b=await tokenRow(api,rels(600).map(r=>'b/'+r));
  const mixed=[...rels(600).map((r,i)=>({key:'a'+i,relativePath:'a/'+r,type:'file',backendToken:a.token,backendIndex:i})),
    ...rels(600).map((r,i)=>({key:'b'+i,relativePath:'b/'+r,type:'file',backendToken:b.token,backendIndex:i})),
    ...Array.from({length:400},(_,i)=>({key:'x'+i,relativePath:'x/'+i,type:'file',backendToken:DEATH,backendIndex:0}))];
  reads.n=0;
  const mixedRound=await observe(api,mixed,{readConcurrency:1});
  assert.equal(reads.n,3,'per-token accounting: two live tokens plus one dead token, one read each');
  assert.equal(Object.values(mixedRound.observations).filter(o=>o.state==='completed').length,1200,'the dead token never contaminates live groups');
  assert.equal(Object.values(mixedRound.observations).filter(o=>o.error&&['LEGACY_IMPORT_UNBOUND','TOKEN_UNAVAILABLE'].includes(o.error.code)).length,400,'the dead token stops at the owner contract, deduplicated');
  // Measurement ships as test diagnostics (captured by the investigation
  // script into scratch); the suite never depends on a fixed report path.
  t.diagnostic('SCALE-MEASUREMENT '+JSON.stringify(report));
});

test('observeBatch performs zero local writes and never emits a mutating action',async()=>{
  const {api,calls,storageRoot}=harness();
  const row=await confirmed(api,dirs(2));
  const before=fs.readdirSync(storageRoot);
  await observe(api,[{key:'a',relativePath:'out/d0',type:'directory',backendToken:row.token,backendIndex:0},
    ...residue(10).slice(1)]);
  assert.deepEqual(fs.readdirSync(storageRoot),before,'the read-only round stores no row, journal or ledger');
  assert.ok(calls.filter(c=>c.action!=='batch-inspect').every(c=>c.action==='batch-observe'),
    'no confirm/execute/settle/delete ever leaves this entry point');
});
test('malformed observation requests are refused before anything touches the wire',async()=>{
  const {api,calls}=harness();
  const bad=[
    {node:NODE,observationId:'r',readConcurrency:2,targets:[]},
    {node:NODE,observationId:'r',readConcurrency:2,targets:residue(5001)},
    {node:NODE,observationId:'r',readConcurrency:2,targets:[{key:'k',relativePath:'out/a',type:'file'},{key:'k',relativePath:'out/b',type:'file'}]},
    {node:NODE,observationId:'',readConcurrency:2,targets:[{key:'k',relativePath:'out/a',type:'file'}]},
    {node:NODE,observationId:'r',readConcurrency:3,targets:[{key:'k',relativePath:'out/a',type:'file'}]},
    {node:NODE,observationId:'r',targets:[{key:'k',relativePath:'out/a',type:'file'}]},
    {node:NODE,observationId:'r',readConcurrency:1,targets:[{key:'k',relativePath:'/etc/passwd',type:'file'}]},
    {node:NODE,observationId:'r',readConcurrency:1,targets:[{key:'k',relativePath:'out/../x',type:'file'}]},
    {node:NODE,observationId:'r',readConcurrency:1,targets:[{key:'k',relativePath:'out/a',type:'link'}]},
    {node:NODE,observationId:'r',readConcurrency:1,targets:[{key:'k',relativePath:'repo/.git/config',type:'file'}]},
    {node:NODE,observationId:'r',readConcurrency:1,targets:[{key:'k',relativePath:'clean_dir/anything',type:'directory'}]},
  ];
  for(const params of bad)await assert.rejects(api.observeBatch(params),/INVALID_REQUEST|PROTECTED_PATH|UNSAFE_DESTINATION/);
  assert.equal(calls.filter(c=>c.action==='batch-observe').length,0);
});
test('an isolate token observed through its registered destination answers the deletion lifecycle honestly',async()=>{
  // 0.2.111: the background delete registers row.isolatedDelete; observation of
  // the REGISTERED destination path is then bound by the frozen ledger row.
  // Completion needs BOTH facts: the ledger lifecycle completed AND the absent
  // destination. Accepted/executing/unknown + gone never complete; anything
  // else is an explicit unknown; the SOURCE-path derivation stays untouched.
  const BATCH='job-'+'a'.repeat(48),dest=JOB+'/out/run1';
  async function isolateRow(options){
    const h=harness(options);
    const row=await h.api.preview({consumerRoot: __CONSUMER__, node:NODE,action:'isolate',
      targets:[{relativePath:'out/run1',type:'directory',archiveBatch:BATCH,destination:dest}]});
    await h.api.confirm({consumerRoot: __CONSUMER__, token:row.token,digest:row.digest,confirm:true,phase:1,exactTargets:['/srv/proj/out/run1']});
    const stored=await h.api.read(row.token, __CONSUMER__);
    stored.states[0]='completed';
    stored.receipts={[0]:{phase:'completed',isolationCompletionProtocol:1,renameCommitted:true,sourceMissingAtMove:true,registered:true,executorsChecked:true,executors:[]}};
    await h.api.save(stored);
    return {h,row,async phase(phase){const s=await h.api.read(row.token, __CONSUMER__);
      if(phase===undefined)delete s.isolatedDelete;
      else s.isolatedDelete={capability:'isolationBackgroundDelete',protocol:1,phase,operationId:s.operationId,
        targets:[{destinationRelativePath:dest,type:'directory'}]};
      await h.api.save(s);}};
  }
  const destTarget=token=>[{key:'g',relativePath:dest,type:'directory',backendToken:token,backendIndex:0}];
  const sourceTarget=token=>[{key:'s',relativePath:'out/run1',type:'directory',backendToken:token,backendIndex:0}];
  const statusOf=st=>e=>({key:e.key,status:st,
    target:{missing:st==='gone',type:e.type,absolutePath:'/srv/proj/'+e.relativePath,device:'7',inode:'9'+e.relativePath},
    executors:[],executorsChecked:true});
  const t0=await isolateRow({observe:statusOf('gone')});
  let res=await observe(t0.h.api,destTarget(t0.row.token));
  assert.equal(res.observations[0].error.code,'TOKEN_TARGET_MISMATCH','before maintenance starts the token binds the source path only');
  assert.equal(res.observations[0].state,'unknown');
  await t0.phase('accepted');
  res=await observe(t0.h.api,destTarget(t0.row.token));
  assert.equal(res.observations[0].state,'unknown','an accepted delete with an absent destination is never worded completed');
  await t0.phase('executing');
  res=await observe(t0.h.api,destTarget(t0.row.token));
  assert.equal(res.observations[0].state,'unknown','executing + gone stays unknown: the mutation answer may have been lost');
  await t0.phase('completed');
  res=await observe(t0.h.api,destTarget(t0.row.token));
  assert.equal(res.observations[0].state,'completed','completion needs the ledger phase AND the absent destination together');
  const t1=await isolateRow({observe:statusOf('present')});
  await t1.phase('completed');
  res=await observe(t1.h.api,destTarget(t1.row.token));
  assert.equal(res.observations[0].state,'unknown','a destination standing again contradicts the ledger: unknown, never a new grant');
  const t2=await isolateRow({observe:statusOf('present')});
  await t2.phase('executing');
  res=await observe(t2.h.api,destTarget(t2.row.token));
  assert.equal(res.observations[0].state,'executing');
  await t2.phase('accepted');
  res=await observe(t2.h.api,destTarget(t2.row.token));
  assert.equal(res.observations[0].state,'pending');
  const t3=await isolateRow({observe:statusOf('gone'),dropRow:r=>r.key==='g'});
  await t3.phase('completed');
  res=await observe(t3.h.api,destTarget(t3.row.token));
  assert.equal(res.observations[0].error.code,'ANSWER_MISSING');assert.equal(res.observations[0].state,'unknown','a missing answer never completes');
  const t4=await isolateRow({observe:statusOf('present')});
  const before=await observe(t4.h.api,sourceTarget(t4.row.token));
  await t4.phase('executing');
  const after=await observe(t4.h.api,sourceTarget(t4.row.token));
  assert.equal(after.observations[0].state,before.observations[0].state,'the delete lifecycle never leaks into source-path derivation');
  assert.ok(t3.h.calls.every(c=>['inspect','batch-inspect','batch-observe'].includes(c.action)),
    'destination rows ride the shared read-only batch-observe round; no mutation action ever leaves this entry');
});
test('engine batch_observe answers from current facts with one shared sweep and zero mutation primitives (FakeOS fixture)',()=>{
  const fixture=path.resolve(__dirname,'cleanupObserveBatch.fixture.py'),engine=path.resolve(__dirname,'../cleanup-files.py');
  const linux=p=>'/mnt/'+p[0].toLowerCase()+p.slice(2).replace(/\\/g,'/');
  const args=process.platform==='win32'?['--distribution',process.env.SIMPLE_TEST_WSL_DISTRO||'Ubuntu-Codex','--exec','python3',linux(fixture),linux(engine)]:[fixture,engine];
  const result=spawnSync(process.platform==='win32'?'wsl.exe':'python3',args,{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.deepEqual(JSON.parse(result.stdout),{factsAndSingleSweep:true,executorFacts:true,identityCounterEvidence:true,
    uncheckedExecutors:true,unverifiedBinding:true,shapeRefusals:true,rowIsolation:true,ok:true});
});
