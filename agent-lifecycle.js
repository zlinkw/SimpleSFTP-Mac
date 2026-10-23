const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

function validateAgentRequest(params) {
  if (!['inspect','ensure','stop','restart','migrate'].includes(params.action)) throw new Error('AGENT_ACTION_INVALID');
  for (const key of ['projectDir','installDir', ...['stateDir','workerStateDir'].filter(key => params[key] !== undefined && params[key] !== '')]) {
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
  return Object.fromEntries(['action','projectDir','installDir','stateDir','workerStateDir','mode','workerId','host','port','condaEnv','expectedVersion','files','sessionPrefix','tmuxSession','tmuxWindow','agentToken','migrationDigest'].map(key=>[key,params[key]]));
}

function agentRemoteCommand() {
  const code = fs.readFileSync(path.join(__dirname,'agent-lifecycle.py'));
  const packed = zlib.deflateSync(code).toString('base64');
  // A non-interactive ssh shell may not have an initialized PATH, so resolve the
  // machine's own interpreter from the machine's own configuration: inherited
  // PATH first (identical behavior where python3 already resolves — no profile
  // runs), then the fixed candidate names through the login shell the machine
  // itself would use. Candidates are python3 then python from each stage, in
  // priority order, and each must pass a stdlib-only Python 3 probe before it is
  // exec'd — `python` is often Python 2 — so an incompatible candidate is skipped
  // and the search continues instead of failing later as transport noise. When
  // the interpreter comes from the login shell, the login PATH travels with it
  // (exported only into the exec'd agent process — the machine keeps its own
  // environment; the agent's later bare `tmux` lookups then resolve from the same
  // machine configuration). A machine login configuration may auto-activate an
  // environment (for example conda); that is the machine's own choice and nothing
  // here modifies or research-activates anything — the agent contract is Python 3
  // stdlib only. The fallback is shell builtins ONLY (an uninitialized PATH may
  // lack awk/tail too); login output arrives as marker-delimited printf fields
  // parsed with parameter expansion, stdin /dev/null so a profile cannot consume
  // the JSON payload, stderr suppressed so profile noise never reaches the result
  // stream. Machine configuration is trusted; no claim is made that markers
  // cannot be echoed by it. No absolute interpreter path is baked in, no caller
  // value is interpolated, and the two terminal outcomes are structured JSON:
  // AGENT_PYTHON_VERSION_UNSUPPORTED (a candidate existed but none was Python 3)
  // and AGENT_PYTHON_NOT_RESOLVED (no candidate at all).
  const bootstrap = 'import base64,zlib;exec(compile(zlib.decompress(base64.b64decode("'+packed+'")),"simple_sftp_agent_lifecycle","exec"))';
  const probe = "\'import sys; sys.exit(0 if sys.version_info[0]>=3 else 1)\'";
  const loginProbe = "q=$(command -v python3); r=$(command -v python); case \"$q\" in /*) printf \"@@agentpy:%s\" \"$q\";; esac; case \"$r\" in /*) printf \"@@agentpy2:%s\" \"$r\";; esac; printf \"@@agentpath:%s\" \"$PATH\"";
  // A login candidate (for example a pyenv-style shim with an `env` shebang) is
  // only runnable IN the login PATH context, so its version probe runs inside a
  // subshell that already has the captured login PATH; probing it on the raw
  // ssh PATH would misjudge a perfectly valid interpreter as unsupported. The
  // shell loop likewise never stops at a merely-present candidate: an
  // incompatible python3 from .bash_profile must not block a valid python3 that
  // .profile would expose — the search moves on and only a compatible candidate
  // leads to an exec. Existence of any candidate is kept as evidence so the
  // final answer distinguishes UNSUPPORTED from NOT_RESOLVED.
  const loginCtx = "PATH=\"$__L${__L:+:}$PATH\"; export PATH; ";
  // The full compressed payload appears EXACTLY ONCE in the command: every
  // branch calls the same __run function. Four inlined copies (one per exec
  // branch) pushed the ssh command line past the Windows CreateProcess limit.
  const run = "__run(){ exec \"$1\" -c '"+bootstrap+"'; }; ";
  const resolve = run
    + "__ok(){ [ -n \"$1\" ] && \"$1\" -c "+probe+" >/dev/null 2>&1 </dev/null; }; "
    + "__a=$(command -v python3); __b=$(command -v python); "
    + "if __ok \"$__a\"; then __run \"$__a\"; fi; if __ok \"$__b\"; then __run \"$__b\"; fi; "
    + "__HAD=\"\"; for __s in /bin/bash /bin/sh; do [ -x \"$__s\" ] || continue; "
    + "__r=$(\"$__s\" -lc '"+loginProbe+"' 2>/dev/null </dev/null); "
    + "case \"$__r\" in *@@agentpy:*) __t=${__r#*@@agentpy:}; __P=${__t%%@@*};; *) __P=\"\";; esac; "
    + "case \"$__r\" in *@@agentpy2:*) __t=${__r#*@@agentpy2:}; __P2=${__t%%@@*};; *) __P2=\"\";; esac; "
    + "case \"$__r\" in *@@agentpath:*) __L=${__r#*@@agentpath:};; esac; "
    + "if [ -n \"$__P\" ] || [ -n \"$__P2\" ]; then __HAD=1; fi; "
    + "if [ -n \"$__P\" ] && ( "+loginCtx+"__ok \"$__P\" ); then "+loginCtx+"__run \"$__P\"; fi; "
    + "if [ -n \"$__P2\" ] && ( "+loginCtx+"__ok \"$__P2\" ); then "+loginCtx+"__run \"$__P2\"; fi; "
    + "done; "
    + "if [ -n \"$__HAD\" ] || [ -n \"$__a\" ] || [ -n \"$__b\" ]; then printf '{\"ok\":false,\"code\":\"AGENT_PYTHON_VERSION_UNSUPPORTED\",\"error\":\"AGENT_PYTHON_VERSION_UNSUPPORTED: a candidate python was found but none passed the Python 3 probe\"}'; exit 1; fi; "
    + "printf '{\"ok\":false,\"code\":\"AGENT_PYTHON_NOT_RESOLVED\",\"error\":\"AGENT_PYTHON_NOT_RESOLVED: neither python3 nor python is reachable from the ssh PATH or the machine login shell\"}'; exit 1";
  return resolve;
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
