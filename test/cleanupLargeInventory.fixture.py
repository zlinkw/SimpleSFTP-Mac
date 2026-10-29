# v1.9 note: confirmed exact paths never pass through the managed window;
# they run on the entry-bound fast chain (covered by fastDeleteGuard and the
# confirmed* fixtures). The multi-MiB managed lifecycle proven here stays on
# the live non-confirmed managed route, with deletions still replaced by
# moves inside the fixture's own disposable scratch (noDeletion contract).
import json, os, pathlib, runpy, subprocess, sys, tempfile

engine_path = pathlib.Path(sys.argv[1]).resolve()
engine = runpy.run_path(str(engine_path))
env = engine['main'].__globals__
shared = sys.stdin.read()
if shared:
    shared = json.loads(shared)
    assert engine['frozen_target_digest'](shared['target']) == shared['digest'], 'JavaScript/Python frozen digest differs'
for oversized, code in [(b' '*(engine['MAX_CLEANUP_REQUEST_BYTES']+1),'REQUEST_TOO_LARGE'),
                        (json.dumps({'target':{'inventory':[{}]*50001}}).encode('utf-8'),'INVENTORY_LIMIT')]:
    try:
        engine['decode_request'](oversized)
        raise AssertionError('input limit bypassed')
    except engine['GuardError'] as error:
        assert error.code == code, error.code
root = pathlib.Path(tempfile.mkdtemp(prefix='large-cleanup-')).resolve()
job = root / 'output' / 'job'
job.mkdir(parents=True)
(job / 'keep.bin').write_bytes(b'fixture')
archive = root / 'clean_dir' / 'fixture-only'
archive.mkdir(parents=True)
root_text, identity = engine['root_guard'](str(root))
target = {'relativePath':'output/job', 'destination':'clean_dir/output/job', 'type':'directory'}
value = engine['inspect'](root_text, target)
inventory = value['inventory'] + [{'path':'trace/' + str(i).zfill(8) + '/checkpoint-name-with-metadata.bin', 'type':'file', 'size':1024,
    'mtime':'123456789123456789', 'ctime':'123456789123456789', 'device':'12', 'inode':str(i)} for i in range(8000)]
target = {**target, **value, 'destination':'clean_dir/output/job', 'inventory':inventory, 'fingerprint':engine['digest'](inventory)}
request = {'root':root_text, 'rootIdentity':identity, 'operationId':'large-fixture', 'cleanupAction':'delete', 'target':target}
encoded = json.dumps({**request, 'action':'managed-observe', 'localObservation':True, 'target':{**target,'relativePath':'output/missing'}})
assert len(encoded.encode('utf-8')) > 1048576
def run(raw):
    child = subprocess.run([sys.executable,'-B','-X','utf8',str(engine_path)], input=raw.encode('utf-8'), capture_output=True, timeout=4)
    assert child.returncode == 0, (child.stderr, child.stdout)
    return json.loads(child.stdout)
large_result = run(encoded)
assert large_result.get('state') == 'completed', large_result
small = {'root':root_text,'action':'inventory','target':{'relativePath':'output/missing','type':'file'},'allowMissing':True,'padding':'x'*1048576}
assert run(json.dumps(small))['error']['code'] == 'REQUEST_TOO_LARGE'

key = engine['managed_key'](request)
managed = root / 'clean_dir' / '.operations' / 'managed'
managed.mkdir(parents=True)
frozen_file = managed / (key + '.json')
frozen = {'root':root_text,'rootIdentity':identity,'operationId':request['operationId'],'action':'delete','managedInner':True,'target':target}
raw = json.dumps(frozen,ensure_ascii=False,sort_keys=True)
frozen_file.write_text(raw,encoding='utf-8')
compact_target = {name:target[name] for name in ('relativePath','destination','type','fingerprint','contentFingerprint','inode','fingerprintMode','authorizationMode') if name in target}
compact = {**request,'action':'managed-observe','target':compact_target,'frozenTargetDigest':engine['frozen_target_digest'](target)}
assert len(json.dumps(compact).encode('utf-8')) < 8192
env['managed_tmux'] = lambda args: '@1\t%1\t0\t\t' + key
proof = engine['main'](compact)
assert proof['state'] == 'executing' and proof['progress']['removedEntries'] == 8000, proof
try:
    engine['main']({**compact,'frozenTargetDigest':'0'*64})
    raise AssertionError('modified digest accepted')
except engine['GuardError'] as error:
    assert error.code == 'CLEANUP_INPUT_CHANGED', error.code
tampered = {**frozen,'target':{**target,'inventory':inventory[:-1]}}
frozen_file.write_text(json.dumps(tampered),encoding='utf-8')
try:
    engine['main'](compact)
    raise AssertionError('modified inventory accepted')
except engine['GuardError'] as error:
    assert error.code == 'CLEANUP_INPUT_CHANGED', error.code
frozen_file.write_text(raw,encoding='utf-8')
env['managed_tmux'] = lambda args: ''
missing = {**compact,'operationId':'not-started'}
before = sorted(str(p) for p in managed.iterdir())
assert engine['main'](missing)['state'] == 'unknown'
assert sorted(str(p) for p in managed.iterdir()) == before, 'read-only check wrote a frozen input'
env['managed_tmux'] = lambda args: '@2\t%2\t0\t\t' + engine['managed_key'](missing)
assert engine['main'](missing)['state'] == 'executing', 'missing input cannot release a live cleanup executor'
env['managed_tmux'] = lambda args: ''
os.rename(job, archive / 'preserved-job')
assert engine['main'](compact)['state'] == 'completed'
job.mkdir()
(job / 'recreated.txt').write_text('new fixture',encoding='utf-8')
assert engine['main'](compact)['state'] == 'changed'
assert (archive / 'preserved-job' / 'keep.bin').read_bytes() == b'fixture'

# Exercise managed-start and its actual child stdin, with unlink/rmdir replaced
# inside that child by moves of these exact isolated fixture paths.
second = root / 'output' / 'second'
second.mkdir()
(second / 'keep.txt').write_text('preserve child bytes',encoding='utf-8')
t = {'relativePath':'output/second','destination':'clean_dir/output/second','type':'directory'}
t = {**t, **engine['inspect'](root_text,t), 'destination':t['destination'], 'fixturePadding':'x'*1200000}
source = engine_path.read_text(encoding='utf-8')
patch = '''
fixture_removed = 0
def fixture_remove(name):
    global fixture_removed
    assert name.startswith('./') and '/' not in name[2:]
    full = os.path.realpath(name)
    boundary = os.path.join(request['root'],'output','second')
    assert full == boundary or below(boundary,full)
    fixture_removed += 1
    os.rename(name,os.path.join(request['root'],'clean_dir','fixture-only','child-' + str(fixture_removed)))
os.unlink = fixture_remove
os.rmdir = fixture_remove
'''
source = source.replace('if __name__ == "__main__":',patch + '\nif __name__ == "__main__":')
# The window program comes only from the pinned managed program area: the
# exact verified bytes are installed there first and the very same pinned
# file then performs managed-start and runs as the window's child process.
import hashlib
prepared = run(json.dumps({'root':root_text,'action':'runtime-prepare',
                           'runtimeSha256':hashlib.sha256(source.encode('utf-8')).hexdigest(),'runtimeSource':source}))
assert prepared.get('ok') and prepared.get('state') in ('installed','verified'), prepared
pinned = managed / ('runtime-' + prepared['runtimeSha256'] + '.py')
assert pinned.name == 'runtime-' + hashlib.sha256(source.encode('utf-8')).hexdigest() + '.py'
start = {'root':root_text,'rootIdentity':identity,'operationId':'large-child','action':'managed-start','cleanupAction':'delete',
         'target':t,'localObservation':True}
original_run = subprocess.run
original_unlink, original_rmdir = os.unlink, os.rmdir
from types import SimpleNamespace
subprocess.run = lambda *args, **kwargs: SimpleNamespace(returncode=0)
pinned_main = runpy.run_path(str(pinned))['main']
pinned_env = pinned_main.__globals__
pinned_env['managed_tmux'] = lambda args: '%fixture' if args[0] == 'new-window' else ''
try:
    assert pinned_main(start)['state'] == 'requested'
finally:
    subprocess.run = original_run
    os.unlink, os.rmdir = original_unlink, original_rmdir
key2 = engine['managed_key'](start)
raw_input = (managed / (key2 + '.json')).read_bytes()
assert len(raw_input) > 1048576
child = subprocess.run([sys.executable,'-B','-X','utf8',str(pinned)],input=raw_input,capture_output=True,timeout=4)
assert child.returncode == 0 and json.loads(child.stdout).get('ok'), (child.stderr,child.stdout)
assert not second.exists()
assert any(p.is_file() and p.read_text(encoding='utf-8') == 'preserve child bytes' for p in archive.glob('child-*'))
print(json.dumps({'ok':True,'largeInput':True,'compactProgress':True,'tamperRejected':True,'noDeletion':True}))
