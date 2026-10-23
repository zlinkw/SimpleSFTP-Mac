const test=require('node:test');
const assert=require('node:assert/strict');
const {agentPayload,agentRemoteCommand}=require('../agent-lifecycle');
test('restricted lifecycle transport allows no caller commands/env and preserves custom ports',()=>{
 const p=agentPayload({action:'inspect',projectDir:'/srv/project',installDir:'/srv/agent',mode:'worker_telemetry',workerId:'worker',host:'127.0.0.2',port:23065,command:'kill all',env:{SECRET:'do not send'}});
 assert.equal(p.port,23065);assert.ok(!('command'in p));assert.ok(!('env'in p));
 assert.throws(()=>agentPayload({...p,action:'kill'}),/AGENT_ACTION_INVALID/);
 assert.throws(()=>agentPayload({...p,installDir:'/srv/../agent'}),/AGENT_PATH_INVALID/);
 assert.throws(()=>agentPayload({...p,action:'restart'}),/AGENT_RUNTIME_PROOF_REQUIRED/);
 assert.throws(()=>agentPayload({...p,action:'migrate'}),/AGENT_MIGRATION_CONFIRM_REQUIRED/);
 const migration=agentPayload({...p,action:'migrate',migrationDigest:'a'.repeat(64),signal:'SIGKILL'});
 assert.equal(migration.migrationDigest,'a'.repeat(64));assert.ok(!('signal'in migration));
 // Resolution contract: fixed python3→python candidates from inherited PATH and
 // from the login shell, each gated by a stdlib Python 3 probe, login PATH
 // travelling with the login interpreter, builtins-only fallback, two structured
 // terminal failures — never a hardcoded leading `python3 -c`, never a baked
 // interpreter path.
 const remote=agentRemoteCommand();
 assert.ok(!/^python3 -c /.test(remote));
 assert.ok(remote.includes('command -v python3')&&remote.includes('command -v python)'));
 assert.match(remote,/sys\.version_info\[0\]>=3/);
 assert.match(remote,/@@agentpy:.*@@agentpy2:.*@@agentpath:/s);
 assert.match(remote,/\$\{__L:\+:\}\$PATH/);
 assert.ok(!remote.includes('awk'),'login fallback must be builtins only');
 assert.match(remote,/__run\(\)\{ exec "\$1" -c '/);
 assert.match(remote,/__run "\$__a";/);
 assert.equal(remote.split('base64.b64decode').length-1,1,'compressed payload must appear exactly once (CreateProcess 32767 limit)');
 // Login candidates must be version-probed inside the login PATH context, and
 // the shell loop must not stop at a merely-present (incompatible) candidate.
 assert.match(remote,/\( PATH="\$__L\$\{__L:\+:\}\$PATH"; export PATH; __ok "\$__P" \)/);
 assert.ok(!remote.includes('break'),'an incompatible login candidate must not block later shells');
 assert.match(remote,/AGENT_PYTHON_VERSION_UNSUPPORTED/);
 assert.match(remote,/AGENT_PYTHON_NOT_RESOLVED/);
 const window=agentPayload({...p,tmuxSession:'configured-worker-agent',tmuxWindow:'agent'});
 assert.equal(window.tmuxSession,'configured-worker-agent');assert.equal(window.tmuxWindow,'agent');
 assert.throws(()=>agentPayload({...p,tmuxSession:'user-gpu-0'}),/AGENT_TMUX_TARGET_INVALID/);
 assert.throws(()=>agentPayload({...p,tmuxWindow:'*'}),/AGENT_TMUX_TARGET_INVALID/);
 const roots=agentPayload({...p,stateDir:'/srv/project/control',workerStateDir:'/srv/machine'});
 assert.equal(roots.stateDir,'/srv/project/control');assert.equal(roots.workerStateDir,'/srv/machine');
 assert.throws(()=>agentPayload({...p,stateDir:'relative'}),/AGENT_PATH_INVALID/);
 assert.throws(()=>agentPayload({...p,workerStateDir:'/srv/../machine'}),/AGENT_PATH_INVALID/);
});
