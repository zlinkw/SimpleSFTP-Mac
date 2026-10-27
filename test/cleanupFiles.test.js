const test=require('node:test');
const __CONSUMER__ = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'consumer-root-'));
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const vm=require('node:vm');
const {CleanupFileApi}=require('../cleanup-file-api');
const engine=path.join(__dirname,'..','cleanup-files.py');
const root=()=>fs.mkdtempSync(path.join(os.tmpdir(),'simple-sftp-cleanup-fixture-'));
function run(request){const child=spawnSync('python',['-B','-X','utf8',engine],{input:JSON.stringify(request),encoding:'utf8',windowsHide:true,timeout:8000});assert.equal(child.status,0,child.stderr||child.error?.message);return JSON.parse(child.stdout);}
function write(base,rel,contents='验证 fixture\n'){fs.mkdirSync(path.dirname(path.join(base,rel)),{recursive:true});fs.writeFileSync(path.join(base,rel),contents,'utf8');}
function inspect(base,rel,type='file'){return run({root:base,action:'inspect',target:{relativePath:rel,destination:'clean_dir/'+rel,type}});}

test('reconnection receipt checks are zero-write, detect changed sources and never settle an uncertain deletion',()=>{
  const base=root(),rel='output/a.csv';write(base,rel,'fixture');const preview=inspect(base,rel),target={...preview.target,relativePath:rel,destination:'clean_dir/'+rel,type:'file'};
  const request={root:base,rootIdentity:preview.rootIdentity,action:'check',target};
  assert.equal(run(request).state,'pending');assert.equal(fs.existsSync(path.join(base,'clean_dir')),false);
  assert.equal(run({...request,rootIdentity:{...preview.rootIdentity,inode:'changed'}}).error.code,'ROOT_IDENTITY_CHANGED');
  assert.equal(run({root:base,action:'inventory',allowMissing:true,target:{relativePath:'output/missing.csv',type:'file'}}).target.missing,true);
  const moved=run({...request,action:'move',operationId:'fixture-check'});assert.equal(moved.ok,true);
  const audit=fs.readFileSync(path.join(base,'clean_dir/MANIFEST.md'),'utf8');assert.equal(run(request).state,'completed');assert.equal(fs.readFileSync(path.join(base,'clean_dir/MANIFEST.md'),'utf8'),audit);
  assert.equal(run({...request,deleted:true}).state,'absent_unverified');assert.equal(run({...request,deleted:true,receiptCompleted:true}).state,'completed');
  write(base,rel,'new attempt');assert.equal(run(request).error.code,'SOURCE_RECREATED_OR_CHANGED');
});

test('file API receipt observation starts no mutation, journal or lease and advertises the live read-only contract',async()=>{
  const base=root(),node={id:'local',kind:'local',root:base},requests=[];
  const api=new CleanupFileApi({storageRoot:path.join(base,'state'),activity:async()=>{},lease:()=>assert.fail('readonly check cannot lease a mutation'),
    transport:async request=>{requests.push(request);return {ok:true,rootIdentity:{path:base},...(request.action==='check'?{state:'pending'}:{target:{absolutePath:base+'/output/a.csv',fingerprint:'fp',contentFingerprint:'fp'}})}}});
  const p=await api.preview({consumerRoot: __CONSUMER__, node,targets:[{relativePath:'output/a.csv',type:'file',destination:'clean_dir/output/a.csv'}]});assert.equal(p.safety.readOnlyReceiptCheck,true);
  assert.equal((await api.check({consumerRoot: __CONSUMER__, token:p.token,index:0})).state,'pending');assert.ok(requests.every(request=>['inspect','check'].includes(request.action)));assert.equal(fs.existsSync(path.join(base,'state')),false);
  const source=fs.readFileSync(require.resolve('../extension.js'),'utf8'),server=fs.readFileSync(require.resolve('../api-server.js'),'utf8');
  assert.match(source,/"files.cleanup.check": \{ readOnly: true, zeroWrites: true/);assert.ok(server.includes('"files.cleanup.check", "files.cleanup.preview"'));
});

test('archive exclusion survives custom ignores and explicit artifact paths without executing transfers',()=>{
  const source=fs.readFileSync(require.resolve('../extension.js'),'utf8');
  const extract=name=>{const start=source.indexOf('function '+name+'('),end=source.indexOf('\nfunction ',start+1);assert.ok(start>=0&&end>start);return source.slice(start,end)};
  const context={Set,Buffer,process:{platform:'darwin'},normalizeMacRelativePath:require('../workspace-path').normalizeMacRelativePath,toPosixPath:value=>String(value).replaceAll('\\','/')};vm.createContext(context);
  for(const name of ['directSyncRelativePath','isIgnoredLocalPath','getTarExcludeArgs','addTarExcludePattern'])vm.runInContext(extract(name),context);
  context.DEFAULT_HANDOFF_MARKER='.fixture';
  assert.equal(context.isIgnoredLocalPath('clean_dir/work_dirs/a',[]),true);
  assert.throws(()=>context.directSyncRelativePath('clean_dir/work_dirs/a'),/归档目录/);
  assert.ok(context.getTarExcludeArgs([]).some(value=>value.includes('clean_dir')));
});

test('local preview is zero-write, fixed types and unsafe paths fail closed',()=>{
  const base=root();write(base,'output/a.csv');const before=fs.readdirSync(base),r=inspect(base,'output/a.csv');assert.equal(r.ok,true);assert.deepEqual(fs.readdirSync(base),before);
  for(const rel of ['../escape','/absolute','output/*','output/../a','.git/config','clean_dir/MANIFEST.md'])assert.equal(inspect(base,rel).ok,false);
  assert.equal(inspect(base,'output/a.csv','directory').error.code,'TYPE_CHANGED');
  write(base,'root.csv');assert.equal(inspect(base,'root.csv').ok,true);
  assert.equal(run({root:path.parse(base).root,action:'inspect',target:{relativePath:'x',destination:'clean_dir/x',type:'file'}}).error.code,'UNSAFE_ROOT');
});
test('Windows path spelling aliases preserve physical root identity and read-only preview safety', {skip:process.platform!=='win32'},()=>{
  const base=root();write(base,'Output/A.csv','fixture');
  const original=inspect(base,'Output/A.csv');assert.equal(original.ok,true);
  const alias=inspect(base.toLowerCase(),'output/a.csv');assert.equal(alias.ok,true,JSON.stringify(alias));
  assert.deepEqual(alias.rootIdentity,original.rootIdentity);assert.equal(alias.target.absolutePath,original.target.absolutePath);
  assert.equal(alias.target.fingerprint,original.target.fingerprint);assert.equal(fs.existsSync(path.join(base,'clean_dir')),false);
});
test('no-overwrite local move preserves fingerprints, identity and manifest, never visits production roots',()=>{
  const base=root();write(base,'job/attempt/weights.pt','fixture weights');write(base,'job/attempt/metric.csv','value\n1\n');
  const preview=inspect(base,'job/attempt','directory');assert.equal(preview.ok,true);
  const result=run({root:base,action:'move',operationId:'fixture-move',rootIdentity:preview.rootIdentity,target:{...preview.target,relativePath:'job/attempt',destination:'clean_dir/job/attempt',type:'directory'}});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(fs.existsSync(path.join(base,'job/attempt')),false);assert.equal(fs.readFileSync(path.join(base,'clean_dir/job/attempt/weights.pt'),'utf8'),'fixture weights');
  const rows=fs.readFileSync(path.join(base,'clean_dir/MANIFEST.md'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(rows.at(-1).phase,'completed');assert.equal(rows.at(-1).contentFingerprint,preview.target.contentFingerprint);
  write(base,'job/attempt/new.csv');assert.equal(inspect(base,'job/attempt','directory').error.code,'DESTINATION_EXISTS');
});
test('hash/type changes, protected descendants and ownership manifest mismatch refuse move',()=>{
  const base=root();write(base,'output/a.csv','A');const preview=inspect(base,'output/a.csv');write(base,'output/a.csv','B');
  const result=run({root:base,action:'move',operationId:'fixture-hash',rootIdentity:preview.rootIdentity,target:{...preview.target,relativePath:'output/a.csv',destination:'clean_dir/output/a.csv',type:'file'}});
  assert.equal(result.error.code,'PREVIEW_CHANGED');assert.equal(fs.readFileSync(path.join(base,'output/a.csv'),'utf8'),'B');
  write(base,'output/job/.git/config');assert.equal(inspect(base,'output/job','directory').error.code,'PROTECTED_DESCENDANT');
  write(base,'output/attempt/artifact_manifest.json',JSON.stringify({commandId:'foreign'}));
  assert.equal(run({root:base,action:'inspect',target:{relativePath:'output/attempt',destination:'clean_dir/output/attempt',type:'directory',expectedOwner:{commandId:'expected'}}}).error.code,'OWNERSHIP_MISMATCH');
  write(base,'output/attempt/artifact_manifest.json',JSON.stringify({output_dir:'work_dirs/foreign'}));
  assert.equal(run({root:base,action:'inspect',target:{relativePath:'output/attempt',destination:'clean_dir/output/attempt',type:'directory',expectedOwner:{outputDir:'output/attempt'}}}).error.code,'OWNERSHIP_MISMATCH');
});
test('dirty tracked PLAN is retained',()=>{
  const base=root();write(base,'plans/p.yaml');
  for(const args of [['init','-q'],['add','plans/p.yaml']]){const child=spawnSync('git',args,{cwd:base,windowsHide:true,encoding:'utf8',timeout:5000});assert.equal(child.status,0,child.stderr);}
  assert.equal(inspect(base,'plans/p.yaml').error.code,'DIRTY_TRACKED_TARGET');assert.ok(fs.existsSync(path.join(base,'plans/p.yaml')));
});
test('workspace below a Git repository retains dirty tracked targets',()=>{
  const base=root(),workspace=path.join(base,'workspace');write(base,'workspace/plans/p.yaml');
  for(const args of [['init','-q'],['add','workspace/plans/p.yaml']]){const child=spawnSync('git',args,{cwd:base,windowsHide:true,encoding:'utf8',timeout:5000});assert.equal(child.status,0,child.stderr);}
  assert.equal(inspect(workspace,'plans/p.yaml').error.code,'DIRTY_TRACKED_TARGET');assert.ok(fs.existsSync(path.join(workspace,'plans/p.yaml')));
});
test('dirty tracked PLAN in a Git worktree is protected even when .git is a file',()=>{
  const base=root(),repo=path.join(base,'repository'),worktree=path.join(base,'worktree');fs.mkdirSync(repo);write(repo,'plans/p.yaml','mode: train\n');
  for(const args of [['init','-q'],['add','plans/p.yaml'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','fixture'],['worktree','add','-q','--detach',worktree]]) {
    const child=spawnSync('git',args,{cwd:repo,windowsHide:true,encoding:'utf8',timeout:8000});assert.equal(child.status,0,child.stderr);
  }
  write(worktree,'plans/p.yaml','mode: test\n');assert.equal(fs.statSync(path.join(worktree,'.git')).isFile(),true);
  assert.equal(inspect(worktree,'plans/p.yaml').error.code,'DIRTY_TRACKED_TARGET');assert.ok(fs.existsSync(path.join(worktree,'plans/p.yaml')));
});
test('parent cwd failure, mount/link guards and separate deletion executors use only a direct child (deletion mocked)',()=>{
  const base=root();write(base,'output/a.txt');
  const script=path.join(base,'guard_checks.py');
  fs.writeFileSync(script,`import importlib.util,json,os,sys\nfrom unittest.mock import patch\nspec=importlib.util.spec_from_file_location('cleanup',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nroot=sys.argv[2];full=os.path.join(root,'output','a.txt');results={}\nwith patch.object(m.os,'chdir',side_effect=OSError('denied')):\n try:m.parent_cd(root,full)\n except m.GuardError as e:results['parent']=e.code\nwith patch.object(m.os.path,'ismount',side_effect=lambda p:p==full):\n try:m.path_guard(root,'output/a.txt')\n except m.GuardError as e:results['mount']=e.code\nwith patch.object(m.stat,'S_ISLNK',return_value=True):\n try:m.path_guard(root,'output/a.txt')\n except m.GuardError as e:results['link']=e.code\nseen=[]\nwith patch.object(m.os,'unlink',side_effect=lambda value:seen.append([value,os.getcwd()])):m.delete_file(root,full,m.contents(root,full,'file')['inventory'][0])\nresults['delete']=seen;results['exists']=os.path.exists(full)\nprint(json.dumps(results))\n`,'utf8');
  const child=spawnSync('python',['-B','-X','utf8',script,engine,base],{encoding:'utf8',windowsHide:true,timeout:8000});assert.equal(child.status,0,child.stderr);const r=JSON.parse(child.stdout);
  assert.equal(r.parent,'PARENT_CD_FAILED');assert.equal(r.mount,'MOUNT_ESCAPE');assert.equal(r.link,'LINK_OR_REPARSE_POINT');assert.deepEqual(r.delete,[['./a.txt',path.join(base,'output')]]);assert.equal(r.exists,true);
});
test('safe restore checks destination absence and inode/content identity',()=>{
  const base=root();write(base,'output/a.csv');const preview=inspect(base,'output/a.csv');
  assert.equal(run({root:base,action:'move',operationId:'fixture-restore-move',rootIdentity:preview.rootIdentity,target:{...preview.target,relativePath:'output/a.csv',destination:'clean_dir/output/a.csv',type:'file'}}).ok,true);
  const restoredPreview=run({root:base,action:'inspect',archived:true,target:{relativePath:'clean_dir/output/a.csv',destination:'output/a.csv',type:'file'}});assert.equal(restoredPreview.ok,true);
  write(base,'output/a.csv','new plan');assert.equal(run({root:base,action:'restore',operationId:'fixture-restore',rootIdentity:restoredPreview.rootIdentity,target:{...restoredPreview.target,relativePath:'clean_dir/output/a.csv',destination:'output/a.csv',type:'file'}}).error.code,'DESTINATION_EXISTS');assert.equal(fs.readFileSync(path.join(base,'output/a.csv'),'utf8'),'new plan');
});
test('file API confirmations are immutable, persisted, separate and never use remembered paths',async()=>{
  const base=root();let mutations=0,changed=false;const node={kind:'local',root:base,id:'local'},target={relativePath:'job/a',destination:'clean_dir/job/a',type:'file'};
  const api=new CleanupFileApi({storageRoot:path.join(base,'journal'),activity:async()=>{},lease:async(n,t,work)=>work(),transport:async request=>{
    if(request.action==='inspect')return {ok:true,rootIdentity:{path:base},target:{fingerprint:changed?'B':'A',contentFingerprint:'A',absolutePath:path.join(base,'job/a'),inode:'1'}};
    mutations++;return {ok:true,receipt:{phase:'completed'}};
  }});
  const p=await api.preview({consumerRoot: __CONSUMER__, node,action:'delete',targets:[target]});assert.equal(fs.existsSync(path.join(base,'journal')),false);
  await assert.rejects(api.preview({consumerRoot: __CONSUMER__, node,targets:[{...target,destination:'models/replacement'}]}),/UNSAFE_DESTINATION/);
  await assert.rejects(api.execute({consumerRoot: __CONSUMER__, token:p.token,digest:p.digest,index:0}),/CONFIRM_REQUIRED/);
  await api.confirm({consumerRoot: __CONSUMER__, token:p.token,digest:p.digest,confirm:true,phase:1,exactTargets:p.targets.map(t=>t.absolutePath)});
  await assert.rejects(api.execute({consumerRoot: __CONSUMER__, token:p.token,digest:p.digest,index:0}),/CONFIRM_REQUIRED/);
  await assert.rejects(api.confirm({consumerRoot: __CONSUMER__, token:p.token,digest:p.digest,confirm:true,phase:2,exactTargets:['/other']}),/CONFIRM_REQUIRED/);
  await api.confirm({consumerRoot: __CONSUMER__, token:p.token,digest:p.digest,confirm:true,phase:2,exactTargets:p.targets.map(t=>t.absolutePath)});changed=true;
  await assert.rejects(api.execute({consumerRoot: __CONSUMER__, token:p.token,digest:p.digest,index:0}),/PREVIEW_CHANGED/);assert.equal(mutations,0);
});
test('activity and audit/permission errors stop without a successful receipt',async()=>{
  const base=root();let mutated=0;
  const active=new CleanupFileApi({storageRoot:base,transport:async()=>{mutated++},activity:async()=>{throw new Error('ACTIVE_TRANSFER')},lease:async(n,t,w)=>w()});
  await assert.rejects(active.preview({consumerRoot: __CONSUMER__, node:{root:base},targets:[{type:'file',relativePath:'output/a',destination:'clean_dir/output/a'}]}),/ACTIVE_TRANSFER/);assert.equal(mutated,0);
  const denied=new CleanupFileApi({storageRoot:base,transport:async()=>({ok:false,error:{code:'PERMISSION_DENIED'}}),activity:async()=>{},lease:async(n,t,w)=>w()});
  await assert.rejects(denied.preview({consumerRoot: __CONSUMER__, node:{root:base},targets:[{type:'file',relativePath:'output/a',destination:'clean_dir/output/a'}]}),/PERMISSION_DENIED/);
});
test('verified absent targets never grant authority to a later recreated file',async()=>{
  const base=root(),node={id:'local',kind:'local',root:base};write(base,'output/present.csv');
  const api=new CleanupFileApi({storageRoot:path.join(base,'state'),transport:async r=>run(r),activity:async()=>{},lease:async(n,t,w)=>w()});
  const p=await api.preview({consumerRoot: __CONSUMER__, node,targets:[{relativePath:'output/present.csv',destination:'clean_dir/output/present.csv',type:'file'},{relativePath:'output/absent.csv',destination:'clean_dir/output/absent.csv',type:'file'}]});
  assert.deepEqual(p.states,['pending','absent']);await api.confirm({consumerRoot: __CONSUMER__, token:p.token,digest:p.digest,confirm:true,phase:1,exactTargets:p.targets.filter(t=>!t.missing).map(t=>t.absolutePath)});
  write(base,'output/absent.csv','new job');await assert.rejects(api.execute({consumerRoot: __CONSUMER__, token:p.token,digest:p.digest,index:0}),/PREVIEW_CHANGED/);
  await assert.rejects(api.execute({consumerRoot: __CONSUMER__, token:p.token,digest:p.digest,index:1}),/NOT_AN_EXECUTABLE_TARGET/);assert.ok(fs.existsSync(path.join(base,'output/present.csv')));
});
test('lost move response settles through the receipt and never repeats the mutation; audit excludes tokens',async()=>{
  const base=root(),node={id:'local',kind:'local',root:base};let mutations=0;
  const api=new CleanupFileApi({storageRoot:path.join(base,'state'),activity:async()=>{},lease:async(n,t,w)=>w(),transport:async r=>{
    if(r.action==='inspect')return {ok:true,rootIdentity:{path:base},target:{fingerprint:'f',contentFingerprint:'f',absolutePath:path.join(base,'a'),inode:'1'}};
    if(r.action==='move'){mutations++;assert.notEqual(r.operationId,p.token);throw new Error('lost response');}
    if(r.action==='settle')return {ok:true,receipt:{phase:'completed',contentFingerprint:'f'}};
    throw new Error(r.action);
  }});
  const p=await api.preview({consumerRoot: __CONSUMER__, node,targets:[{relativePath:'a',destination:'clean_dir/a',type:'file'}]});await api.confirm({consumerRoot: __CONSUMER__, token:p.token,digest:p.digest,confirm:true,phase:1,exactTargets:p.targets.map(t=>t.absolutePath)});
  await assert.rejects(api.execute({consumerRoot: __CONSUMER__, token:p.token,digest:p.digest,index:0}),/lost response/);
  const result=await api.execute({consumerRoot: __CONSUMER__, token:p.token,digest:p.digest,index:0});assert.equal(result.settled,true);assert.equal(mutations,1);
});
test('receipt-only settlement cannot launch a move and refuses an uncertain deletion receipt',async()=>{
  const base=root(),node={id:'local',kind:'local',root:base};let moves=0;
  const api=new CleanupFileApi({storageRoot:path.join(base,'state'),activity:async()=>{},lease:async(n,t,w)=>w(),transport:async request=>{
    if(request.action==='inspect')return {ok:true,rootIdentity:{path:base},target:{fingerprint:'f',contentFingerprint:'f',absolutePath:path.join(base,'output/a'),inode:'1'}};
    if(request.action==='move'){moves++;throw new Error('lost')}
    if(request.action==='settle')return {ok:true,receipt:{contentFingerprint:'f'}};
    throw Error(request.action);
  }});
  const params={consumerRoot:__CONSUMER__,node,targets:[{relativePath:'output/a',destination:'clean_dir/output/a',type:'file'}]},p=await api.preview(params),approved={token:p.token,digest:p.digest,index:0,consumerRoot:__CONSUMER__};
  await api.confirm({consumerRoot: __CONSUMER__, ...approved,phase:1,confirm:true,exactTargets:p.targets.map(row=>row.absolutePath)});
  assert.equal((await api.settle(approved)).state,'pending');assert.equal(moves,0);
  await assert.rejects(api.execute(approved),/lost/);assert.equal((await api.settle(approved)).state,'completed');assert.equal(moves,1);
  const deletion=await api.preview({consumerRoot: __CONSUMER__, ...params,action:'delete'});for(const phase of [1,2])await api.confirm({consumerRoot: __CONSUMER__, token:deletion.token,digest:deletion.digest,phase,confirm:true,exactTargets:deletion.targets.map(row=>row.absolutePath)});
  await assert.rejects(api.settle({consumerRoot: __CONSUMER__, token:deletion.token,digest:deletion.digest,index:0}),/DELETE_RECEIPT_UNCERTAIN/);
});
test('directory deletion freezes child types and names; audit permission failure stops before moving (all deletions mocked)',()=>{
  const base=root();write(base,'output/dir/sub/a.csv');
  const script=path.join(base,'directory_guard.py');
  fs.writeFileSync(script,`import importlib.util,json,os,sys\nfrom unittest.mock import patch\nspec=importlib.util.spec_from_file_location('cleanup',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nroot=sys.argv[2];full=os.path.join(root,'output','dir');inventory=m.contents(root,full,'directory')['inventory'];seen=[]\nwith patch.object(m.os,'unlink',side_effect=lambda value:seen.append(['file',value,os.getcwd()])),patch.object(m.os,'rmdir',side_effect=lambda value:seen.append(['directory',value,os.getcwd()])):m.delete_directory(root,full,inventory)\nresult={'calls':seen,'preserved':os.path.exists(os.path.join(full,'sub','a.csv'))}\nchanged=[dict(row) for row in inventory]\nfor row in changed:\n if row['type']=='file':row['type']='directory'\ntry:m.delete_directory(root,full,changed)\nexcept m.GuardError as e:result['type']=e.code\nwith open(os.path.join(full,'unexpected.csv'),'w',encoding='utf-8') as stream:stream.write('new')\ntry:m.delete_directory(root,full,inventory)\nexcept m.GuardError as e:result['inventory']=e.code\npreview=m.main({'root':root,'action':'inspect','target':{'relativePath':'output/dir','destination':'clean_dir/output/dir','type':'directory'}})\nwith patch.object(m,'audit',side_effect=PermissionError('denied')):\n try:m.main({'root':root,'action':'move','operationId':'fixture','rootIdentity':preview['rootIdentity'],'target':dict(preview['target'],relativePath='output/dir',destination='clean_dir/output/dir',type='directory')})\n except PermissionError:result['audit']='blocked'\nresult['source']=os.path.exists(full);print(json.dumps(result))\n`,'utf8');
  const child=spawnSync('python',['-B','-X','utf8',script,engine,base],{encoding:'utf8',windowsHide:true,timeout:8000});assert.equal(child.status,0,child.stderr);const r=JSON.parse(child.stdout);
  assert.deepEqual(r.calls,[['file','./a.csv',path.join(base,'output/dir/sub')],['directory','./sub',path.join(base,'output/dir')],['directory','./dir',path.join(base,'output')]]);
  assert.equal(r.type,'TYPE_CHANGED');assert.equal(r.inventory,'DIRECTORY_INVENTORY_CHANGED');assert.equal(r.audit,'blocked');assert.equal(r.preserved,true);assert.equal(r.source,true);
});
