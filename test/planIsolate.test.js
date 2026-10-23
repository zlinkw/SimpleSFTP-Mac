const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {CleanupFileApi}=require('../cleanup-file-api');
const linux=p=>'/mnt/'+p[0].toLowerCase()+p.slice(2).replace(/\\/g,'/');
function runFixture(name,timeout){const fixture=path.resolve(__dirname,name),engine=path.resolve(__dirname,'../cleanup-files.py');
  const args=process.platform==='win32'?['--distribution',process.env.SIMPLE_TEST_WSL_DISTRO||'Ubuntu-Codex','--exec','python3',linux(fixture),linux(engine)]:[fixture,engine];
  const proc=spawnSync(process.platform==='win32'?'wsl.exe':'python3',args,{encoding:'utf8',timeout,windowsHide:true});
  assert.equal(proc.status,0,proc.stderr||proc.stdout);return JSON.parse(proc.stdout);}
const BATCH='job-'+'a'.repeat(48);
function makeApi(overrides={}){const requests=[];const api=new CleanupFileApi({storageRoot:path.join(os.tmpdir(),'plan-isolate-'+process.pid+'-'+Math.random().toString(36).slice(2)),activity:async()=>{},lease:async(_node,_targets,fn)=>fn(),transport:async request=>{requests.push(JSON.parse(JSON.stringify(request)));
  if(request.action==='batch-inspect')return {ok:true,rootIdentity:{path:'/scope'},capabilities:{confirmedPathFastDelete:1,batchEntryInspect:1},targets:request.targets.map(t=>({...t,absolutePath:'/scope/'+t.relativePath,archived:true,device:'1',inode:'7'}))};
  if(request.action==='inspect'){if(overrides.inspect)return overrides.inspect(request);
    return {ok:true,rootIdentity:{path:'/scope'},target:{type:request.target.type,absolutePath:'/scope/'+request.target.relativePath,fingerprint:'top-'+request.target.relativePath,inode:'7',device:'1',fingerprintMode:'top_level',inventory:[]}};}
  if(request.action==='managed-start')return overrides.start?overrides.start(request):{ok:true,state:'requested',rootIdentity:{path:'/scope'}};
  if(request.action==='managed-observe')return overrides.observe?overrides.observe(request):{ok:true,state:'pending',rootIdentity:{path:'/scope'}};
  if(request.action==='settle')return overrides.settle?overrides.settle(request):{ok:true,rootIdentity:{path:'/scope'},receipt:{fingerprintMode:'top_level'}};
  if(request.action==='isolate')return overrides.isolate?overrides.isolate(request):{ok:true,rootIdentity:{path:'/scope'},receipt:{phase:'completed'}};
  if(request.action==='check')return {ok:true,state:'pending',rootIdentity:{path:'/scope'}};
  assert.fail('unexpected action '+request.action);}});return {api,requests};}
const isolateTarget={relativePath:'outputs/run1',type:'directory',archiveBatch:BATCH,destination:'clean_dir/'+BATCH+'/outputs/run1',requiredInputs:['outputs/ckpt.bin']};

test('controlled isolation previews only through the fast top-level inspect and keeps the rerun batch identity',async()=>{
  const {api,requests}=makeApi();
  const preview=await api.preview({node:{kind:'remote',root:'/scope'},action:'isolate',observationMode:'managed_tmux',tmuxSessionPrefix:'research',targets:[{...isolateTarget}]});
  const inspected=requests.filter(request=>request.action==='inspect');
  assert.equal(inspected.length,1);assert.equal(inspected[0].isolate,true);
  assert.equal(preview.targets[0].fingerprintMode,'top_level');assert.equal(preview.targets[0].destination,isolateTarget.destination);
  assert.equal(preview.safety.isolateFast,1);assert.equal(preview.safety.requiredInputGuard,1);
  await api.confirm({token:preview.token,digest:preview.digest,phase:1,confirm:true,exactTargets:['/scope/outputs/run1']});
  await api.execute({token:preview.token,digest:preview.digest,index:0});
  const start=requests.find(request=>request.action==='managed-start');
  assert.equal(start.cleanupAction,'isolate');assert.equal(start.target.fingerprintMode,'top_level');
  assert.equal(start.target.destination,isolateTarget.destination);assert.equal(start.tmuxSessionPrefix,'research');
});

test('isolation gates reject a missing batch, a foreign destination, and unsafe required-input shapes',async()=>{
  const {api}=makeApi();
  await assert.rejects(api.preview({node:{kind:'remote',root:'/scope'},action:'isolate',targets:[{relativePath:'outputs/a',type:'directory',destination:'clean_dir/outputs/a'}]}),/UNSAFE_ARCHIVE_BATCH/);
  await assert.rejects(api.preview({node:{kind:'remote',root:'/scope'},action:'isolate',targets:[{relativePath:'outputs/a',type:'directory',archiveBatch:BATCH,destination:'clean_dir/outputs/a'}]}),/UNSAFE_DESTINATION/);
  await assert.rejects(api.preview({node:{kind:'remote',root:'/scope'},action:'isolate',targets:[{...isolateTarget,requiredInputs:['outputs/../etc/passwd']}]}),/INVALID_REQUEST/);
  await assert.rejects(api.preview({node:{kind:'remote',root:'/scope'},action:'isolate',targets:[{...isolateTarget,requiredInputs:'outputs/ckpt.bin'}]}),/INVALID_REQUEST/);
});

test('confirmed-path permanent deletion is confined to registered isolated artifact subtrees',async()=>{
  const {api,requests}=makeApi();
  for(const rel of ['clean_dir','clean_dir/MANIFEST.md','clean_dir/.operations/isolation','clean_dir/'+BATCH,'clean_dir/outputs/run1'])
    await assert.rejects(api.preview({node:{kind:'remote',root:'/scope'},action:'delete',authorizationMode:'confirmed_paths',targets:[{relativePath:rel,type:'directory',destination:rel}]}),/UNSAFE_DESTINATION/,rel);
  const rel='clean_dir/'+BATCH+'/outputs/run1';
  // A registered-shaped path must arrive with destination equal to itself.
  await assert.rejects(api.preview({node:{kind:'remote',root:'/scope'},action:'delete',authorizationMode:'confirmed_paths',
    targets:[{relativePath:rel,type:'directory',destination:'clean_dir/'+BATCH+'/outputs/other'}]}),/UNSAFE_DESTINATION/);
  assert.equal(requests.length,0);
});

test('confirmed isolated subtree preview demands the destination equal the registered path and advertises the guard',async()=>{
  const {api,requests}=makeApi();
  await assert.rejects(api.preview({node:{kind:'remote',root:'/scope'},action:'delete',authorizationMode:'confirmed_paths',
    targets:[{relativePath:'clean_dir/'+BATCH+'/outputs/run1',type:'directory',destination:'outputs/run1'}]}),/UNSAFE_DESTINATION/);
  const rel='clean_dir/'+BATCH+'/outputs/run1';
  const preview=await api.preview({node:{kind:'remote',root:'/scope'},action:'delete',authorizationMode:'confirmed_paths',
    targets:[{relativePath:rel,type:'directory',destination:rel}]});
  assert.equal(preview.safety.registeredIsolationDeletion,1);assert.equal(preview.safety.isolateFast,undefined);
  const inspected=requests.find(request=>request.action==='batch-inspect');
  assert.equal(inspected.targets[0].relativePath,rel);assert.equal(inspected.action,'batch-inspect');
  assert.equal(preview.targets[0].destination,rel);
  assert.equal(preview.safety.entryIdentityBind,1);assert.equal(preview.safety.batchedFastDelete,1);
  // Permanent deletion still needs the two exact confirmations.
  await api.confirm({token:preview.token,digest:preview.digest,phase:1,confirm:true,exactTargets:['/scope/'+rel]});
  await assert.rejects(api.execute({token:preview.token,digest:preview.digest,index:0}),/CONFIRM_REQUIRED/);
  await api.confirm({token:preview.token,digest:preview.digest,phase:2,confirm:true,exactTargets:['/scope/'+rel]});
});

test('observation of a frozen isolation carries the compact top-level identity and never the full inventory',async()=>{
  let observations=0;
  const {api,requests}=makeApi({observe:()=>{observations++;return observations===1
    ? {ok:true,state:'pending',rootIdentity:{path:'/scope'}}
    : {ok:true,state:'completed',verifiedBy:'completion_receipt',rootIdentity:{path:'/scope'}};}});
  const preview=await api.preview({node:{kind:'remote',root:'/scope'},action:'isolate',observationMode:'managed_tmux',targets:[{...isolateTarget}]});
  await api.confirm({token:preview.token,digest:preview.digest,phase:1,confirm:true,exactTargets:['/scope/outputs/run1']});
  await api.execute({token:preview.token,digest:preview.digest,index:0});
  const settled=await api.check({token:preview.token,digest:preview.digest,index:0});
  assert.equal(settled.state,'completed');assert.equal(settled.verifiedBy,'completion_receipt');
  const observed=requests.filter(request=>request.action==='managed-observe');
  const compact=observed[observed.length-1];
  assert.equal(compact.cleanupAction,'isolate');assert.equal(compact.target.fingerprintMode,'top_level');
  assert.equal(compact.target.inventory,undefined);assert.equal(compact.target.requiredInputs,undefined);
  assert.equal(compact.target.absolutePath,undefined);assert.match(compact.frozenTargetDigest,/^[a-f0-9]{64}$/);
});

test('a lost isolation response settles, re-preflights only on the fast inspect, and never re-hashes the tree',async()=>{
  let phase='first';
  const {api,requests}=makeApi({
    isolate:()=>{if(phase==='first'){phase='lost';return {ok:false,error:{code:'REQUEST_TIMEOUT',message:'the mutation response was lost'}};}return {ok:true,rootIdentity:{path:'/scope'},receipt:{phase:'completed'}};},
    settle:()=>{if(phase==='lost'){phase='retry';return {ok:false,error:{code:'SOURCE_RECREATED_OR_NOT_MOVED',message:'the remote lock has not settled yet'}};}return {ok:true,rootIdentity:{path:'/scope'},receipt:{fingerprintMode:'top_level'}};}
  });
  const preview=await api.preview({node:{kind:'remote',root:'/scope'},action:'isolate',targets:[{...isolateTarget}]});
  await api.confirm({token:preview.token,digest:preview.digest,phase:1,confirm:true,exactTargets:['/scope/outputs/run1']});
  await assert.rejects(api.execute({token:preview.token,digest:preview.digest,index:0}),error=>error.code==='REQUEST_TIMEOUT');
  const retry=await api.execute({token:preview.token,digest:preview.digest,index:0});
  assert.equal(retry.ok,true);assert.equal(retry.receipt.phase,'completed');
  const mutates=requests.filter(request=>request.action==='isolate');
  assert.equal(mutates.length,2);
  const settles=requests.filter(request=>request.action==='settle');
  assert.equal(settles.length,1);assert.equal(settles[0].settledAction,'isolate');
  assert.ok(requests.every(request=>request.action!=='inspect'||request.isolate===true));
  assert.ok(requests.every(request=>['inspect','isolate','settle'].includes(request.action)));
});

test('controlled fast isolation, subtree single-writer locks and registered permanent deletion hold against the real engine',()=>{
  assert.deepEqual(runFixture('planIsolate.fixture.py',10000),{ok:true,fastIsolate:true,subtreeLocks:true,registeredDeletion:true});
});
