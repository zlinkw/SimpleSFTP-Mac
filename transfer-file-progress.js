"use strict";

function remoteFileProgressScript() {
  return String.raw`import json,os,stat,sys,time
root=os.path.abspath(sys.argv[1])
if not os.path.isabs(sys.argv[1]) or os.path.normcase(os.path.realpath(root))!=os.path.normcase(root) or not os.path.isdir(root): raise ValueError('PROGRESS_ROOT_UNAVAILABLE')
items=json.loads(sys.stdin.read(4*1024*1024))
if not isinstance(items,list) or len(items)>50000: raise ValueError('PROGRESS_SCOPE_LIMIT')
for row in items:
 parts=row['path'].split('/')
 if not parts or any(p in ('','.','..') for p in parts) or row['path'].startswith('/') or chr(92) in row['path'] or not isinstance(row['size'],int) or row['size']<0: raise ValueError('UNSAFE_PROGRESS_PATH')
def identity(row):
 cursor=root
 try:
  for part in row['path'].split('/'):
   cursor=os.path.join(cursor,part); value=os.lstat(cursor)
   if stat.S_ISLNK(value.st_mode): raise ValueError('PROGRESS_LINK_REJECTED')
  if not stat.S_ISREG(value.st_mode): return None
  return (value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_ctime_ns)
 except FileNotFoundError: return None
baseline=[identity(row) for row in items]
def sample():
 written=complete=0
 for row,before in zip(items,baseline):
  current=identity(row)
  if current is not None and current!=before:
   written+=min(row['size'],current[2]);complete+=int(current[2]==row['size'])
 return {'writtenBytes':written,'writtenFiles':complete,'totalBytes':sum(row['size'] for row in items),'totalFiles':len(items)}
print(json.dumps({'ready':True,**sample()}),flush=True)
while True:
 time.sleep(1)
 print(json.dumps(sample()),flush=True)
`;
}

/** One read-only SSH channel; baseline, file sizes and counts exist only in memory. */
function startRemoteFileProgress({ source, files, launch, sshArgs, quote, onProgress, onError }) {
  const command = `python3 -B -c ${quote(remoteFileProgressScript())} ${quote(source.remotePath)}`;
  const child = launch("ssh", sshArgs(source, command), { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let closed = false, buffer = "", readyDone = false, resolveReady, startup;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const finishReady = () => { clearTimeout(startup); if (!readyDone) { readyDone = true; resolveReady(); } };
  startup = setTimeout(() => { onError?.("远端文件进度查询尚未返回，继续传输并等待最终核验"); try { child.kill(); } catch {} finishReady(); }, 30000);
  startup.unref?.();
  child.stdout.on("data", chunk => {
    buffer += chunk.toString("utf8");
    if (buffer.length > 65536) { onError?.("远端文件进度响应过大"); child.kill(); return; }
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0,end); buffer = buffer.slice(end+1);
      try {
        const value = JSON.parse(line);
        if (!["writtenBytes","writtenFiles","totalBytes","totalFiles"].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
          || value.writtenBytes > value.totalBytes || value.writtenFiles > value.totalFiles) throw Error("进度数值无效");
        if (value.ready === true) finishReady();
        onProgress(value);
      } catch (error) { onError?.(error.message); }
    }
  });
  child.stderr.on("data", () => {});
  child.on("error", error => { onError?.(error.message); finishReady(); });
  child.on("close", code => { if (!closed && code) onError?.("远端文件进度查询连接已结束"); finishReady(); });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(files.map(file => ({ path:file.relativePath, size:file.size }))));
  return { child, ready, stop() { closed = true; clearTimeout(startup); try { child.kill(); } catch {} finishReady(); } };
}

module.exports = { remoteFileProgressScript, startRemoteFileProgress };
