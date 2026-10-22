const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

function validateAgentRequest(params) {
  if (!['inspect','ensure','stop','restart','migrate'].includes(params.action)) throw new Error('AGENT_ACTION_INVALID');
  for (const key of ['projectDir','installDir']) {
    const value = params[key];
    if (typeof value !== 'string' || !value.startsWith('/') || value === '/' || /[\r\n\0*?]/.test(value) || value.split('/').includes('..')) throw new Error('AGENT_PATH_INVALID: '+key);
  }
  if (params.mode !== 'worker_telemetry' || !params.workerId) throw new Error('AGENT_IDENTITY_REQUIRED');
  if (!Number.isInteger(params.port) || params.port < 1 || params.port > 65535) throw new Error('AGENT_BIND_INVALID');
  if (params.tmuxSession && !/^[a-z0-9][a-z0-9._-]{0,127}-agent$/.test(params.tmuxSession) || params.tmuxWindow && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(params.tmuxWindow)) throw new Error('AGENT_TMUX_TARGET_INVALID');
  if (params.action === 'migrate' && !/^[a-f0-9]{64}$/.test(params.migrationDigest||'')) throw new Error('AGENT_MIGRATION_CONFIRM_REQUIRED');
  if (['ensure','restart'].includes(params.action) && (!params.expectedVersion || !['cluster_agent.py','cluster_scheduler.py'].every(name=>/^[a-f0-9]{64}$/.test(params.files?.[name]||'')))) throw new Error('AGENT_RUNTIME_PROOF_REQUIRED');
}

function agentPayload(params) {
  validateAgentRequest(params);
  // Fixed allowlist: no caller-supplied program, command, cwd, signal or environment.
  return Object.fromEntries(['action','projectDir','installDir','mode','workerId','host','port','condaEnv','expectedVersion','files','sessionPrefix','tmuxSession','tmuxWindow','agentToken','migrationDigest'].map(key=>[key,params[key]]));
}

function agentRemoteCommand() {
  const code = fs.readFileSync(path.join(__dirname,'agent-lifecycle.py'));
  const packed = zlib.deflateSync(code).toString('base64');
  return "python3 -c 'import base64,zlib;exec(compile(zlib.decompress(base64.b64decode(\""+packed+"\")),\"simple_sftp_agent_lifecycle\",\"exec\"))'";
}

function runAgentRemote(args, payload, nativeSpawn = spawn) {
  return new Promise((resolve,reject)=>{
    const child = nativeSpawn('ssh',args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const output=[]; const errors=[]; let size=0; let settled=false;
    const fail = error=>{if(settled)return;settled=true;reject(error);};
    const timer=setTimeout(()=>{child.kill();fail(new Error('AGENT_RECEIPT_UNCONFIRMED: do not retry or signal the remote process'));},45000);
    child.on('error',error=>{clearTimeout(timer);fail(error);});
    child.stdout.on('data',data=>{size+=data.length;if(size>65536){child.kill();fail(new Error('AGENT_OUTPUT_LIMIT'));}else output.push(data);});
    child.stderr.on('data',data=>{if(errors.reduce((sum,b)=>sum+b.length,0)<16384)errors.push(data);});
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify(payload));
    child.on('close',code=>{clearTimeout(timer);if(settled)return;settled=true;
      try {const result=JSON.parse(Buffer.concat(output).toString('utf8')); if(code!==0 || result.ok!==true)resolve({...result,ok:false});else resolve(result);}
      catch {reject(new Error('AGENT_TRANSPORT_FAILED: '+Buffer.concat(errors).toString('utf8').slice(-1500)));}
    });
  });
}
module.exports={validateAgentRequest,agentPayload,agentRemoteCommand,runAgentRemote};
