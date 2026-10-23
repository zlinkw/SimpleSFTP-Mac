const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('managed isolation writes completion before releasing only its own window; replay never creates a new one',()=>{
 const fixture=path.resolve(__dirname,'planIsolate.tmux.fixture.py'),engine=path.resolve(__dirname,'../cleanup-files.py');
 const linux=p=>'/mnt/'+p[0].toLowerCase()+p.slice(2).replace(/\\/g,'/');
 const args=process.platform==='win32'?['--distribution',process.env.SIMPLE_TEST_WSL_DISTRO||'Ubuntu-Codex','--exec','python3',linux(fixture),linux(engine)]:[fixture,engine];
 const result=spawnSync(process.platform==='win32'?'wsl.exe':'python3',args,{encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(result.status,0,result.stderr||result.stdout);assert.deepEqual(JSON.parse(result.stdout),{ok:true,serverSelfClose:true});
});
