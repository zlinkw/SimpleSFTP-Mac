"""C1/C2/C4 paired contract fixture: controlled fast isolation, exact subtree
single-writer locks and registered isolated-subtree permanent deletion.
Runs entirely inside fresh disposable temp roots; no tmux required."""
import builtins, json, os, pathlib, subprocess, sys, tempfile

# exec into a shared namespace: runpy.run_path returns a *copy*, so function
# patches must target the real globals the engine functions close over.
engine_src = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
module = {"__name__": "cleanup_files_fixture", "__file__": str(pathlib.Path(sys.argv[1]).resolve())}
exec(compile(engine_src, sys.argv[1], "exec"), module)
# isolate renames run through parent_cd, which changes the process cwd;
# any later subprocess must reference the engine by its absolute path.
engine_path = str(pathlib.Path(sys.argv[1]).resolve())
root = pathlib.Path(tempfile.mkdtemp(prefix='plan-isolate-'))
outputs = root / 'work_dirs'
weight_dir = outputs / 'run1'
weight_dir.mkdir(parents=True)
weight = weight_dir / 'weight.bin'
with weight.open('wb') as stream:
    stream.truncate(64 * 1024 * 1024)  # sparse fixture; contents must never be read
(weight_dir / 'artifact_manifest.json').write_text(json.dumps({"schemaVersion": 1, "case": "c", "seed": 1}), encoding='utf-8')
_, identity = module['root_guard'](str(root))
BATCH = 'job-' + 'a' * 48

data_reads = []
original_open = builtins.open
def guarded_open(file, mode='r', *args, **kwargs):
    text = str(file)
    if 'b' in mode and 'w' not in mode and '+' not in mode and 'x' not in mode \
            and text.startswith(str(outputs) + os.sep) and 'manifest' not in os.path.basename(text):
        data_reads.append(text)
    return original_open(file, mode, *args, **kwargs)
builtins.open = guarded_open

def isolate_target(name, batch=BATCH, **target_extra):
    return {'relativePath': 'work_dirs/' + name, 'destination': 'clean_dir/' + batch + '/work_dirs/' + name,
            'type': 'directory', 'archiveBatch': batch, **target_extra}

def isolate_request(name, **extra):
    target = isolate_target(name, **extra)
    value = module['isolate_inspect'](str(root), target)
    return {**target, **value, 'destination': target['destination']}

def run(request):
    request.setdefault('root', str(root)); request.setdefault('rootIdentity', identity)
    return module['main'](request)

def expect_code(request, code):
    try:
        run(request)
    except module['GuardError'] as error:
        assert error.code == code, (code, error.code, error.reason)
        return error
    raise AssertionError('expected ' + code)

def isolation_state(rel):
    return module['isolation_state'](str(root), rel)

# 1) fast inspect proves top-level identity with zero data-content reads.
frozen = isolate_request('run1')
assert frozen['fingerprintMode'] == 'top_level' and 'contentFingerprint' not in frozen, frozen
assert not data_reads, data_reads
assert any(row.get('path') == 'artifact_manifest.json' for row in frozen['inventory'])
# the engine itself answers the per-backend background-delete capability on
# every isolate inspect; the plugin only advertises safety when it sees this.
probe = run({'action': 'inspect', 'isolate': True, 'operationId': 'op-iso-probe', 'target': frozen})
assert probe['ok'] is True and probe.get('backgroundIsolatedDelete') == 1, probe
assert probe['target']['fingerprint'] == frozen['fingerprint'], probe

# 2) isolate renames into the intent batch with no content reads; the pending
# isolation mapping registers and MANIFEST facts stay inventory-free.
done = run({'action': 'isolate', 'operationId': 'op-iso-run1', 'target': frozen})
assert done['ok'] and done['receipt']['phase'] == 'completed'
# 0.2.111 completion receipt: move-moment facts only, bound to this operation.
receipt = done['receipt']
assert receipt['isolationCompletionProtocol'] == 1 and receipt['renameCommitted'] is True \
    and receipt['sourceMissingAtMove'] is True and receipt['registered'] is True \
    and receipt['executorsChecked'] is True and receipt['executors'] == [], receipt
assert receipt['archiveBatch'] == BATCH and receipt['sourceRelativePath'] == 'work_dirs/run1' \
    and receipt['destinationRelativePath'] == 'clean_dir/' + BATCH + '/work_dirs/run1', receipt
moved = root / 'clean_dir' / BATCH / 'work_dirs' / 'run1'
assert moved.is_dir() and (moved / 'weight.bin').exists() and not weight_dir.exists()
assert not data_reads, data_reads
state = isolation_state('clean_dir/' + BATCH + '/work_dirs/run1')
assert state and state['state'] == 'isolated' and state['destination'].endswith('work_dirs/run1'), state
# the registration persists the same move-moment facts next to the stable identity
assert state.get('isolationCompletionProtocol') == 1 and state.get('renameCommitted') is True \
    and state.get('sourceMissingAtMove') is True and state.get('registered') is True \
    and state.get('executorsChecked') is True and state.get('executors') == [], state
assert state.get('archiveBatch') == BATCH and state.get('sourceRelativePath') == 'work_dirs/run1' \
    and state.get('destinationRelativePath') == 'clean_dir/' + BATCH + '/work_dirs/run1', state
assert state.get('device') is not None and state.get('inode') is not None, state
manifest_lines = (root / 'clean_dir' / 'MANIFEST.md').read_text(encoding='utf-8').splitlines()
assert any('"phase":"intent"' in line for line in manifest_lines) and any('"phase":"completed"' in line for line in manifest_lines)
assert not any('"inventory"' in line for line in manifest_lines), 'isolate audit must stay a compact fact'

# 3) a new run recreates the canonical path; the frozen binding keeps the
# isolation completed — check/settle acknowledge it, and the new data is never
# re-moved, re-deleted or mistaken for the old source.
weight_dir.mkdir(parents=True)
(weight_dir / 'new-run.txt').write_text('new run data', encoding='utf-8')
frozen_keys = ('relativePath', 'destination', 'type', 'fingerprint', 'inode', 'device', 'fingerprintMode')
settle_target = {key: frozen[key] for key in frozen_keys}
settled3 = run({'action': 'settle', 'settledAction': 'isolate', 'operationId': 'op-iso-run1', 'target': settle_target})
assert settled3['ok'] and settled3['receipt']['fingerprintMode'] == 'top_level', settled3
checked3 = run({'action': 'check', 'operationId': 'op-iso-run1', 'target': settle_target})
assert checked3['state'] == 'completed' and checked3.get('verifiedBy') == 'destination_identity', checked3
assert (weight_dir / 'new-run.txt').read_text(encoding='utf-8') == 'new run data'
assert (moved / 'weight.bin').exists() and not data_reads

# 3b) crash window plus recreation: rename committed, the registration never
# landed, then the new run recreates the source path. The frozen destination
# identity still proves completion; settle repairs the record and never
# touches the recreated directory.
(outputs / 'run8').mkdir()
(outputs / 'run8' / 'old.bin').write_text('old', encoding='utf-8')
frozen8 = isolate_request('run8')
run({'action': 'isolate', 'operationId': 'op-iso-run8', 'target': frozen8})
crashed8 = 'clean_dir/' + BATCH + '/work_dirs/run8'
os.unlink(module['parent_cd'](str(root), str(root / module['isolation_control_rel'](crashed8))))
recreated8 = outputs / 'run8'
recreated8.mkdir()
(recreated8 / 'fresh.txt').write_text('fresh', encoding='utf-8')
crashed8 = 'clean_dir/' + BATCH + '/work_dirs/run8'
assert isolation_state(crashed8) is None
settled8 = run({'action': 'settle', 'settledAction': 'isolate', 'operationId': 'op-iso-run8',
                'target': {key: frozen8[key] for key in frozen_keys}})
assert settled8['ok'] and settled8['receipt']['fingerprintMode'] == 'top_level', settled8
assert isolation_state(crashed8)['state'] == 'isolated'
# Honesty: a settle-repaired registration records the repaired fact ONLY. It
# never fabricates the move-moment completion fields it did not witness.
repaired8 = isolation_state(crashed8)
assert 'isolationCompletionProtocol' not in repaired8 and 'renameCommitted' not in repaired8 \
    and 'sourceMissingAtMove' not in repaired8 and 'registered' not in repaired8, repaired8
assert (recreated8 / 'fresh.txt').read_text(encoding='utf-8') == 'fresh'

# 3c) insufficient evidence: nothing was ever renamed and the canonical is
# still present — settle stays unknown and moves nothing.
(outputs / 'run9').mkdir()
frozen9 = isolate_request('run9')
expect_code({'action': 'settle', 'settledAction': 'isolate', 'operationId': 'op-iso-run9',
             'target': {key: frozen9[key] for key in frozen_keys}}, 'SOURCE_RECREATED_OR_NOT_MOVED')
assert (outputs / 'run9').is_dir() and not (root / 'clean_dir' / BATCH / 'work_dirs' / 'run9').exists()

# 4) crash window: rename committed but the completion record never did.
# Recreate exactly that filesystem state by dropping the registration file.
(outputs / 'run2').mkdir()
(outputs / 'run2' / 'epoch.ckpt').write_text('ckpt', encoding='utf-8')
frozen2 = isolate_request('run2')
run({'action': 'isolate', 'operationId': 'op-iso-run2', 'target': frozen2})
crashed_rel = 'clean_dir/' + BATCH + '/work_dirs/run2'
os.unlink(module['parent_cd'](str(root), str(root / module['isolation_control_rel'](crashed_rel))))
assert isolation_state(crashed_rel) is None and (root / crashed_rel).is_dir()
settled = run({'action': 'settle', 'settledAction': 'isolate', 'operationId': 'op-iso-run2',
               'target': {key: frozen2[key] for key in ('relativePath', 'destination', 'type', 'fingerprint', 'inode', 'device', 'fingerprintMode')}})
assert settled['ok'] and settled['receipt']['fingerprintMode'] == 'top_level'
assert isolation_state(crashed_rel)['state'] == 'isolated'

# 5) required-input overlap blocks the affected isolate before any mutation;
# an input outside the source never blocks; missing inputs never block.
(outputs / 'run3').mkdir()
(outputs / 'run3' / 'epoch.ckpt').write_text('needed by new job', encoding='utf-8')
overlap = {'action': 'isolate', 'operationId': 'op-iso-run3', 'target': isolate_target('run3', requiredInputs=['work_dirs/run3/epoch.ckpt'])}
expect_code(overlap, 'ISOLATE_REQUIRED_INPUT_OVERLAP')
assert (outputs / 'run3' / 'epoch.ckpt').exists() and not (root / 'clean_dir' / BATCH / 'work_dirs' / 'run3').exists()
missing_input = isolate_request('run3', requiredInputs=['work_dirs/gone/epoch.ckpt'])
run({'action': 'isolate', 'operationId': 'op-iso-run3', 'target': missing_input})
assert not (outputs / 'run3').exists() and (root / 'clean_dir' / BATCH / 'work_dirs' / 'run3' / 'epoch.ckpt').exists()

# 6) shape and destination guards.
(outputs / 'run4').mkdir()
expect_code({'action': 'isolate', 'operationId': 'op-x', 'target': {'relativePath': 'work_dirs/run4', 'type': 'directory',
          'destination': 'clean_dir/work_dirs/run4'}}, 'UNSAFE_ARCHIVE_BATCH')
expect_code({'action': 'isolate', 'operationId': 'op-x', 'target': {'relativePath': 'work_dirs/run4', 'type': 'directory',
          'destination': 'clean_dir/work_dirs/run4', 'archiveBatch': BATCH}}, 'UNSAFE_DESTINATION')
(outputs / 'run5').mkdir()
(root / 'clean_dir' / BATCH / 'work_dirs' / 'run5').mkdir(parents=True)
expect_code({'action': 'isolate', 'operationId': 'op-x', 'target': isolate_target('run5')}, 'DESTINATION_EXISTS')

# 7) C2 subtree locks: leaf exclusive, ancestors shared. Disjoint siblings run
# in parallel; parent/child and same-path overlap block with OPERATION_BUSY
# without ever holding the root mutation lock. The engine entry itself refuses
# an overlapping target while an external writer holds the subtree chain.
held = module['acquire_target_locks'](str(root), ['work_dirs/run6/deep'])
try:
    (outputs / 'run7').mkdir()
    sibling = isolate_request('run7')
    parallel = module['acquire_target_locks'](str(root), ['work_dirs/run7'])  # disjoint sibling chain is compatible
    for stream in parallel:
        stream.close()
    run({'action': 'isolate', 'operationId': 'op-iso-run7', 'target': sibling})
    assert not (outputs / 'run7').exists()
    (outputs / 'run6').mkdir(exist_ok=True)
    for overlap in (['work_dirs/run6'], ['work_dirs/run6/deep'], ['work_dirs/run6/deep/leaf']):
        try:
            module['acquire_target_locks'](str(root), overlap)
        except module['GuardError'] as error:
            assert error.code == 'OPERATION_BUSY', (overlap, error.code)
        else:
            raise AssertionError('expected OPERATION_BUSY for ' + overlap[-1])
    busy = subprocess.run([sys.executable, '-B', engine_path],
                          input=json.dumps({'root': str(root), 'action': 'isolate', 'operationId': 'op-x', 'target': isolate_target('run6')}),
                          capture_output=True, text=True, timeout=8)
    assert busy.returncode == 0 and json.loads(busy.stdout)['error']['code'] == 'OPERATION_BUSY', (busy.returncode, busy.stdout, busy.stderr)
    assert (outputs / 'run6').is_dir()
finally:
    for stream in held:
        stream.close()
# The mutations never parked the root mutation lock: a fresh root mutation
# lock stays immediately acquirable (C2 short control transaction).
control = module['mutation_lock'](str(root)); control.close()

# 8) registered deletion uses the sole entry-bound batch executor. Legacy
# confirmed delete routes remain explicitly rejected, never silently revived.
archived_rel = 'clean_dir/' + BATCH + '/work_dirs/run2'
delete_target = {'relativePath': archived_rel, 'type': 'directory'}
frozen_delete = run({'action':'batch-inspect', 'authorizationMode':'confirmed_paths',
                     'operationId':'op-del-run2', 'targets':[delete_target]})['targets'][0]
expect_code({'action':'delete', 'operationId':'op-old-delete',
             'target':{**delete_target, 'destination':archived_rel, 'authorizationMode':'confirmed_paths'}}, 'UPDATE_REQUIRED')
# batch-inspect answers with the registration state and echoes the persisted
# move-moment completion receipt verbatim (run1: full isolate path)...
run1_probe = run({'action':'batch-inspect','authorizationMode':'confirmed_paths',
                  'targets':[{'relativePath':'clean_dir/'+BATCH+'/work_dirs/run1','type':'directory'}]})['targets'][0]
assert run1_probe.get('isolationState') == 'isolated', run1_probe
echo = run1_probe.get('isolationCompletion') or {}
assert echo.get('isolationCompletionProtocol') == 1 and echo.get('renameCommitted') is True \
    and echo.get('sourceRelativePath') == 'work_dirs/run1' \
    and echo.get('destinationRelativePath') == 'clean_dir/' + BATCH + '/work_dirs/run1', run1_probe
# ... while the settle-repaired run2 registration stays registered-deletable
# for the manual chain but echoes NO move-moment receipt: the background
# entry must refuse it (NOT_ISOLATION_COMPLETION_RECEIPT) instead of trusting
# a repaired record as if it witnessed the rename.
assert frozen_delete.get('isolationState') == 'isolated', frozen_delete
assert 'isolationCompletion' not in frozen_delete, frozen_delete
# Allocate the replacement before removing the original, so inode reuse cannot
# accidentally turn this replay test into an equal-inode fixture.
replacement = root / 'fresh-replacement'
replacement.mkdir(); (replacement / 'fresh.bin').write_text('keep', encoding='utf-8')
permanent = run({'action':'delete-fast', 'authorizationMode':'confirmed_paths',
                 'operationId':'op-del-run2', 'entries':[frozen_delete]})
assert permanent['ok'] and permanent['receipt']['phase'] == 'completed' and not (root / archived_rel).exists()
state = isolation_state(archived_rel)
assert state['state'] == 'deleted' and set(state) == {'schemaVersion','state','operationId','destination','deletedAt'}, state
# Lost mutation responses settle through a read-only presence query; no blind
# resend of the retired deletion or the new mutation is allowed.
verified = run({'action':'batch-verify', 'authorizationMode':'confirmed_paths',
                'entries':[frozen_delete]})
assert verified['targets'][0]['status'] == 'gone', verified
expect_code({'action':'delete-fast', 'authorizationMode':'confirmed_paths',
             'operationId':'op-del-run2', 'entries':[frozen_delete]}, 'MISSING_TARGET')
# a missing archived entry is still distinguishable from an unexplained
# absence: the registration answers "deleted", with no completion echo left.
gone_probe = run({'action':'batch-inspect','authorizationMode':'confirmed_paths','targets':[delete_target]})['targets'][0]
assert gone_probe['missing'] is True and gone_probe.get('archived') is True and gone_probe.get('isolationState') == 'deleted', gone_probe
assert 'isolationCompletion' not in gone_probe, gone_probe
# the deleted subtree's own confirmed-path check still reports completion through the registration.
check_after = run({'action': 'check', 'target': {'relativePath': archived_rel, 'destination': archived_rel,
                'type': 'directory', 'authorizationMode': 'confirmed_paths'}})
assert check_after['state'] == 'completed' and check_after.get('verifiedBy') == 'isolation_deleted'
isolate_check = run({'action':'check', 'operationId':'op-iso-run2',
    'target':{key:frozen2[key] for key in ('relativePath','destination','type','fingerprint','inode','device','fingerprintMode')}})
assert isolate_check['state'] == 'completed' and isolate_check.get('verifiedBy') == 'isolation_deleted', isolate_check
replacement.rename(root / archived_rel)
expect_code({'action':'delete-fast', 'authorizationMode':'confirmed_paths',
             'operationId':'op-del-replay2', 'entries':[frozen_delete]}, 'ENTRY_IDENTITY_CHANGED')
assert (root / archived_rel / 'fresh.bin').read_text(encoding='utf-8') == 'keep'
(outputs / 'run2').mkdir()
expect_code({'action':'isolate', 'operationId':'op-x', 'target':isolate_target('run2')}, 'DESTINATION_EXISTS')
fresh_batch = 'job-' + 'c' * 48
frozen2b = isolate_request('run2', batch=fresh_batch)
run({'action':'isolate', 'operationId':'op-iso-run2b', 'target':frozen2b})
assert isolation_state('clean_dir/' + fresh_batch + '/work_dirs/run2')['state'] == 'isolated'
# a fresh full-path isolate in a NEW batch binds its completion to that batch:
# the deleted old batch copy never answers for it.
fresh_probe = run({'action':'batch-inspect','authorizationMode':'confirmed_paths',
                   'targets':[{'relativePath':'clean_dir/' + fresh_batch + '/work_dirs/run2','type':'directory'}]})['targets'][0]
fresh_echo = fresh_probe.get('isolationCompletion') or {}
assert fresh_echo.get('isolationCompletionProtocol') == 1 and fresh_echo.get('archiveBatch') == fresh_batch \
    and fresh_echo.get('sourceRelativePath') == 'work_dirs/run2' \
    and fresh_echo.get('destinationRelativePath') == 'clean_dir/' + fresh_batch + '/work_dirs/run2', fresh_probe
assert isolation_state(archived_rel)['state'] == 'deleted'
assert (root / archived_rel / 'fresh.bin').read_text(encoding='utf-8') == 'keep'

# 9) control regions and unregistered archive paths remain protected on the
# current production batch chain, including before any mutation.
for rel in ('clean_dir','clean_dir/MANIFEST.md','clean_dir/.operations/isolation','clean_dir/' + BATCH):
    expect_code({'action':'batch-inspect', 'authorizationMode':'confirmed_paths',
                 'targets':[{'relativePath':rel,'type':'directory'}]}, 'PROTECTED_PATH')
unregistered = 'clean_dir/' + BATCH + '/never/registered'
(root / unregistered).mkdir(parents=True)
unbound = run({'action':'batch-inspect','authorizationMode':'confirmed_paths',
               'targets':[{'relativePath':unregistered,'type':'directory'}]})['targets'][0]
assert unbound.get('isolationState') is None and 'isolationCompletion' not in unbound, unbound
expect_code({'action':'delete-fast','authorizationMode':'confirmed_paths','operationId':'op-unbound','entries':[unbound]},
            'NOT_REGISTERED_ISOLATION')
assert (root / unregistered).is_dir()

# 10) restore clears the isolation registration so a later confirmed delete
# requires a fresh registration. Restore keeps the ordinary move contract
# (full content verification), so fast-path reads are snapshotted before it.
fast_reads = list(data_reads)
archived2 = 'clean_dir/' + BATCH + '/work_dirs/run3'
restore_target = {'relativePath': archived2, 'type': 'directory', 'archiveBatch': BATCH, 'destination': 'work_dirs/run3'}
restore_preview = run({'action': 'inspect', 'archived': True, 'target': dict(restore_target)})
restored = run({'action': 'restore', 'operationId': 'op-restore-run3',
                'target': {**restore_target, 'fingerprint': restore_preview['target']['fingerprint']}})
assert restored['ok'] and (outputs / 'run3' / 'epoch.ckpt').exists()
assert isolation_state(archived2)['state'] == 'restored'
# Recreating the restored archive name cannot acquire a deletion grant from
# its old registration: fresh entry binding still sees state=restored.
(root / archived2).mkdir(parents=True)
restored_entry = run({'action':'batch-inspect','authorizationMode':'confirmed_paths',
                      'targets':[{'relativePath':archived2,'type':'directory'}]})['targets'][0]
expect_code({'action':'delete-fast','authorizationMode':'confirmed_paths','operationId':'op-restored',
             'entries':[restored_entry]}, 'NOT_REGISTERED_ISOLATION')
assert (root / archived2).is_dir()

assert not fast_reads, ('data content was read on fast paths', fast_reads[:3])
assert any('epoch.ckpt' in read for read in data_reads), 'ordinary restore must still verify restored content fully'
print(json.dumps({'ok': True, 'fastIsolate': True, 'subtreeLocks': True, 'registeredDeletion': True}))
