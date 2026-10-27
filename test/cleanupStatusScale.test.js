const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const __CONSUMER__ = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'consumer-root-'));
const os=require('node:os');
// v1.9 defect 7 (reviewer probe /tmp/opencode/iv-n/probe-scale-settle.js P3,
// kept frozen as red evidence of the OLD behavior): api.status expanded 2501
// directories into 5002 original+isolation entries in ONE batch-verify RPC,
// over the engine FAST_BATCH_LIMIT(5000), so the whole selection degraded to
// statusQueryError and nothing was verifiable. The unified verify entry now
// packs each target's ACTUAL expanded entries (original + its entry-bound
// isolation twin, pair never split) into bounded read-only batches of <=5000,
// at most two in flight, matched back by relativePath+type, never by position.
// Pure fake/injection tests only: no real engine, no real deletion; storage
// roots are disposable temp dirs.
const {CleanupFileApi}=require('../cleanup-file-api');
const IDENTITY={path:'/srv/proj',device:'7',inode:'100',machine:'host',user:'0'};
const JOB='clean_dir/job-'+('a'.repeat(48));
// deterministic unique fake mapping: out/dX <-> out/iso_dX (twins share the RPC)
const isoName=rel=>'iso_'+rel.slice('out/'.length);
function harness(options={}){
  const calls=[],stats={verifyRpcs:[],activeVerify:0,peakVerify:0};
  const transport=async request=>{
    calls.push(request);
    if(request.action==='batch-inspect'){
      if(request.targets.length>5000)throw Object.assign(Error('FAST_BATCH_INVALID'),{code:'FAST_BATCH_INVALID'});
      return {ok:true,rootIdentity:IDENTITY,metrics:{entryReads:request.targets.length,mountReads:1,entryCheckMs:1},
        capabilities:{confirmedPathFastDelete:1,batchEntryInspect:1},
        targets:request.targets.map(t=>({relativePath:t.relativePath,type:t.type,absolutePath:'/srv/proj/'+t.relativePath,
          device:'7',inode:'2'+t.relativePath,
          ...(t.relativePath.startsWith(JOB+'/')?{archived:true}
            :t.type==='directory'?{isolationName:isoName(t.relativePath)}:{})}))};
    }
    if(request.action==='batch-verify'){
      if(options.identityDrift||JSON.stringify(request.rootIdentity)!==JSON.stringify(IDENTITY))
        return {ok:false,error:{code:'ROOT_IDENTITY_CHANGED'}}; // engine-side identity refusal
      if(request.entries.length>5000)throw Object.assign(Error('FAST_BATCH_INVALID'),{code:'FAST_BATCH_INVALID'});
      // invariant: every isolation twin shares the RPC with its frozen original
      const originals=new Set(request.entries.filter(e=>e.relativePath.startsWith('out/')).map(e=>e.relativePath));
      for(const e of request.entries)if(e.relativePath.startsWith('out/iso_'))
        assert.ok(originals.has('out/'+e.relativePath.slice('out/iso_'.length)),'twin '+e.relativePath+' must share the RPC with its original');
      stats.verifyRpcs.push(request.entries.length);
      stats.activeVerify++;stats.peakVerify=Math.max(stats.peakVerify,stats.activeVerify);
      try{
        if(options.verifyDelay)await new Promise(resolve=>setTimeout(resolve,10));
        if(options.verifyFails&&options.verifyFails(request))throw Object.assign(Error('VERIFY_ROUND_FAILED'),{code:'VERIFY_ROUND_FAILED'});
        const rows=request.entries.map(e=>({relativePath:e.relativePath,type:e.type,status:options.verify(e)}));
        if(options.dropRow)for(let k=rows.length-1;k>=0;k--)if(options.dropRow(rows[k]))rows.splice(k,1);
        if(options.dropLastRow)rows.pop();
        if(options.shuffleRows)rows.reverse(); // answers arrive unordered; pairing is by identity
        return {ok:true,rootIdentity:IDENTITY,targets:rows};
      } finally{ stats.activeVerify--; }
    }
    if(request.action==='delete-fast'){
      if(options.deleteError)throw Object.assign(Error(options.deleteError.code),{code:options.deleteError.code,mutationStarted:options.deleteError.mutationStarted});
      return {ok:true,receipt:{operationId:request.operationId,action:'delete-fast',phase:'completed',metrics:{},receipts:[]}};
    }
    throw Error('UNEXPECTED '+request.action);
  };
  const storageRoot=fs.mkdtempSync(path.join(os.tmpdir(),'scale-verify-'));
  const api=new CleanupFileApi({storageRoot,transport,activity:async()=>({}),lease:async(n,t,run)=>run(),readRuntimeVersion:async()=>'1.9.0'});
  return {api,calls,stats};
}
const dirs=n=>Array.from({length:n},(_,i)=>({relativePath:'out/d'+i,type:'directory'}));
async function confirmed(api,targets){
  const row=await api.preview({consumerRoot: __CONSUMER__, node:{kind:'local',root:'/srv/proj'},action:'delete',authorizationMode:'confirmed_paths',targets});
  const exact=row.targets.filter(t=>!t.missing).map(t=>t.absolutePath);
  await api.confirm({consumerRoot: __CONSUMER__, token:row.token,digest:row.digest,confirm:true,phase:1,exactTargets:exact});
  await api.confirm({consumerRoot: __CONSUMER__, token:row.token,digest:row.digest,confirm:true,phase:2,exactTargets:exact});
  return row;
}

test('status of 2501 directories stays inside bounded read-only batches and verifies honestly (was P3b)',async()=>{
  const {api,stats}=harness({verify:e=>e.relativePath.includes('iso_')?'gone':'present',verifyDelay:true});
  const row=await confirmed(api,dirs(2501)); // 2501*2=5002 expanded entries overflowed the old single RPC
  const st=await api.status({consumerRoot: __CONSUMER__, token:row.token});
  assert.equal(st.statusQueryError,undefined,'whole-selection query must not overflow any more');
  assert.deepEqual(stats.verifyRpcs,[5000,2],'packing by actual expanded entries: [5000,2], never one RPC per file');
  assert.ok(stats.peakVerify<=2,'at most two read-only batches in flight (observed '+stats.peakVerify+')');
  assert.ok(st.states.every(s=>s==='pending'),'all present -> pending, nothing invented');
});
test('5000-directory selection fans out into two full bounded batches',async()=>{
  const {api,stats}=harness({verify:e=>e.relativePath.includes('iso_')?'gone':'present'});
  const row=await confirmed(api,dirs(5000)); // 10000 expanded entries
  const st=await api.status({consumerRoot: __CONSUMER__, token:row.token});
  assert.deepEqual(stats.verifyRpcs,[5000,5000]);
  assert.ok(stats.peakVerify<=2);
  assert.equal(st.statusQueryError,undefined);
  assert.ok(st.states.every(s=>s==='pending'));
});
test('mixed directories, loose files and archived rows pack exactly and keep frozen bindings',async()=>{
  const seen=[];
  const {api,stats}=harness({verify:e=>{seen.push([e.relativePath,e.device,e.inode]);return e.relativePath.includes('iso_')?'gone':'present';}});
  const targets=[...dirs(3500),...Array.from({length:1400},(_,i)=>({relativePath:'out/f'+i+'.log',type:'file'})),
    ...Array.from({length:100},(_,i)=>({relativePath:JOB+'/out'+i,type:'directory',destination:JOB+'/out'+i}))]; // public batch admits 5000 targets
  const row=await confirmed(api,targets);
  const st=await api.status({consumerRoot: __CONSUMER__, token:row.token});
  assert.equal(st.statusQueryError,undefined);
  assert.deepEqual(stats.verifyRpcs,[5000,3500],'5000 targets -> 8500 expanded entries -> [5000,3500] (archived carries no twin)');
  assert.ok(stats.verifyRpcs.every(n=>n<=5000));
  const twins=seen.filter(([rel])=>rel.startsWith('out/iso_'));
  assert.equal(twins.length,3500,'one twin per non-archived directory, none for archived or loose files');
  assert.ok(seen.every(([,device])=>device==='7'),'every verify entry rides the frozen root device binding');
  assert.ok(twins.every(([rel,,inode])=>inode==='2out/'+rel.slice('out/iso_'.length)),'twins ride the ORIGINAL frozen dev/inode, not their own');
  assert.ok(st.states.every(s=>s==='pending'));
});
test('a failed second batch marks ONLY its entries unknown, keeps batchExecuting, and a requery settles the lost receipt',async()=>{
  let round=1;
  const {api,calls}=harness({deleteError:{code:'PROCESS_EXITED',mutationStarted:true},
    verify:()=>'gone', // full completion evidence everywhere once actually asked
    verifyFails:request=>round===1&&Number(request.entries[0].relativePath.slice('out/d'.length))>=2500});
  const row=await confirmed(api,dirs(2501));
  await assert.rejects(api.execute({consumerRoot: __CONSUMER__, token:row.token,digest:row.digest,index:0})); // receipt lost, mutation started
  const first=await api.status({consumerRoot: __CONSUMER__, token:row.token}); // second batch fails this round
  assert.equal(first.statusQueryError,'VERIFY_ROUND_FAILED','the real current-round failure is recorded');
  assert.equal(first.batchExecuting,true,'an unanswered batch must not clear batchExecuting');
  assert.ok(first.states.slice(0,2500).every(s=>s==='completed'),'batch one evidence stands');
  assert.ok(first.states.slice(2500).every(s=>s==='unknown'),'failed batch entries are unknown, never gone/completed');
  round=2;
  const second=await api.status({consumerRoot: __CONSUMER__, token:row.token}); // requery succeeds
  assert.equal(second.statusQueryError,undefined,'the resolved round clears the stale round error');
  assert.ok(second.states.every(s=>s==='completed'));
  assert.equal(second.batchExecuting,false,'accounting every entry resolves the lost receipt');
  const rerun=await api.execute({consumerRoot: __CONSUMER__, token:row.token,digest:row.digest,index:0});
  assert.equal(rerun.alreadyCompleted,true,'settled completion is never re-dispatched');
  assert.equal(calls.filter(c=>c.action==='delete-fast').length,1,'zero blind delete-fast resends');
});
test('short or unordered answers are safe unknown, matching stays by identity; later good round settles',async()=>{
  const options={verify:()=>'gone',dropLastRow:true}; // last row of every batch withheld
  const {api}=harness(options);
  const row=await confirmed(api,[{relativePath:'out/d0',type:'directory'},{relativePath:'out/d1',type:'directory'}]);
  const first=await api.status({consumerRoot: __CONSUMER__, token:row.token});
  assert.equal(first.statusQueryError,undefined,'a short answer is not a round failure');
  assert.equal(first.states[0],'completed','fully answered directory settles');
  assert.equal(first.states[1],'unknown','its unanswered twin row is never treated as gone');
  assert.equal(first.observations[1].isolationStatus,'missing');
  options.dropLastRow=false;options.shuffleRows=true; // full, unordered answer next round
  const second=await api.status({consumerRoot: __CONSUMER__, token:row.token});
  assert.ok(second.states.every(s=>s==='completed'),'unordered rows still map by relativePath+type');
});
test('sticky accounted evidence: a completed entry is not downgraded by a later failing round; single-index callers keep throwing',async()=>{
  const options={verify:()=>'gone'};
  const {api}=harness(options);
  const row=await confirmed(api,dirs(3));
  const ok=await api.status({consumerRoot: __CONSUMER__, token:row.token});
  assert.ok(ok.states.every(s=>s==='completed'));
  const kept=ok.observations[0];
  options.verifyFails=()=>true; // this whole round fails
  const bad=await api.status({consumerRoot: __CONSUMER__, token:row.token});
  assert.ok(bad.states.every(s=>s==='completed'),'failed round erases nothing that was accounted');
  assert.deepEqual(bad.observations[0],kept,'valid evidence is preserved');
  assert.equal(bad.statusQueryError,'VERIFY_ROUND_FAILED','but the real round failure is still reported');
  await assert.rejects(api.verify({consumerRoot: __CONSUMER__, token:row.token,index:0}),/VERIFY_ROUND_FAILED/,'single-index verify keeps its own error handling');
  await assert.rejects(api.check({consumerRoot: __CONSUMER__, token:row.token,index:0}),/VERIFY_ROUND_FAILED/);
  await assert.rejects(api.settle({consumerRoot: __CONSUMER__, token:row.token,digest:row.digest,index:0}),/VERIFY_ROUND_FAILED/);
});
test('a short answer that drops only the isolation twin row never demotes accounted completed (defect 8)',async()=>{
  const options={verify:()=>'gone'};
  const {api}=harness(options);
  const row=await confirmed(api,[{relativePath:'out/d0',type:'directory'}]);
  await api.execute({consumerRoot: __CONSUMER__, token:row.token,digest:row.digest,index:0});
  const done=await api.status({consumerRoot: __CONSUMER__, token:row.token}); // full gone answers -> accounted completed
  assert.deepEqual(done.states,['completed']);
  const kept=done.observations[0];
  options.dropRow=r=>r.relativePath==='out/iso_d0'; // anomalous short round: original gone, twin row dropped
  const short1=await api.status({consumerRoot: __CONSUMER__, token:row.token});
  assert.deepEqual(short1.states,['completed'],'a missing twin row is absence of evidence, not counter-evidence');
  assert.deepEqual(short1.observations[0],kept,'the accounted observation stays intact');
  assert.equal(short1.statusQueryError,undefined);
  delete options.dropRow;
  const good=await api.status({consumerRoot: __CONSUMER__, token:row.token}); // good round: nothing to repair
  assert.deepEqual(good.states,['completed']);
  options.dropRow=r=>r.relativePath==='out/d0'; // dropped ORIGINAL row (twin answered gone) is equally absent evidence
  const short2=await api.status({consumerRoot: __CONSUMER__, token:row.token});
  assert.deepEqual(short2.states,['completed']);
  assert.deepEqual(short2.observations[0],kept);
  delete options.dropRow;
  options.verify=e=>e.relativePath==='out/iso_d0'?'present':'gone'; // REAL counter-evidence: twin tree actually exists
  const contra=await api.status({consumerRoot: __CONSUMER__, token:row.token});
  assert.deepEqual(contra.states,['unknown'],'fresh counter-evidence still resolves honestly - never permanently ignored');
  assert.equal(contra.observations[0].isolationStatus,'present');
  options.verify=()=>'gone'; // evidence returns: re-accounted
  const again=await api.status({consumerRoot: __CONSUMER__, token:row.token});
  assert.deepEqual(again.states,['completed']);
});
test('counter-evidence outranks unrelated missing rows: dropped original row with the twin actually present demotes to unknown and recovers',async()=>{
  const options={verify:()=>'gone'};
  const {api}=harness(options);
  const row=await confirmed(api,[{relativePath:'out/d0',type:'directory'}]);
  await api.execute({consumerRoot: __CONSUMER__, token:row.token,digest:row.digest,index:0});
  const done=await api.status({consumerRoot: __CONSUMER__, token:row.token});
  assert.deepEqual(done.states,['completed']);
  // ONE round: the original row is dropped AND the received twin row says present
  options.verify=()=>'present';
  options.dropRow=r=>r.relativePath==='out/d0';
  const countered=await api.status({consumerRoot: __CONSUMER__, token:row.token});
  assert.deepEqual(countered.states,['unknown'],'a received isolation tree is counter-evidence, the missing original row must not mask it');
  assert.equal(countered.observations[0].isolationStatus,'present','the round that countered is recorded, not the old observation');
  assert.equal(countered.statusQueryError,undefined);
  delete options.verify;delete options.dropRow;options.verify=()=>'gone';
  const back=await api.status({consumerRoot: __CONSUMER__, token:row.token});
  assert.deepEqual(back.states,['completed'],'the demotion stays recoverable by a full clean round');
});
test('an explicit ROOT_IDENTITY_CHANGED demotes completed to unknown, while an ordinary batch failure without new evidence still preserves it',async()=>{
  const options={verify:()=>'gone'};
  const {api}=harness(options);
  const row=await confirmed(api,[{relativePath:'out/d0',type:'directory'}]);
  await api.execute({consumerRoot: __CONSUMER__, token:row.token,digest:row.digest,index:0});
  const done=await api.status({consumerRoot: __CONSUMER__, token:row.token});
  assert.deepEqual(done.states,['completed']);
  const kept=done.observations[0];
  options.verifyFails=()=>true; // ordinary connectivity-style batch failure: no new evidence at all
  const lost=await api.status({consumerRoot: __CONSUMER__, token:row.token});
  assert.deepEqual(lost.states,['completed'],'ordinary failure keeps the accounted completion');
  assert.deepEqual(lost.observations[0],kept);
  delete options.verifyFails;
  options.identityDrift=true; // the engine now REFUSES the frozen root identity: received counter-evidence
  const moved=await api.status({consumerRoot: __CONSUMER__, token:row.token});
  assert.deepEqual(moved.states,['unknown'],'an identity refusal after completion is never masked as a mere missed round');
  assert.equal(moved.statusQueryError,'ROOT_IDENTITY_CHANGED','the refusal is reported distinctly, not conflated with transport noise');
  options.identityDrift=false;
  const settled=await api.status({consumerRoot: __CONSUMER__, token:row.token});
  assert.deepEqual(settled.states,['completed'],'once the root re-settles, clean evidence re-accounts');
});
test('a root identity change mid-round yields safe unknown everywhere, never completion',async()=>{
  // engine refuses every verify with ROOT_IDENTITY_CHANGED (identity drift surfaces as an error envelope)
  const api=new CleanupFileApi({storageRoot:fs.mkdtempSync(path.join(os.tmpdir(),'scale-verify-')),
    transport:async request=>{
      if(request.action==='batch-inspect')return {ok:true,rootIdentity:IDENTITY,metrics:{entryReads:2},
        targets:request.targets.map(t=>({relativePath:t.relativePath,type:t.type,absolutePath:'/srv/proj/'+t.relativePath,
          device:'7',inode:'2'+t.relativePath,isolationName:isoName(t.relativePath)}))};
      if(request.action==='batch-verify')return {ok:false,error:{code:'ROOT_IDENTITY_CHANGED'}};
      throw Error('UNEXPECTED '+request.action);},
    activity:async()=>({}),lease:async(n,t,run)=>run(),readRuntimeVersion:async()=>'1.9.0'});
  const moved=await confirmed(api,dirs(2));
  const st=await api.status({consumerRoot: __CONSUMER__, token:moved.token});
  assert.equal(st.statusQueryError,'ROOT_IDENTITY_CHANGED','current-round identity failure recorded, never mistaken for success');
  assert.ok(!st.states.includes('completed'),'missing/unanswered is never gone');
  assert.ok(st.states.every(s=>s==='unknown'));
});
