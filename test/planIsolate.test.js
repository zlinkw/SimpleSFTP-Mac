const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os'),fs=require('node:fs');
const __CONSUMER__ = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'consumer-root-'));
const {spawnSync}=require('node:child_process');
const {CleanupFileApi}=require('../cleanup-file-api');
const linux=p=>'/mnt/'+p[0].toLowerCase()+p.slice(2).replace(/\\/g,'/');
function runFixture(name,timeout){const fixture=path.resolve(__dirname,name),engine=path.resolve(__dirname,'../cleanup-files.py');
  const args=process.platform==='win32'?['--distribution',process.env.SIMPLE_TEST_WSL_DISTRO||'Ubuntu-Codex','--exec','python3',linux(fixture),linux(engine)]:[fixture,engine];
  const proc=spawnSync(process.platform==='win32'?'wsl.exe':'python3',args,{encoding:'utf8',timeout,windowsHide:true});
  assert.equal(proc.status,0,proc.stderr||proc.stdout);return JSON.parse(proc.stdout);}
const BATCH='job-'+'a'.repeat(48);
test('confirmed isolation parent cleanup removes owned empty hierarchy and protects new contents',()=>{
 assert.deepEqual(runFixture('isolationEmptyParents.fixture.py',10000),{ok:true,onlyEmptyDirectories:true,legacySupported:true});
});
function makeApi(overrides={}){const requests=[];const api=new CleanupFileApi({storageRoot:path.join(os.tmpdir(),'plan-isolate-'+process.pid+'-'+Math.random().toString(36).slice(2)),activity:async()=>{},lease:async(_node,_targets,fn)=>fn(),transport:async request=>{requests.push(JSON.parse(JSON.stringify(request)));
  if(request.action==='batch-inspect')return {ok:true,rootIdentity:{path:'/scope'},capabilities:{confirmedPathFastDelete:1,batchEntryInspect:1},targets:request.targets.map(t=>({...t,absolutePath:'/scope/'+t.relativePath,archived:true,device:'1',inode:'7'}))};
  if(request.action==='inspect'){if(overrides.inspect)return overrides.inspect(request);
    return {ok:true,rootIdentity:{path:'/scope'},backgroundIsolatedDelete:1,target:{type:request.target.type,absolutePath:'/scope/'+request.target.relativePath,fingerprint:'top-'+request.target.relativePath,inode:'7',device:'1',fingerprintMode:'top_level',inventory:[]}};}
  if(request.action==='managed-start')return overrides.start?overrides.start(request):{ok:true,state:'requested',rootIdentity:{path:'/scope'}};
  if(request.action==='managed-observe')return overrides.observe?overrides.observe(request):{ok:true,state:'pending',rootIdentity:{path:'/scope'}};
  if(request.action==='settle')return overrides.settle?overrides.settle(request):{ok:true,rootIdentity:{path:'/scope'},receipt:{fingerprintMode:'top_level'}};
  if(request.action==='isolate')return overrides.isolate?overrides.isolate(request):{ok:true,rootIdentity:{path:'/scope'},receipt:{phase:'completed'}};
  if(request.action==='check')return {ok:true,state:'pending',rootIdentity:{path:'/scope'}};
  if(['inspect-isolation-parents','prune-isolation-parents','check-isolation-parents'].includes(request.action)&&overrides.parents)return overrides.parents(request);
  assert.fail('unexpected action '+request.action);}});return {api,requests};}
const isolateTarget={relativePath:'outputs/run1',type:'directory',archiveBatch:BATCH,destination:'clean_dir/'+BATCH+'/outputs/run1',requiredInputs:['outputs/ckpt.bin']};

test('empty container deletion requires its own exact two confirmations and is idempotent',async()=>{
 const parent='clean_dir/'+BATCH;let mutations=0;
 const {api}=makeApi({parents:request=>request.action==='inspect-isolation-parents'
  ? {ok:true,eligible:true,rootIdentity:{path:'/scope'},targets:[{relativePath:parent,absolutePath:'/scope/'+parent,type:'directory',future:true}]}
  : (mutations++,{ok:true,state:'completed',rootIdentity:{path:'/scope'},receipt:{phase:'completed',emptyDirectoriesRemoved:1}})});
 const source=await api.preview({consumerRoot:__CONSUMER__,node:{kind:'remote',root:'/scope'},action:'isolate',observationMode:'managed_tmux',targets:[{...isolateTarget}]});
 const preview=await api.previewIsolationParents({consumerRoot:__CONSUMER__,isolationToken:source.token,forReplacement:true});
 assert.equal(preview.sourceIsolationToken,source.token);
 assert.deepEqual(preview.confirmationPaths,['/scope/'+parent,'/scope/'+isolateTarget.destination]);
 const binding={consumerRoot:__CONSUMER__,token:preview.token,digest:preview.digest,index:0};
 await assert.rejects(api.execute(binding),/CONFIRM_REQUIRED/);
 await assert.rejects(api.confirm({...binding,phase:1,confirm:true,exactTargets:['/scope/clean_dir']}),/CONFIRM_REQUIRED/);
 await api.confirm({...binding,phase:1,confirm:true,exactTargets:preview.confirmationPaths});
 await assert.rejects(api.execute(binding),/CONFIRM_REQUIRED/);assert.equal(mutations,0);
 await api.confirm({...binding,phase:2,confirm:true,exactTargets:preview.confirmationPaths});
 assert.equal((await api.execute(binding)).state,'completed');assert.equal(mutations,1);
 assert.equal((await api.execute(binding)).state,'completed');assert.equal(mutations,1);
 const final=await api.status(binding);assert.deepEqual(final.targets,[]);assert.deepEqual(final.confirmationPaths,[]);
 const localSource=await api.preview({consumerRoot:__CONSUMER__,node:{kind:'local',root:__CONSUMER__},action:'isolate',targets:[{...isolateTarget}]});
 const localParents=await api.previewIsolationParents({consumerRoot:__CONSUMER__,isolationToken:localSource.token,forReplacement:true});
 assert.equal(localParents.confirmationPaths.at(-1),path.join(__CONSUMER__,isolateTarget.destination),'local confirmation uses native Windows paths');
});
test('parent review combines backend chunks of one isolation batch and resolves a lost answer by active absence without re-deleting',async()=>{
 let absent=false,mutations=0,unowned=false;const parent='clean_dir/'+BATCH;
 const {api,requests}=makeApi({parents:request=>{
  if(request.action==='inspect-isolation-parents')return{ok:true,eligible:true,rootIdentity:{path:'/scope'},targets:unowned?[]:[{relativePath:parent,absolutePath:'/scope/'+parent,type:'directory',future:true}]};
  if(request.action==='check-isolation-parents')return{ok:true,rootIdentity:{path:'/scope'},state:absent?'completed':'unknown'};
  mutations++;return{ok:false,error:{code:'REQUEST_TIMEOUT',message:'lost response'}};
 }});
 const sources=[];
 for(const name of ['one','two'])sources.push(await api.preview({consumerRoot:__CONSUMER__,node:{kind:'remote',root:'/scope'},action:'isolate',targets:[{...isolateTarget,relativePath:'outputs/'+name,destination:'clean_dir/'+BATCH+'/outputs/'+name}]}));
 const preview=await api.previewIsolationParents({consumerRoot:__CONSUMER__,isolationTokens:sources.map(row=>row.token),forReplacement:true});
 assert.deepEqual(preview.sourceIsolationTokens,sources.map(row=>row.token));
 assert.equal(requests.find(row=>row.action==='inspect-isolation-parents').destinations.length,2);
 const binding={consumerRoot:__CONSUMER__,token:preview.token,digest:preview.digest,index:0};
 for(const phase of [1,2])await api.confirm({...binding,phase,confirm:true,exactTargets:preview.confirmationPaths});
 await assert.rejects(api.execute(binding),/lost response/);assert.equal(mutations,1);
 await assert.rejects(api.execute(binding),/OPERATION_OUTCOME_UNKNOWN/);
 assert.equal((await api.status(binding)).parentOutcome,'unknown');absent=true;
 assert.equal((await api.status(binding)).parentOutcome,'completed');
 assert.equal((await api.execute(binding)).state,'completed');assert.equal(mutations,1);
 unowned=true;const artifactsOnly=await api.previewIsolationParents({consumerRoot:__CONSUMER__,isolationTokens:sources.map(row=>row.token),forReplacement:true});
 assert.equal(artifactsOnly.eligible,true);assert.deepEqual(artifactsOnly.targets,[]);
 assert.equal(artifactsOnly.confirmationPaths.length,2,'artifact deletion still requires its own two exact confirmations when no parent is owned');
 await assert.rejects(api.execute({consumerRoot:__CONSUMER__,token:artifactsOnly.token,digest:artifactsOnly.digest,index:0}),/CONFIRM_REQUIRED/);
});

test('controlled isolation previews only through the fast top-level inspect and keeps the rerun batch identity',async()=>{
  const {api,requests}=makeApi();
  const preview=await api.preview({consumerRoot: __CONSUMER__, node:{kind:'remote',root:'/scope'},action:'isolate',observationMode:'managed_tmux',tmuxSessionPrefix:'research',targets:[{...isolateTarget}]});
  const inspected=requests.filter(request=>request.action==='inspect');
  assert.equal(inspected.length,1);assert.equal(inspected[0].isolate,true);
  assert.equal(preview.targets[0].fingerprintMode,'top_level');assert.equal(preview.targets[0].destination,isolateTarget.destination);
  assert.equal(preview.safety.isolateFast,1);assert.equal(preview.safety.requiredInputGuard,1);
  await api.confirm({consumerRoot: __CONSUMER__, token:preview.token,digest:preview.digest,phase:1,confirm:true,exactTargets:['/scope/outputs/run1']});
  await api.execute({consumerRoot: __CONSUMER__, token:preview.token,digest:preview.digest,index:0});
  const start=requests.find(request=>request.action==='managed-start');
  assert.equal(start.cleanupAction,'isolate');assert.equal(start.target.fingerprintMode,'top_level');
  assert.equal(start.target.destination,isolateTarget.destination);assert.equal(start.tmuxSessionPrefix,'research');
});

test('isolation gates reject a missing batch, a foreign destination, and unsafe required-input shapes',async()=>{
  const {api}=makeApi();
  await assert.rejects(api.preview({consumerRoot: __CONSUMER__, node:{kind:'remote',root:'/scope'},action:'isolate',targets:[{relativePath:'outputs/a',type:'directory',destination:'clean_dir/outputs/a'}]}),/UNSAFE_ARCHIVE_BATCH/);
  await assert.rejects(api.preview({consumerRoot: __CONSUMER__, node:{kind:'remote',root:'/scope'},action:'isolate',targets:[{relativePath:'outputs/a',type:'directory',archiveBatch:BATCH,destination:'clean_dir/outputs/a'}]}),/UNSAFE_DESTINATION/);
  await assert.rejects(api.preview({consumerRoot: __CONSUMER__, node:{kind:'remote',root:'/scope'},action:'isolate',targets:[{...isolateTarget,requiredInputs:['outputs/../etc/passwd']}]}),/INVALID_REQUEST/);
  await assert.rejects(api.preview({consumerRoot: __CONSUMER__, node:{kind:'remote',root:'/scope'},action:'isolate',targets:[{...isolateTarget,requiredInputs:'outputs/ckpt.bin'}]}),/INVALID_REQUEST/);
});

test('confirmed-path permanent deletion is confined to registered isolated artifact subtrees',async()=>{
  const {api,requests}=makeApi();
  for(const rel of ['clean_dir','clean_dir/MANIFEST.md','clean_dir/.operations/isolation','clean_dir/'+BATCH,'clean_dir/outputs/run1'])
    await assert.rejects(api.preview({consumerRoot: __CONSUMER__, node:{kind:'remote',root:'/scope'},action:'delete',authorizationMode:'confirmed_paths',targets:[{relativePath:rel,type:'directory',destination:rel}]}),/UNSAFE_DESTINATION/,rel);
  const rel='clean_dir/'+BATCH+'/outputs/run1';
  // A registered-shaped path must arrive with destination equal to itself.
  await assert.rejects(api.preview({consumerRoot: __CONSUMER__, node:{kind:'remote',root:'/scope'},action:'delete',authorizationMode:'confirmed_paths',
    targets:[{relativePath:rel,type:'directory',destination:'clean_dir/'+BATCH+'/outputs/other'}]}),/UNSAFE_DESTINATION/);
  assert.equal(requests.length,0);
});

test('confirmed isolated subtree preview demands the destination equal the registered path and advertises the guard',async()=>{
  const {api,requests}=makeApi();
  await assert.rejects(api.preview({consumerRoot: __CONSUMER__, node:{kind:'remote',root:'/scope'},action:'delete',authorizationMode:'confirmed_paths',
    targets:[{relativePath:'clean_dir/'+BATCH+'/outputs/run1',type:'directory',destination:'outputs/run1'}]}),/UNSAFE_DESTINATION/);
  const rel='clean_dir/'+BATCH+'/outputs/run1';
  const preview=await api.preview({consumerRoot: __CONSUMER__, node:{kind:'remote',root:'/scope'},action:'delete',authorizationMode:'confirmed_paths',
    targets:[{relativePath:rel,type:'directory',destination:rel}]});
  assert.equal(preview.safety.registeredIsolationDeletion,1);assert.equal(preview.safety.isolateFast,undefined);
  const inspected=requests.find(request=>request.action==='batch-inspect');
  assert.equal(inspected.targets[0].relativePath,rel);assert.equal(inspected.action,'batch-inspect');
  assert.equal(preview.targets[0].destination,rel);
  assert.equal(preview.safety.entryIdentityBind,1);assert.equal(preview.safety.batchedFastDelete,1);
  // Permanent deletion still needs the two exact confirmations.
  await api.confirm({consumerRoot: __CONSUMER__, token:preview.token,digest:preview.digest,phase:1,confirm:true,exactTargets:['/scope/'+rel]});
  await assert.rejects(api.execute({consumerRoot: __CONSUMER__, token:preview.token,digest:preview.digest,index:0}),/CONFIRM_REQUIRED/);
  await api.confirm({consumerRoot: __CONSUMER__, token:preview.token,digest:preview.digest,phase:2,confirm:true,exactTargets:['/scope/'+rel]});
});

test('observation of a frozen isolation carries the compact top-level identity and never the full inventory',async()=>{
  let observations=0;
  const {api,requests}=makeApi({observe:()=>{observations++;return observations===1
    ? {ok:true,state:'pending',rootIdentity:{path:'/scope'}}
    : {ok:true,state:'completed',verifiedBy:'completion_receipt',rootIdentity:{path:'/scope'}};}});
  const preview=await api.preview({consumerRoot: __CONSUMER__, node:{kind:'remote',root:'/scope'},action:'isolate',observationMode:'managed_tmux',targets:[{...isolateTarget}]});
  await api.confirm({consumerRoot: __CONSUMER__, token:preview.token,digest:preview.digest,phase:1,confirm:true,exactTargets:['/scope/outputs/run1']});
  await api.execute({consumerRoot: __CONSUMER__, token:preview.token,digest:preview.digest,index:0});
  const settled=await api.check({consumerRoot: __CONSUMER__, token:preview.token,digest:preview.digest,index:0});
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
  const preview=await api.preview({consumerRoot: __CONSUMER__, node:{kind:'remote',root:'/scope'},action:'isolate',targets:[{...isolateTarget}]});
  await api.confirm({consumerRoot: __CONSUMER__, token:preview.token,digest:preview.digest,phase:1,confirm:true,exactTargets:['/scope/outputs/run1']});
  await assert.rejects(api.execute({consumerRoot: __CONSUMER__, token:preview.token,digest:preview.digest,index:0}),error=>error.code==='REQUEST_TIMEOUT');
  const retry=await api.execute({consumerRoot: __CONSUMER__, token:preview.token,digest:preview.digest,index:0});
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

test('the isolate hot path runs one live inspect, one rename and no post-rename re-check of the isolated copy',()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'../cleanup-files.py'),'utf8').replace(/\r\n/g,'\n');
  const start=source.indexOf('    if action == "isolate":\n');
  const end=source.indexOf('    archived_control = archived_control_rel(target)',start);
  assert.ok(start>0&&end>start,'isolate branch anchors missing');
  const branch=source.slice(start,end);
  assert.equal((branch.match(/isolate_inspect\(/g)||[]).length,1,'exactly one live inspect inside the isolate branch');
  assert.ok(!branch.includes('checked["fingerprint"] != value["fingerprint"]'),'the retired second full inspect comparison must stay gone');
  assert.equal((branch.match(/no_replace\(/g)||[]).length,1,'exactly one non-overwriting atomic rename');
  assert.ok(!branch.includes('top_identity(value["destination"]'),'the isolated copy must not be re-stat-ed after the rename');
  // The structural pre-rename checks stay: destination non-overwrite, path_guard, verified direct parent.
  assert.ok(branch.includes('deny("DESTINATION_EXISTS", value["destination"])'),'destination non-overwrite stays immediately before the rename');
  assert.equal((branch.match(/path_guard\(root, target\["destination"\], True, True\)/g)||[]).length,2,'path_guard re-runs around the destination creation');
  assert.match(branch,/child = parent_cd\(root, value\["absolutePath"\]\)/,'the rename runs from the verified direct parent');
  assert.match(branch,/deny\("SOURCE_STILL_EXISTS"\)/,'source absence is confirmed at the moment of the move');
  assert.ok(branch.indexOf('register_isolation(')<branch.indexOf('{**record, "phase": "completed"}'),'registration lands before the completed audit line');
  for(const key of ['"isolationCompletionProtocol": 1','"renameCommitted": True','"sourceMissingAtMove": True','"registered": True','"executorsChecked": True','"executors": value["executors"]'])
    assert.ok(branch.includes(key),'completion receipt must carry '+key);
  // Honest wording: the receipt must never claim the isolated content was re-verified.
  assert.match(branch,/NOT re-read here/,'completion comment must state the copy is not re-read');
});

test('the isolation completion receipt binds token, batch and exact paths and is persisted with the ledger row',async()=>{
  const completion={isolationCompletionProtocol:1,archiveBatch:BATCH,sourceRelativePath:isolateTarget.relativePath,destinationRelativePath:isolateTarget.destination,
    renameCommitted:true,sourceMissingAtMove:true,registered:true,executorsChecked:true,executors:[]};
  const {api,requests}=makeApi({isolate:()=>({ok:true,rootIdentity:{path:'/scope'},receipt:{operationId:'op',action:'isolate',phase:'completed',...completion}})});
  const preview=await api.preview({consumerRoot: __CONSUMER__, node:{kind:'remote',root:'/scope'},action:'isolate',targets:[{...isolateTarget}]});
  assert.equal(preview.safety.isolationCompletionReceipt,1,'the isolate preview must advertise the completion receipt');
  assert.equal(preview.safety.backgroundIsolatedDelete,1,'the isolate preview must report the SE-published capability flag verbatim');
  await api.confirm({consumerRoot: __CONSUMER__, token:preview.token,digest:preview.digest,phase:1,confirm:true,exactTargets:['/scope/outputs/run1']});
  const executed=await api.execute({consumerRoot: __CONSUMER__, token:preview.token,digest:preview.digest,index:0});
  assert.equal(executed.ok,true);
  const stored=await api.read(preview.token, __CONSUMER__);
  const receipt=stored.receipts[0];
  assert.equal(receipt.phase,'completed');assert.equal(receipt.isolationCompletionProtocol,1);
  assert.equal(receipt.archiveBatch,BATCH);
  assert.equal(receipt.sourceRelativePath,'outputs/run1');assert.equal(receipt.destinationRelativePath,isolateTarget.destination);
  assert.equal(receipt.renameCommitted,true);assert.equal(receipt.sourceMissingAtMove,true);assert.equal(receipt.registered,true);
  assert.equal(receipt.executorsChecked,true);assert.deepEqual(receipt.executors,[]);
  assert.equal(requests.filter(request=>request.action==='isolate').length,1);
});

test('a registration refusal after the rename stays unknown: the retry settles once and never re-sends the rename',async()=>{
  let phase='first';
  const {api,requests}=makeApi({
    isolate:()=>{if(phase==='first'){phase='registered';return {ok:false,error:{code:'CLEANUP_CONTROL_CHANGED',message:'登记在 rename 之后失败'}};}return {ok:true,rootIdentity:{path:'/scope'},receipt:{phase:'completed'}};},
    settle:()=>({ok:true,rootIdentity:{path:'/scope'},receipt:{phase:'completed',settledBy:'frozen_binding',fingerprintMode:'top_level'}})
  });
  const preview=await api.preview({consumerRoot: __CONSUMER__, node:{kind:'remote',root:'/scope'},action:'isolate',targets:[{...isolateTarget}]});
  await api.confirm({consumerRoot: __CONSUMER__, token:preview.token,digest:preview.digest,phase:1,confirm:true,exactTargets:['/scope/outputs/run1']});
  await assert.rejects(api.execute({consumerRoot: __CONSUMER__, token:preview.token,digest:preview.digest,index:0}),error=>error.code==='CLEANUP_CONTROL_CHANGED');
  const mid=await api.read(preview.token, __CONSUMER__);
  assert.equal(mid.states[0],'executing','a failed registration after the rename is unknown, never pending-completed');
  const retry=await api.execute({consumerRoot: __CONSUMER__, token:preview.token,digest:preview.digest,index:0});
  assert.equal(retry.ok,true);assert.equal(retry.settled,true);
  assert.equal(requests.filter(request=>request.action==='isolate').length,1,'settlement must never re-send the committed rename');
  assert.equal(requests.filter(request=>request.action==='settle').length,1);
  const stored=await api.read(preview.token, __CONSUMER__);
  assert.equal(stored.states[0],'completed');
  // Honesty: a settle-repaired receipt carries no fabricated move-time completion facts.
  assert.equal(stored.receipts[0].isolationCompletionProtocol,undefined);
  assert.equal(stored.receipts[0].renameCommitted,undefined);
});
