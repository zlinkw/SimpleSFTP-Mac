import json,os,pathlib,subprocess,sys,tempfile
root=pathlib.Path(tempfile.mkdtemp(prefix='file-progress-'))
old=root/'old.bin';old.write_bytes(b'old!')
proc=subprocess.Popen([sys.executable,'-B',sys.argv[1],str(root)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
 proc.stdin.write(json.dumps([{'path':'old.bin','size':4},{'path':'new.bin','size':8},{'path':'empty','size':0}]))
 proc.stdin.close()
 proc.stdin=None
 line=proc.stdout.readline();assert line,proc.stderr.read()
 first=json.loads(line);assert first['ready'] and first['writtenBytes']==0 and first['totalBytes']==12 and first['totalFiles']==3
 (root/'new.bin').write_bytes(b'abcd')
 partial=json.loads(proc.stdout.readline());assert partial['writtenBytes']==4 and partial['writtenFiles']==0,partial
 (root/'new.bin').write_bytes(b'abcdefgh');old.write_bytes(b'new!');(root/'empty').touch()
 final=json.loads(proc.stdout.readline());assert final['writtenBytes']==12 and final['writtenFiles']==3,final
 assert sorted(path.name for path in root.iterdir())==['empty','new.bin','old.bin']
 print(json.dumps({'ok':True,'partialBytes':4,'totalBytes':12,'totalFiles':3,'persistentProgressFiles':0}))
finally:
 proc.terminate();proc.communicate(timeout=2)
