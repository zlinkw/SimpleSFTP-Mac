"""End-to-end two-generation staged-slot lifecycle against the REAL production entries.

Spawns the receiver exactly as production does (argv base64/raw-deflate request + stdin
chunk frames, real filesystem), asks the read-only stale report as both inventory and
incoming-admission preview, proves a third generation fails closed, deletes exactly the
leaving slot through the confirmed-path production executor (root_guard → batch_inspect →
delete_fast with parent-cd "./leaf" semantics), lands the third generation into the freed
slot, and re-plays the retired generation idempotently. Prints one JSON verdict line.
"""
import base64
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import zlib

receiver_path, engine_path = sys.argv[1], sys.argv[2]
project = tempfile.mkdtemp(prefix="staged-slot-lifecycle-")

_TICK_ON = os.environ.get("STAGED_FIXTURE_TICKS") == "1"  # diagnostics only: stderr timing lines, stdout untouched
_TICK_LAST = [time.monotonic()]


def mark(name):
    if not _TICK_ON:
        return
    now = time.monotonic()
    sys.stderr.write("SIMPLE_TICK %s +%dms\n" % (name, round((now - _TICK_LAST[0]) * 1000)))
    _TICK_LAST[0] = now



def encode(request):
    compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
    raw = compressor.compress(json.dumps(request).encode("utf-8")) + compressor.flush()
    return base64.b64encode(raw).decode("ascii")


# Required keys per receiver request shape. The no-mode branch of the dispatch is the TAR
# receive path — NOT a mode string — so it gets its own list instead of a fake mode name.
CALL_REQUIRED = {"staleReport": ("root", "identity"),
                 "chunkStatus": ("root", "identity", "generation", "entries"),
                 "receiveChunk": ("root", "identity", "generation", "entries", "offset")}
TAR_REQUIRED = ("root", "identity", "generation", "entries")


def _dispatched_modes(path):
    # AUTHORITATIVE mode list derived from the receiver's own __main__ dispatch source (the
    # request.get("mode") comparisons exist only there): mode names are never hand-copied, so a
    # renamed or removed receiver mode fails the consistency assertion below instead of turning
    # the fixture guard itself into a KeyError.
    with open(path, encoding="utf-8") as handle:
        source = handle.read()
    return set(sum((re.findall(r'"(\w+)"', tail) for tail in
                    re.findall(r'request\.get\("mode"\)\s+(?:==|in)\s+([^\n]+?)(?=:|$)', source)), []))


def _fixture_modes(path):
    # Precise AST walk instead of a text scan: only literal mode values ACTUALLY handed to a
    # call(...) site count (a bare regex also hit unrelated keywords such as tarfile's mode="w").
    import ast
    with open(path, encoding="utf-8") as handle:
        tree = ast.parse(handle.read())
    modes = set()
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and ((isinstance(node.func, ast.Name) and node.func.id == "call")
                                                or (isinstance(node.func, ast.Attribute) and node.func.attr == "call"))):
            continue
        for arg in node.args:
            pairs = []
            if isinstance(arg, ast.Dict):
                pairs = [(k.value, v) for k, v in zip(arg.keys, arg.values) if isinstance(k, ast.Constant)]
            elif isinstance(arg, ast.Call) and isinstance(arg.func, ast.Name) and arg.func.id == "dict":
                pairs = [(kw.arg, kw.value) for kw in arg.keywords if kw is not None]
            for key, value in pairs:
                if key == "mode" and isinstance(value, ast.Constant) and isinstance(value.value, str):
                    modes.add(value.value)
    return modes


RECEIVER_MODES = _dispatched_modes(receiver_path)
FIXTURE_MODES = _fixture_modes(__file__)
assert RECEIVER_MODES, "could not derive any receiver mode from the dispatch source"
assert set(CALL_REQUIRED) <= RECEIVER_MODES, ("fixture guard registers modes the receiver never dispatches",
                                              sorted(CALL_REQUIRED), sorted(RECEIVER_MODES))
assert FIXTURE_MODES <= set(CALL_REQUIRED), ("fixture sends receiver modes the guard cannot validate",
                                             sorted(FIXTURE_MODES), sorted(CALL_REQUIRED))


def _slot_lock_symbol_consistency(path):
    # Same technique as the receiver-mode derivation: the slot-lock capability GUARD symbols and
    # the ACTUAL lock call symbols are derived from cleanup-files.py's own staged_slot_lock
    # source and must name the SAME modules. The WSL-3.12 regression (probing hasattr(os,
    # "flock") while fcntl.flock did the real locking) renamed the probe away from the call —
    # from now on either side drifting apart turns red HERE, naming both sets.
    with open(path, encoding="utf-8") as handle:
        source = handle.read()
    start = source.index("def staged_slot_lock(")
    body = source[start:source.index("\ndef ", start + 1)]
    guards = set(re.findall(r'(?:hasattr|getattr)\((\w+), "(?:flock|LOCK_EX|LOCK_NB)"', body))
    calls = set(re.findall(r'(\w+)\.flock\(', body))
    assert guards and guards == calls, ("slot-lock probe symbols diverge from lock call symbols",
                                        sorted(guards), sorted(calls))
    nt_calls = set(re.findall(r'(\w+)\.locking\(', body))
    assert nt_calls <= {"msvcrt"} and (not nt_calls or re.search(r'import msvcrt', body)), \
        ("NT slot-lock call must be msvcrt.locking behind its own import", sorted(nt_calls))
    assert not re.search(r'os\.flock\(', source), \
        "engine must never lock through os.flock — that probe/call split is the ruled WSL-3.12 defect"
    return sorted(guards)


SLOT_LOCK_SYMBOLS = _slot_lock_symbol_consistency(engine_path)


def call(request, stdin=b""):
    # Fixture-side construction guard: the receiver subscripts its request fields, so a malformed
    # hand-built request must fail HERE naming the missing keys, never later as an opaque wrapped
    # error code that hides which fixture call was wrong.
    mode = request.get("mode")
    if mode is None:
        required = TAR_REQUIRED
    else:
        required = CALL_REQUIRED.get(mode)
        assert required is not None, ("fixture guard has no required-keys entry for receiver mode %r; registered: %s; receiver dispatches: %s"
                                      % (mode, sorted(CALL_REQUIRED), sorted(RECEIVER_MODES)))
    missing = [key for key in required if request.get(key) is None]
    assert not missing, "fixture receiver request (%s) missing key(s): %s :: %r" % (mode or "tar-receive", missing, request)
    return subprocess.run([sys.executable, "-B", "-X", "utf8", receiver_path, encode(request)],
                          input=stdin, capture_output=True, timeout=8)


def tree_hash(root):
    rows = {}
    for parent, _dirs, names in os.walk(root):
        for name in names:
            full = os.path.join(parent, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            with open(full, "rb") as handle:
                rows[rel] = hashlib.sha256(handle.read()).hexdigest()
    return rows


KEY = "11" * 32
GEN_A, GEN_B, GEN_C = "a1" * 32, "b2" * 32, "c3" * 32
DID = "d-" + KEY[:24]
STAGING = "simple_cluster/.simple-sftp-staging"


def payload_bytes(tag):
    return (tag.encode("utf-8") * 4096)[:65536]


def land(generation, body, root=None, identity=None, path="out/large.bin"):
    digest = hashlib.sha256(body).hexdigest()
    entries = [{"path": path, "sha256": digest, "size": len(body)}]
    base = {"root": root or project, "identity": identity or KEY, "generation": generation, "entries": entries}
    status = call(dict(base, mode="chunkStatus"))
    assert status.returncode == 0, status.stderr.decode()[-2000:]
    assert json.loads(status.stdout)["offset"] == 0
    frame = json.dumps({"offset": 0, "size": len(body), "sha256": digest}).encode("utf-8") + b"\n" + body
    done = call(dict(base, mode="receiveChunk", offset=0), frame)
    assert done.returncode == 0, done.stderr.decode()[-2000:]
    assert json.loads(done.stdout)["completed"] is True
    return base


def slot_generation(slot):
    with open(os.path.join(project, STAGING, DID, slot, "manifest.json"), "rb") as handle:
        return json.loads(handle.read())


# Two committed generations occupy exactly the two slots.
land(GEN_A, payload_bytes("A"))
land(GEN_B, payload_bytes("B"))
assert slot_generation("0")["generation"] == GEN_A and slot_generation("0")["status"] == "committed"
assert slot_generation("1")["generation"] == GEN_B and slot_generation("1")["status"] == "committed"
assert open(os.path.join(project, "out", "large.bin"), "rb").read() == payload_bytes("B")

# Inventory is read-only and NEVER proposes the retained window.
before = tree_hash(project)
report = json.loads(call({"mode": "staleReport", "root": project, "identity": KEY}).stdout)
assert report["stale"] == [] and len(report["held"]) == 2, report
assert tree_hash(project) == before, "inventory mutated the staging tree"

# Admission preview for the incoming third generation names exactly the OLDEST slot as leaving.
report = json.loads(call({"mode": "staleReport", "root": project, "identity": KEY, "generation": GEN_C}).stdout)
assert [row["path"] for row in report["stale"]] == [STAGING + "/" + DID + "/0"], report
assert report["stale"][0]["type"] == "directory" and report["stale"][0]["generation"] == GEN_A
assert [row["path"] for row in report["held"]] == [STAGING + "/" + DID + "/1"]
assert tree_hash(project) == before, "admission preview mutated the staging tree"

# While both generations are retained, the third must fail closed.
blocked = call({"mode": "chunkStatus", "root": project, "identity": KEY, "generation": GEN_C,
                "entries": [{"path": "out/large.bin", "sha256": "0" * 64, "size": 10}]})
assert blocked.returncode != 0 and b"TRANSFER_STAGE_PENDING" in blocked.stderr, blocked.stderr[-500:]

# The confirmed managed executor removes EXACTLY the leaving slot subtree (entry-bound,
# parent-cd, non-overwriting), then absence is verified by the next real admission.
spec = importlib.util.spec_from_file_location("cleanup_engine", engine_path)
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)
root, identity = engine.root_guard(project)
leaving = report["stale"][0]["path"]
inspection = engine.batch_inspect(root, identity, {"authorizationMode": "confirmed_paths",
                                                   "operationId": "lifecycle-fixture",
                                                   "targets": [{"relativePath": leaving, "type": "directory"}]})
row = inspection["targets"][0]
kept_slot1 = tree_hash(os.path.join(project, STAGING, DID, "1"))
receipt = engine.delete_fast(root, identity, {"rootIdentity": identity, "operationId": "lifecycle-fixture",
                                              "authorizationMode": "confirmed_paths",
                                              "entries": [{key: row[key] for key in
                                                           ("relativePath", "type", "absolutePath", "device", "inode") if key in row}]})
assert receipt["ok"], receipt
assert not os.path.lexists(os.path.join(project, leaving)), "leaving slot still present after confirmed delete"
assert tree_hash(os.path.join(project, STAGING, DID, "1")) == kept_slot1, "retained generation was touched"

# The freed slot now admits the third generation and it lands byte-exact.
land(GEN_C, payload_bytes("C"))
assert open(os.path.join(project, "out", "large.bin"), "rb").read() == payload_bytes("C")
landed = slot_generation("0")
assert landed["generation"] == GEN_C and landed["status"] == "committed"
assert slot_generation("1")["generation"] == GEN_B and slot_generation("1")["status"] == "committed"
# The retired generation lost its slot to the confirmed cleanup: replaying it must fail closed
# instead of silently re-landing over the retained window.
replay = call({"mode": "chunkStatus", "root": project, "identity": KEY, "generation": GEN_A,
               "entries": [{"path": "out/large.bin", "sha256": "0" * 64, "size": 10}]})
assert replay.returncode != 0 and b"TRANSFER_STAGE_PENDING" in replay.stderr, replay.stderr[-500:]
# And the retained window again proposes nothing.
after = json.loads(call({"mode": "staleReport", "root": project, "identity": KEY}).stdout)
assert after["stale"] == [] and len(after["held"]) == 2

# ---------------------------------------------------------------------------
# r61 hardlink publication contract (artifact pending-alias regression).
# The scientific flow (quality_composition.py:402-406, read-only) writes the NEW content
# into a hidden ".<name>.<uuid>.pending" file first, then os.link()s that pending onto the
# declared result name — so target and alias share one inode (st_nlink == 2) and the alias
# must keep its exact bytes/inode afterwards. Publishing replaces only the CURRENT result
# directory entry (os.replace); it never writes new content into the shared inode, so a
# legal multi-link regular target must publish while non-regular targets stay rejected.
# Fixture mirrors that order: old file exists, then os.link onto the not-yet-existing alias.
# Separate sub-roots and identities keep every scenario's two-generation slot pool
# and artefact tree isolated (no shared state with the lifecycle block above).
# ---------------------------------------------------------------------------
import io
import tarfile


def tar_bytes(files):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, body in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(body)
            info.mtime = 0
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(body))
    return buffer.getvalue()


def publish_tar(root, identity, generation, files):
    entries = [{"path": name, "sha256": hashlib.sha256(body).hexdigest(), "size": len(body)}
               for name, body in files.items()]
    return call({"root": root, "identity": identity, "generation": generation, "entries": entries},
                stdin=tar_bytes(files))


def write(rel, body, root=None):
    full = os.path.join(root or project, rel)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "wb") as handle:
        handle.write(body)
    return full


def identity_key(tag):
    return (tag * 32)[:64]


mark("tar-publish")
# --- positive: tar publish onto a legal hard-linked metrics target + pending alias -------
KEY_T, KEY_C, KEY_N = identity_key("22"), identity_key("33"), identity_key("44")
GEN_D, GEN_E = "d1" * 32, "e1" * 32
tar_root = os.path.join(project, "tarcase")
os.makedirs(tar_root)
metrics = "test_results/job_metrics.csv"
alias = "test_results/.job_metrics.csv.5b0e4a3c-1f2d-4c6e-9a7b-0123456789ab.pending"
control = "test_results/metrics_summary.csv"
write(metrics, payload_bytes("M1"), tar_root)
os.link(os.path.join(tar_root, metrics), os.path.join(tar_root, alias))
write(control, payload_bytes("S1"), tar_root)  # plain single-link control target
before_target = os.lstat(os.path.join(tar_root, metrics))
before_alias = os.lstat(os.path.join(tar_root, alias))
assert before_target.st_ino == before_alias.st_ino and before_target.st_nlink == 2
published = publish_tar(tar_root, KEY_T, GEN_D, {metrics: payload_bytes("M2"), control: payload_bytes("S2")})
assert published.returncode == 0, published.stderr.decode()[-2000:]
after_target = os.lstat(os.path.join(tar_root, metrics))
after_alias = os.lstat(os.path.join(tar_root, alias))
assert open(os.path.join(tar_root, metrics), "rb").read() == payload_bytes("M2")
assert after_target.st_ino != before_target.st_ino, "publish must land a fresh inode, never write through the alias"
assert os.lstat(os.path.join(tar_root, alias)).st_ino == before_alias.st_ino
assert os.lstat(os.path.join(tar_root, alias)).st_nlink == 1  # old inode keeps exactly the alias reference
assert open(os.path.join(tar_root, alias), "rb").read() == payload_bytes("M1"), "pending alias bytes changed"
assert open(os.path.join(tar_root, control), "rb").read() == payload_bytes("S2"), "plain single-link control target must publish"

# --- positive: chunk publish obeys the SAME target contract (guard at the chunk commit) ----
chunk_root = os.path.join(project, "chunkcase")
os.makedirs(chunk_root)
chunk_file = "work2/metrics_case.csv"
chunk_alias = "work2/.metrics_case.csv.0f0e0d0c-0b0a-0908-0706-0504030201ff.pending"
write(chunk_file, payload_bytes("C1"), chunk_root)
os.link(os.path.join(chunk_root, chunk_file), os.path.join(chunk_root, chunk_alias))
chunk_before = os.lstat(os.path.join(chunk_root, chunk_file))
land(GEN_E, payload_bytes("C2"), root=chunk_root, identity=KEY_C, path=chunk_file)
chunk_after = os.lstat(os.path.join(chunk_root, chunk_file))
assert open(os.path.join(chunk_root, chunk_file), "rb").read() == payload_bytes("C2")
assert chunk_after.st_ino != chunk_before.st_ino
assert os.lstat(os.path.join(chunk_root, chunk_alias)).st_ino == chunk_before.st_ino
assert open(os.path.join(chunk_root, chunk_alias), "rb").read() == payload_bytes("C1")

# --- negatives: the pre-existing protections stay exactly in force --------------------------
neg_root = os.path.join(project, "negcase")
os.makedirs(os.path.join(neg_root, "locked_dir", "x.bin"))
link_target = write("link_target.bin", payload_bytes("L1"), neg_root)
os.symlink("link_target.bin", os.path.join(neg_root, "sym.bin"))
rejected_dir = publish_tar(neg_root, KEY_N, GEN_D, {"locked_dir/x.bin": payload_bytes("X2")})
assert rejected_dir.returncode != 0 and b"unsafe publication target" in rejected_dir.stderr, rejected_dir.stderr[-800:]
assert os.path.isdir(os.path.join(neg_root, "locked_dir", "x.bin")) and os.listdir(os.path.join(neg_root, "locked_dir", "x.bin")) == []
GEN_N2 = "e2" * 32
rejected_link = publish_tar(neg_root, KEY_N, GEN_N2, {"sym.bin": payload_bytes("Y2")})
assert rejected_link.returncode != 0 and b"unsafe publication target" in rejected_link.stderr, rejected_link.stderr[-800:]
assert os.readlink(os.path.join(neg_root, "sym.bin")) == "link_target.bin"
assert open(link_target, "rb").read() == payload_bytes("L1")

# ---------------------------------------------------------------------------
mark("expiry-contract")
# r118 committed-slot expiry reclaim contract (0.2.113).
# terminalAt is written when a row ENTERS committed and never refreshed while terminal; the
# expiry verdict is computed ONLY from the remote clock over the trusted basis (terminalAt,
# legacy updatedAt, and the non-followed manifest mtime as last resort), and every time
# problem keeps the slot protected. The receiver itself NEVER reclaims — admission stays
# fail-closed TRANSFER_STAGE_PENDING and only adds the machine-readable stderr facts.
# ---------------------------------------------------------------------------
recv_spec = importlib.util.spec_from_file_location("staged_receive", receiver_path)
recv = importlib.util.module_from_spec(recv_spec)
recv_spec.loader.exec_module(recv)


def engine(request):
    # Fixture-side construction guard mirroring the production chain (cleanup-file-api.js 536-542
    # forces destination before ANY isolate inspect; cleanup-files.py subscripts target["destination"]
    # in isolate_inspect and pins archiveBatch/destination layout for the isolate action). A
    # hand-built request must fail HERE naming the missing key, never be swallowed into the
    # engine's wrapped INSPECTION_OR_AUDIT_FAILED code that hides the real defect.
    assert isinstance(request.get("root"), str) and request.get("root"), request
    action = request.get("action")
    assert isinstance(action, str) and action, request
    assert re.fullmatch(r"[a-zA-Z0-9._:-]{1,128}", str(request.get("operationId") or "")), request
    target = request.get("target")
    assert isinstance(target, dict) and isinstance(target.get("relativePath"), str) and target["relativePath"] \
        and target.get("type") in ("file", "directory"), target
    if action == "isolate" or (action == "inspect" and request.get("isolate")):
        assert isinstance(target.get("destination"), str) and target["destination"], \
            "engine %s requires target.destination :: %r" % (action, target)
    batch = target.get("archiveBatch")
    if batch is not None:
        assert re.fullmatch(r"job-[a-f0-9]{48}", batch), target
        assert target.get("destination") == "clean_dir/" + batch + "/" + target["relativePath"], target
    done = subprocess.run([sys.executable, "-B", "-X", "utf8", engine_path],
                          input=json.dumps(request).encode("utf-8"), capture_output=True, timeout=15)
    assert done.returncode == 0, done.stderr.decode()[-1500:]
    return json.loads(done.stdout.decode("utf-8").strip().split("\n").pop())


def edit_journal(root_dir, identity, slot, mutate):
    full = os.path.join(root_dir, STAGING, "d-" + identity[:24], slot, "manifest.json")
    with open(full, "rb") as handle:
        row = json.loads(handle.read())
    mutate(row)
    with open(full, "wb") as handle:
        handle.write(json.dumps(row).encode("utf-8"))
    return row


EXPIRY_MS = 86400000


def edited_leaving(report):
    # Locate the EDITED slot by its slot path, never by list index: the window evicts the row with
    # the OLDEST createdAt, so every protection scenario below must first prove that edited slot IS
    # still that single leaving candidate — otherwise its assertion would silently guard another
    # (healthy) row. The path suffix check simultaneously pins the ruled eviction-order semantics.
    rows = [row for row in report["stale"] if row["path"].endswith("/0")]
    assert len(report["stale"]) == 1 and len(rows) == 1, report["stale"]
    return rows[0]


KEY_B, GEN_B1, GEN_B2 = identity_key("bb"), "a8" * 32, "b8" * 32


def resume_checkpoint(row):
    row["status"] = "preparing"
    row["entries"] = []
    row.pop("terminalAt", None)


SECTION = sys.argv[3] if len(sys.argv) > 3 else "core"  # 0.2.114 timing split: core and release spawn independently
if SECTION == "release":
    # --- 0.2.114: a user-CONFIRMED early release must actually succeed under the same under-lock
    # --- recheck, and NOTHING else may loosen. A committed slot one minute past its terminal moment
    # --- is exactly the manual-button case: the receiver itself says "not expired", so only the
    # --- requireExpired:false mode (frozen by preview from the user's own confirmation) can pass —
    # --- and it passes while every remaining rule still denies. Success/refusal is asserted against
    # --- the REAL filesystem: the source slot directory is really gone, the isolated copy really
    # --- exists — never a simulated boolean standing in for directory state.
    def user_release_case(name, require_expired=False, mutate=None, future_terminal=False, remove_journal=False,
                          journal_bytes=None):
        case_start = time.monotonic()
        case_root = os.path.join(project, "released-" + name)
        os.makedirs(case_root)
        land(GEN_B1, payload_bytes("R1"), root=case_root, identity=KEY_B)
        land(GEN_B2, payload_bytes("R2"), root=case_root, identity=KEY_B)
        committed_at = int(time.time()) - 60  # YOUNG: a full day minus a minute to go
        edit_journal(case_root, KEY_B, "0", lambda row: row.update(
            createdAt=(committed_at - 60) * 1_000_000_000,
            terminalAt=committed_at + 3600 if future_terminal else committed_at))
        # The receiver itself must call this slot NOT expired BEFORE any tampering: only the user-
        # confirmed mode can ever unlock it (asserted pre-mutation, like the binding race cases).
        assert edited_leaving(recv.stale_report(case_root, KEY_B, "c8" * 32, EXPIRY_MS))["expiredCommitted"] is False, name
        journal_path = os.path.join(case_root, STAGING, "d-" + KEY_B[:24], "0", "manifest.json")
        if remove_journal:
            os.remove(journal_path)
        elif journal_bytes is not None:
            with open(journal_path, "wb") as handle:
                handle.write(journal_bytes)
        if mutate is not None:
            edit_journal(case_root, KEY_B, "0", mutate)
        slot_rel = STAGING + "/d-" + KEY_B[:24] + "/0"
        batch = "job-" + hashlib.sha256(("released-" + name).encode("utf-8")).hexdigest()[:48]
        binding = {"identity": KEY_B, "generation": GEN_B1, "status": "committed",
                   "terminalAt": committed_at + 3600 if future_terminal else committed_at, "expiryMs": EXPIRY_MS}
        if require_expired is not None:
            binding["requireExpired"] = require_expired
        isolate = engine({"root": case_root, "action": "isolate", "operationId": "released-" + name,
                          "target": {"relativePath": slot_rel, "type": "directory", "archiveBatch": batch,
                                     "destination": "clean_dir/" + batch + "/" + slot_rel},
                          "stagedJournal": binding})
        if _TICK_ON:
            sys.stderr.write("SIMPLE_TICK case:%s wall=%dms\n" % (name, round((time.monotonic() - case_start) * 1000)))
        return isolate, os.path.join(case_root, STAGING, "d-" + KEY_B[:24], "0"), \
            os.path.join(case_root, "clean_dir", batch, slot_rel)


    def user_release_refused(name, accepted_codes=("STAGED_JOURNAL_MISMATCH",), **kwargs):
        isolate, slot_dir, _ = user_release_case(name, **kwargs)
        return (isolate["ok"] is False and isolate["error"]["code"] in accepted_codes
                and os.path.exists(slot_dir))


    release_iso, release_slot_dir, release_dest = user_release_case("young")
    userReleaseYoungAccepted = (release_iso["ok"] is True
                                and not os.path.exists(release_slot_dir)      # source slot really gone
                                and os.path.isfile(os.path.join(release_dest, "manifest.json")))  # copy really exists
    # 0.2.113 defaults stay byte-for-byte: absent or true keeps the age rule, young slot refused.
    userReleaseAbsentStillRefused = user_release_refused("youngabsent", require_expired=None)
    userReleaseTrueStillRefused = user_release_refused("youngtrue", require_expired=True)
    # A truthy stand-in is not the mode: the engine shape-check denies before anything else.
    mode_shape_isolate, mode_shape_dir, _ = user_release_case("youngstring", require_expired="false")
    userReleaseModeNotBooleanRefused = (mode_shape_isolate["ok"] is False
                                        and mode_shape_isolate["error"]["code"] == "INVALID_STAGED_JOURNAL_BINDING"
                                        and os.path.exists(mode_shape_dir))
    # With the mode set, EVERY other under-lock rule still denies on a genuinely mutated journal.
    userReleaseGenerationSwapRefused = user_release_refused("gswap", mutate=lambda row: row.update(generation="f8" * 32))
    userReleaseNonTerminalRefused = user_release_refused("nonterminal", mutate=resume_checkpoint)
    userReleaseFreshCommitRefused = user_release_refused("fresh", mutate=lambda row: row.update(terminalAt=int(time.time())))
    userReleaseMalformedTimeRefused = user_release_refused("nullupdate", mutate=lambda row: row.update(updatedAt=None))
    userReleaseFutureTimeRefused = user_release_refused("future", future_terminal=True)  # binding carries the SAME future moment
    userReleaseCreatedContradictionRefused = user_release_refused(
        "contradict", mutate=lambda row: row.update(createdAt=(int(time.time()) + 3600) * 1_000_000_000))
    # --- G2 RED round定性: a REMOVED journal was always refused — path_guard's own MISSING_TARGET
    # --- gate (cleanup-files.py:177-179, called at :1110 BEFORE the binding recheck and the rename)
    # --- denies fail-closed; only the old fixture key wrongly demanded STAGED_JOURNAL_MISMATCH and
    # --- scored a legitimate refusal as a failure. Both fail-closed codes are accepted here and the
    # --- untouched-slot assertion stays: the "missing ledger must refuse" protection is unchanged.
    userReleaseJournalRemovedRefused = user_release_refused("nojournal", remove_journal=True,
                                                            accepted_codes=("MISSING_TARGET", "STAGED_JOURNAL_MISMATCH"))
    # Journal missing / corrupt / non-object must refuse under BOTH modes, on the real files.
    userReleaseJournalRemovedDefaultRefused = user_release_refused("nojournal-default", require_expired=None, remove_journal=True,
                                                                   accepted_codes=("MISSING_TARGET", "STAGED_JOURNAL_MISMATCH"))
    userReleaseJournalCorruptRefused = user_release_refused("journal-corrupt", journal_bytes=b"{not-json")
    userReleaseJournalCorruptDefaultRefused = user_release_refused("journal-corrupt-default", require_expired=None, journal_bytes=b"{not-json")
    userReleaseJournalNonObjectRefused = user_release_refused("journal-array", journal_bytes=b"[7]")
    userReleaseJournalNonObjectDefaultRefused = user_release_refused("journal-array-default", require_expired=None, journal_bytes=b"[7]")
    # --- capability truth at the engine door: staged-slot isolate inspects answer the mode;
    # --- non-staged targets (and therefore every older engine) stay silent.
    os.makedirs(os.path.join(project, "plaindir"), exist_ok=True)
    nonstaged_silent = engine({"root": project, "action": "inspect", "isolate": True, "operationId": "proof-silent",
                               "target": {"relativePath": "plaindir", "type": "directory",
                                          "destination": "clean_dir/" + "job-" + "cd" * 24 + "/plaindir"}})
    userReleaseInspectProof = (nonstaged_silent.get("ok") is True and nonstaged_silent.get("backgroundIsolatedDelete") == 1
                               and "userConfirmedSlotRelease" not in nonstaged_silent)  # non-staged stays silent
    # Land a real staged slot in the main project tree and prove the POSITIVE answer end to end.
    land(GEN_B1, payload_bytes("PF"), root=project, identity=KEY_B)
    proof_slot_rel = STAGING + "/d-" + KEY_B[:24] + "/0"
    proof_answer = engine({"root": project, "action": "inspect", "isolate": True, "operationId": "proof-answer",
                           "target": {"relativePath": proof_slot_rel, "type": "directory",
                                      "destination": "clean_dir/" + "job-" + "ef" * 24 + "/" + proof_slot_rel}})
    userReleaseInspectAnswers = proof_answer.get("userConfirmedSlotRelease") == 1
    assert (userReleaseYoungAccepted and userReleaseAbsentStillRefused and userReleaseTrueStillRefused
            and userReleaseModeNotBooleanRefused and userReleaseGenerationSwapRefused
            and userReleaseNonTerminalRefused and userReleaseFreshCommitRefused
            and userReleaseMalformedTimeRefused and userReleaseFutureTimeRefused
            and userReleaseCreatedContradictionRefused and userReleaseJournalRemovedRefused
            and userReleaseJournalRemovedDefaultRefused and userReleaseJournalCorruptRefused
            and userReleaseJournalCorruptDefaultRefused and userReleaseJournalNonObjectRefused
            and userReleaseJournalNonObjectDefaultRefused
            and userReleaseInspectProof and userReleaseInspectAnswers), {
            "young": release_iso, "absent": userReleaseAbsentStillRefused, "true": userReleaseTrueStillRefused,
            "shape": mode_shape_isolate, "gswap": userReleaseGenerationSwapRefused,
            "nonterminal": userReleaseNonTerminalRefused, "fresh": userReleaseFreshCommitRefused,
            "nullupdate": userReleaseMalformedTimeRefused, "future": userReleaseFutureTimeRefused,
            "contradict": userReleaseCreatedContradictionRefused, "nojournal": userReleaseJournalRemovedRefused,
            "silent": userReleaseInspectProof, "answer": proof_answer}
    print(json.dumps({"ok": True, "userRelease": {"userReleaseYoungAccepted": userReleaseYoungAccepted, "userReleaseAbsentStillRefused": userReleaseAbsentStillRefused, "userReleaseTrueStillRefused": userReleaseTrueStillRefused, "userReleaseModeNotBooleanRefused": userReleaseModeNotBooleanRefused, "userReleaseGenerationSwapRefused": userReleaseGenerationSwapRefused, "userReleaseNonTerminalRefused": userReleaseNonTerminalRefused, "userReleaseFreshCommitRefused": userReleaseFreshCommitRefused, "userReleaseMalformedTimeRefused": userReleaseMalformedTimeRefused, "userReleaseFutureTimeRefused": userReleaseFutureTimeRefused, "userReleaseCreatedContradictionRefused": userReleaseCreatedContradictionRefused, "userReleaseJournalRemovedRefused": userReleaseJournalRemovedRefused, "userReleaseJournalRemovedDefaultRefused": userReleaseJournalRemovedDefaultRefused, "userReleaseJournalCorruptRefused": userReleaseJournalCorruptRefused, "userReleaseJournalCorruptDefaultRefused": userReleaseJournalCorruptDefaultRefused, "userReleaseJournalNonObjectRefused": userReleaseJournalNonObjectRefused, "userReleaseJournalNonObjectDefaultRefused": userReleaseJournalNonObjectDefaultRefused, "userReleaseInspectProof": userReleaseInspectProof, "userReleaseInspectAnswers": userReleaseInspectAnswers}}))
    raise SystemExit

KEY_X = identity_key("55")
GEN_X1, GEN_X2, GEN_X3, GEN_X4 = "f1" * 32, "f2" * 32, "f3" * 32, "f4" * 32
exp_root = os.path.join(project, "expcase")
os.makedirs(exp_root)
land(GEN_X1, payload_bytes("X1"), root=exp_root, identity=KEY_X)
land(GEN_X2, payload_bytes("X2"), root=exp_root, identity=KEY_X)
# terminalAtWritten: every fresh committed journal carries a positive terminal moment.
terminalAtWritten = all((slot_generation(slot).get("terminalAt") or 0) > 0
                        and abs(slot_generation(slot)["terminalAt"] - slot_generation(slot)["updatedAt"]) <= 1
                        for slot in ("0", "1"))
assert terminalAtWritten, (slot_generation("0"), slot_generation("1"))

mark("journal-lifecycle")
# --- journal terminalAt lifecycle: enter committed writes it, terminal rewrites carry it,
# --- any non-terminal rewrite drops it, a fresh re-commit stamps a new terminal moment.
jcase = os.path.join(project, "jcase")
os.makedirs(os.path.join(jcase, STAGING, "d-" + KEY_X[:24], "0"))
journal_fd = os.open(os.path.join(jcase, STAGING, "d-" + KEY_X[:24], "0"), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
recv.journal(journal_fd, {"identity": KEY_X, "generation": GEN_X4, "status": "committed", "count": 1})
first_commit = recv.read_journal(journal_fd)
assert (first_commit.get("terminalAt") or 0) > 0
recv.journal(journal_fd, {"identity": KEY_X, "generation": GEN_X4, "status": "committed", "count": 2})
second_commit = recv.read_journal(journal_fd)
assert second_commit["terminalAt"] == first_commit["terminalAt"], "terminal rewrites must never refresh terminalAt"
recv.journal(journal_fd, {"identity": KEY_X, "generation": GEN_X4, "status": "preparing", "entries": []})
assert "terminalAt" not in recv.read_journal(journal_fd), "a resumed (non-terminal) row must drop terminalAt"
os.close(journal_fd)
journalTerminalAtCarried = True

def set_times(identity, slot, created_ago, terminal_ago):
    # Age a slot explicitly on BOTH clocks: eviction orders by createdAt ascending and the expiry
    # verdict reads the terminalAt basis, so a scenario must state both or the edited row silently
    # stops being the leaving candidate it claims to test.
    now = int(time.time())
    edit_journal(exp_root, identity, slot, lambda row: row.update(
        createdAt=(now - created_ago) * 1_000_000_000, terminalAt=now - terminal_ago))


def set_terminal(identity, slot, seconds_ago):
    # A REAL aged generation: createdAt rolls back with terminalAt (terminalAt >= createdAt),
    # because a terminalAt older than createdAt IS the ruled clock contradiction that must stay
    # protected — pinning an aged slot to a fresh createdAt would test the guard, not expiry.
    set_times(identity, slot, seconds_ago + 60, seconds_ago)


set_terminal(KEY_X, "0", 172800)  # two days old, slot 1 stays fresh
exp_report = json.loads(call({"mode": "staleReport", "root": exp_root, "identity": KEY_X, "generation": GEN_X3,
                              "expiry": {"ms": EXPIRY_MS}}).stdout)
expiredOldGenerationTrue = (len(exp_report["stale"]) == 1
                            and exp_report["stale"][0]["expiredCommitted"] is True
                            and exp_report["stale"][0]["expiryReason"] == "expired"
                            and exp_report["stale"][0]["timeSource"] == "terminalAt"
                            and exp_report["stale"][0]["ageMs"] >= 172800000
                            and exp_report["stale"][0]["locked"] is False
                            and len(exp_report["held"]) == 1
                            and exp_report["held"][0]["protectedReason"] == "within-retention-window"
                            and len(exp_report["slots"]) == 2
                            and sorted(row["role"] for row in exp_report["slots"]) == ["held", "leaving"])
assert expiredOldGenerationTrue, exp_report

# While the stale candidate is only PROPOSED, the receiver itself never reclaims: the third
# generation stays fail-closed, and the refusal now additionally carries machine-readable facts.
blocked2 = call({"mode": "chunkStatus", "root": exp_root, "identity": KEY_X, "generation": GEN_X3,
                 "entries": [{"path": "out/large.bin", "sha256": "0" * 64, "size": 10}]})
claimStillPending = blocked2.returncode != 0 and b"TRANSFER_STAGE_PENDING" in blocked2.stderr
structuredPendingFacts = b"SIMPLE_STAGE_PENDING " in blocked2.stderr
if structuredPendingFacts:
    marker_line = next(line for line in blocked2.stderr.decode("utf-8").split("\n") if line.startswith("SIMPLE_STAGE_PENDING "))
    marker = json.loads(marker_line[len("SIMPLE_STAGE_PENDING "):])
    structuredPendingFacts = (marker["code"] == "TRANSFER_STAGE_PENDING" and marker["identity"] == KEY_X
                              and marker["incomingGeneration"] == GEN_X3 and len(marker["slots"]) == 2)
assert claimStillPending and structuredPendingFacts, blocked2.stderr[-600:]

# --- deterministic threshold boundary (same-process report so the clock cannot drift):
# exactly `expiry` old is expired (>=), one second younger is protected.
set_terminal(KEY_X, "0", 86400)
boundary_expired = recv.stale_report(exp_root, KEY_X, GEN_X4, EXPIRY_MS)
boundaryAtLeastDay = edited_leaving(boundary_expired)["expiredCommitted"] is True
set_terminal(KEY_X, "0", 86399)
boundary_young = recv.stale_report(exp_root, KEY_X, GEN_X4, EXPIRY_MS)
boundary_row = edited_leaving(boundary_young)
boundaryJustBelow = boundary_row["expiredCommitted"] is False and boundary_row["expiryReason"] == "within-threshold"
assert boundaryAtLeastDay and boundaryJustBelow, (boundary_expired["stale"], boundary_young["stale"])

# --- untrusted time NEVER expires: future stamps and clock contradictions stay protected ON THE
# --- EDITED SLOT ITSELF. It therefore stays a genuine aged generation by createdAt (oldest =>
# --- still the leaving candidate) while ONLY its terminalAt lies in the future: a future or
# --- contradictory terminalAt must never promote an aged slot back into the retained window,
# --- and the untrusted basis must never yield expiredCommitted.
set_times(KEY_X, "0", 172860, -3600)  # aged slot, terminalAt one hour into the future
future_report = recv.stale_report(exp_root, KEY_X, GEN_X4, EXPIRY_MS)
future_row = edited_leaving(future_report)
futureProtected = (future_row["expiredCommitted"] is False and future_row["expiryReason"] == "time-future")
created_seconds = int(recv.read_journal(os.open(os.path.join(exp_root, STAGING, "d-" + KEY_X[:24], "0"),
                                                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))["createdAt"] // 1_000_000_000)
edit_journal(exp_root, KEY_X, "0", lambda row: row.update(terminalAt=created_seconds - 10))
contradiction_report = recv.stale_report(exp_root, KEY_X, GEN_X4, EXPIRY_MS)
contradiction_row = edited_leaving(contradiction_report)
contradictionProtected = (contradiction_row["expiredCommitted"] is False
                          and contradiction_row["expiryReason"] == "time-contradiction")
assert futureProtected and contradictionProtected, (future_report["stale"], contradiction_report["stale"])

# --- manifest-mtime fallback ONLY for a valid journal with no usable timestamps; slot
# --- directory/lock/data mtimes are never consulted (this is the last accepted source).
def strip_times(row):
    row.pop("terminalAt", None)
    row.pop("updatedAt", None)
edit_journal(exp_root, KEY_X, "0", strip_times)
manifest_path = os.path.join(exp_root, STAGING, "d-" + KEY_X[:24], "0", "manifest.json")
old = time.time() - 172800
os.utime(manifest_path, (old, old))
mtime_report = recv.stale_report(exp_root, KEY_X, GEN_X4, EXPIRY_MS)
mtimeAgedExpired = (mtime_report["stale"][0]["expiredCommitted"] is True
                    and mtime_report["stale"][0]["timeSource"] == "manifestMtime")
fresh = time.time()
os.utime(manifest_path, (fresh, fresh))
mtime_report2 = recv.stale_report(exp_root, KEY_X, GEN_X4, EXPIRY_MS)
mtimeFreshProtected = mtime_report2["stale"][0]["expiredCommitted"] is False
assert mtimeAgedExpired and mtimeFreshProtected, (mtime_report["stale"], mtime_report2["stale"])

# --- P1-1 ruling: PRESENT-but-MALFORMED never falls back to older evidence. The written commit
# --- time is untrusted, so neither a stale updatedAt nor the manifest mtime may prove expiry;
# --- every unusable value shape stays protected.
# --- FINAL REVIEW P1-B: the matrix covers EVERY time field, not just terminalAt. Each case leaves
# --- the two remaining fields LEGALLY AGED (older than the threshold), so the only thing that can
# --- keep the slot protected is checking the malformed field BEFORE choosing an age basis.
KEY_M, GEN_M1, GEN_M2 = identity_key("99"), "e1" * 32, "e2" * 32
mal_root = os.path.join(project, "malformedcase")
os.makedirs(mal_root)
land(GEN_M1, payload_bytes("M1"), root=mal_root, identity=KEY_M)
land(GEN_M2, payload_bytes("M2"), root=mal_root, identity=KEY_M)
malformedTimeProtected = True
malformedNoOlderFallback = True
MALFORMED_MATRIX = []
for field in ("terminalAt", "updatedAt", "createdAt"):
    for bad in ("172800000", True, 172800000.5, None):
        def poison(row, broken=field, value=bad):
            # Both sibling fields are aged past the threshold: an aged legitimate terminalAt beside
            # a malformed updatedAt is exactly the combination that used to report expired.
            row["terminalAt"] = int(time.time()) - 172800
            row["updatedAt"] = int(time.time()) - 172800
            row["createdAt"] = (int(time.time()) - 172860) * 1_000_000_000
            row[broken] = value
        edit_journal(mal_root, KEY_M, "0", poison)
        bad_row = edited_leaving(recv.stale_report(mal_root, KEY_M, "d1" * 32, EXPIRY_MS))
        assert bad_row["expiredCommitted"] is False and bad_row["expiryReason"] == "time-format", (field, bad, bad_row)
        assert bad_row["timeSource"] is None, (field, bad, bad_row)
        MALFORMED_MATRIX.append(field + "=" + repr(bad))
# --- the manifest-mtime fallback is NOT exempt from the createdAt contradiction rule.
edit_journal(mal_root, KEY_M, "0", strip_times)
edit_journal(mal_root, KEY_M, "0", lambda row: row.update(createdAt=(int(time.time()) - 100) * 1_000_000_000))
os.utime(os.path.join(mal_root, STAGING, "d-" + KEY_M[:24], "0", "manifest.json"), (time.time() - 172800,) * 2)
mtime_bad_row = edited_leaving(recv.stale_report(mal_root, KEY_M, "d1" * 32, EXPIRY_MS))
mtimeContradictionProtected = (mtime_bad_row["expiredCommitted"] is False
                               and mtime_bad_row["expiryReason"] == "time-contradiction")
# --- but a LEGITIMATE legacy row (fields genuinely absent, consistent times) still expires.
edit_journal(mal_root, KEY_M, "0", lambda row: row.update(createdAt=(int(time.time()) - 172860) * 1_000_000_000))
# edit_journal REWRITES manifest.json, refreshing its mtime to now; re-age it AFTER the last
# edit (same edit-then-utime order as the accepted fallback case above) so the report reads
# the intended 2-day-old evidence instead of the fixture's own write.
os.utime(os.path.join(mal_root, STAGING, "d-" + KEY_M[:24], "0", "manifest.json"), (time.time() - 172800,) * 2)
legacy_row = edited_leaving(recv.stale_report(mal_root, KEY_M, "d1" * 32, EXPIRY_MS))
legacyFallbackStillWorks = legacy_row["expiredCommitted"] is True and legacy_row["timeSource"] == "manifestMtime"
assert (malformedTimeProtected and malformedNoOlderFallback and mtimeContradictionProtected
        and legacyFallbackStillWorks), (malformedNoOlderFallback, mtime_bad_row, legacy_row)

# --- same-generation retry proposes nothing; inventory keeps every slot held.
own_report = recv.stale_report(exp_root, KEY_X, GEN_X1)  # GEN_X1 still owns slot 0 (only times were edited)
sameGenerationNoReclaim = own_report["stale"] == [] and own_report["slots"][0]["role"] == "held"
inventory_report = recv.stale_report(exp_root, KEY_X)
inventoryRolesHeld = inventory_report["stale"] == [] and all(row["role"] == "held" for row in inventory_report["slots"])
assert sameGenerationNoReclaim and inventoryRolesHeld, (own_report, inventory_report)

# --- corrupt journal stays protected even with expiry requested.
KEY_C2 = identity_key("66")
GEN_C2A, GEN_C2B = "a6" * 32, "b6" * 32
corrupt_root = os.path.join(project, "corruptcase")
os.makedirs(corrupt_root)
land(GEN_C2A, payload_bytes("K1"), root=corrupt_root, identity=KEY_C2)
land(GEN_C2B, payload_bytes("K2"), root=corrupt_root, identity=KEY_C2)
with open(os.path.join(corrupt_root, STAGING, "d-" + KEY_C2[:24], "0", "manifest.json"), "wb") as handle:
    handle.write(b"{not-json")
corrupt_report = recv.stale_report(corrupt_root, KEY_C2, "c6" * 32, EXPIRY_MS)
corruptProtected = (corrupt_report["stale"] == []
                    and any(row["status"] == "unresolved" and row["protectedReason"] == "journal-unresolved"
                            for row in corrupt_report["held"]))
assert corruptProtected, corrupt_report

mark("slot-lock")
# --- isolation-moment slot lock: while a claim holds the flock, BOTH the read-only report and
# --- the engine isolate refuse; after release the isolate lands and the freed slot re-admits.
KEY_L = identity_key("77")
GEN_L1, GEN_L2, GEN_L3 = "a7" * 32, "b7" * 32, "c7" * 32
lock_root = os.path.join(project, "lockcase")
os.makedirs(lock_root)
land(GEN_L1, payload_bytes("L1b"), root=lock_root, identity=KEY_L)
land(GEN_L2, payload_bytes("L2b"), root=lock_root, identity=KEY_L)
lock_slot = "0"  # the first land takes slot 0 deterministically
assert json.loads(open(os.path.join(lock_root, STAGING, "d-" + KEY_L[:24], lock_slot, "manifest.json"), "rb").read())["generation"] == GEN_L1
lock_holder = os.open(os.path.join(lock_root, STAGING, "d-" + KEY_L[:24], lock_slot + ".lock"),
                      os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
import fcntl as _fcntl
_fcntl.flock(lock_holder, _fcntl.LOCK_EX)
try:
    locked_report = recv.stale_report(lock_root, KEY_L, GEN_L3, EXPIRY_MS)
    lockedProtected = (locked_report["stale"] == []
                       and any(row["status"] == "locked" and row["protectedReason"] == "slot-locked"
                               and row["locked"] is True for row in locked_report["held"]))
    slot_rel = STAGING + "/d-" + KEY_L[:24] + "/" + lock_slot
    # The frozen isolate binding is built ONCE, exactly as the production preview hands it to the
    # isolate inspect (cleanup-file-api.js 536-542: destination is validated before inspect and is
    # re-sent unchanged at execute): inspect and isolate now see the IDENTICAL target fields.
    batch = "job-" + hashlib.sha256(b"lockcase-isolate").hexdigest()[:48]
    frozen_target = {"relativePath": slot_rel, "type": "directory", "archiveBatch": batch,
                     "destination": "clean_dir/" + batch + "/" + slot_rel}
    isolate_inspection = engine({"root": lock_root, "action": "inspect", "isolate": True, "operationId": "lock-iso",
                                 "target": dict(frozen_target)})
    assert isolate_inspection["ok"], isolate_inspection
    locked_isolate = engine({"root": lock_root, "action": "isolate", "operationId": "lock-iso", "target": frozen_target})
    slotLockHeldBlocksIsolate = (locked_isolate["ok"] is False
                                 and locked_isolate["error"]["code"] in ("SLOT_LOCK_HELD", "SLOT_LOCK_UNCERTAIN"))
    assert lockedProtected and slotLockHeldBlocksIsolate, (locked_report, locked_isolate)
finally:
    _fcntl.flock(lock_holder, _fcntl.LOCK_UN)
    os.close(lock_holder)
released_isolate = engine({"root": lock_root, "action": "isolate", "operationId": "lock-iso-2", "target": frozen_target})
isolateAfterRelease = released_isolate["ok"] is True
claimAfterIsolate = call({"mode": "chunkStatus", "root": lock_root, "identity": KEY_L, "generation": GEN_L3,
                          "entries": [{"path": "out/large.bin", "sha256": "0" * 64, "size": 10}]})
claimAdmitted = claimAfterIsolate.returncode == 0 and json.loads(claimAfterIsolate.stdout)["offset"] == 0
assert isolateAfterRelease and claimAdmitted, (released_isolate, claimAfterIsolate.stderr[-400:])

mark("p13-binding")
# --- P1-3 ruling: the reclaim authorization binds to the journal, not the path, and the engine
# --- re-proves identity/generation/committed-status/terminal-moment/age UNDER the held slot lock
# --- before the rename. Same-generation resume, regeneration or fresh re-commit between report
# --- and isolate must each refuse and leave the slot untouched; the untouched expired slot still
# --- isolates (the gate is not a blanket denial).


def reclaim_binding_case(name, mutate_before_isolate, binding_terminal="keep", reage_manifest=False):
    case_root = os.path.join(project, "binding-" + name)
    os.makedirs(case_root)
    land(GEN_B1, payload_bytes("B1"), root=case_root, identity=KEY_B)
    land(GEN_B2, payload_bytes("B2"), root=case_root, identity=KEY_B)
    aged_terminal = int(time.time()) - 172800
    edit_journal(case_root, KEY_B, "0", lambda row: row.update(
        createdAt=(aged_terminal - 60) * 1_000_000_000, terminalAt=aged_terminal))
    assert edited_leaving(recv.stale_report(case_root, KEY_B, "c8" * 32, EXPIRY_MS))["expiredCommitted"] is True, name
    slot_dir = os.path.join(case_root, STAGING, "d-" + KEY_B[:24], "0")
    if mutate_before_isolate is not None:
        edit_journal(case_root, KEY_B, "0", mutate_before_isolate)
        if reage_manifest:
            # edit_journal rewrote the manifest itself; re-age it so the ONLY evidence still
            # looking expired is the mtime a binding recheck must not fall back to.
            os.utime(os.path.join(slot_dir, "manifest.json"), (time.time() - 172800,) * 2)
    slot_rel = STAGING + "/d-" + KEY_B[:24] + "/0"
    batch = "job-" + hashlib.sha256(("binding-" + name).encode("utf-8")).hexdigest()[:48]
    isolate = engine({"root": case_root, "action": "isolate", "operationId": "binding-" + name,
                      "target": {"relativePath": slot_rel, "type": "directory", "archiveBatch": batch,
                                 "destination": "clean_dir/" + batch + "/" + slot_rel},
                      "stagedJournal": {"identity": KEY_B, "generation": GEN_B1, "status": "committed",
                                        "terminalAt": aged_terminal if binding_terminal == "keep" else binding_terminal,
                                        "expiryMs": EXPIRY_MS}})
    return isolate, slot_dir


def refused_untouched(name, mutate, **kwargs):
    isolate, slot_dir = reclaim_binding_case(name, mutate, **kwargs)
    return (isolate["ok"] is False and isolate["error"]["code"] == "STAGED_JOURNAL_MISMATCH"
            and os.path.exists(slot_dir))


reclaimBindingNonTerminalRefused = refused_untouched("nonterminal", resume_checkpoint)
reclaimBindingGenerationChangedRefused = refused_untouched("regen", lambda row: row.update(generation="f8" * 32))
reclaimBindingFreshCommitRefused = refused_untouched("fresh", lambda row: row.update(terminalAt=int(time.time())))
# --- FINAL REVIEW P1-A races: (1) the bound terminal moment VANISHED after the report — the
# --- recheck must refuse outright, never fall back to updatedAt/mtime; (2) createdAt moved to
# --- AFTER the bound terminalAt — the contradiction rule applies to the terminalAt basis itself,
# --- not only to fallbacks; (3) a legacy-shaped journal with updatedAt PRESENT-but-null and only
# --- an aged manifest mtime left — present-null must not slip to mtime either.
reclaimBindingTerminalRemovedRefused = refused_untouched(
    "termpop", lambda row: (row.pop("terminalAt", None), row.update(updatedAt=int(time.time()) - 172800)))
reclaimBindingCreatedAfterTerminalRefused = refused_untouched(
    "createdafter", lambda row: row.update(createdAt=int(time.time()) * 1_000_000_000))
reclaimBindingLegacyNullUpdateRefused = refused_untouched(
    "nullupdate", lambda row: (row.pop("terminalAt", None), row.update(updatedAt=None)),
    binding_terminal=None, reage_manifest=True)
control_isolate, control_slot_dir = reclaim_binding_case("accepted", None)
reclaimBindingUnchangedAccepted = control_isolate["ok"] is True and not os.path.exists(control_slot_dir)
assert (reclaimBindingNonTerminalRefused and reclaimBindingGenerationChangedRefused
        and reclaimBindingFreshCommitRefused and reclaimBindingUnchangedAccepted
        and reclaimBindingTerminalRemovedRefused and reclaimBindingCreatedAfterTerminalRefused
        and reclaimBindingLegacyNullUpdateRefused), (control_isolate, reclaimBindingTerminalRemovedRefused,
                                                     reclaimBindingCreatedAfterTerminalRefused,
                                                     reclaimBindingLegacyNullUpdateRefused)

print(json.dumps({"ok": True, "pendingBlocked": True, "leaving": leaving, "thirdGenerationLanded": True,
                  "hardlinkPublication": {"tarPublished": True, "pendingAliasPreserved": True,
                                          "chunkPublished": True, "normalTargetPublished": True,
                                          "directoryTargetRejected": True, "symlinkTargetRejected": True},
                  "expiryReclaim": {"terminalAtWritten": terminalAtWritten,
                                    "journalTerminalAtCarried": journalTerminalAtCarried,
                                    "expiredOldGenerationTrue": expiredOldGenerationTrue,
                                    "claimStillPending": claimStillPending,
                                    "structuredPendingFacts": structuredPendingFacts,
                                    "boundaryAtLeastDay": boundaryAtLeastDay,
                                    "boundaryJustBelow": boundaryJustBelow,
                                    "futureProtected": futureProtected,
                                    "contradictionProtected": contradictionProtected,
                                    "mtimeAgedExpired": mtimeAgedExpired,
                                    "mtimeFreshProtected": mtimeFreshProtected,
                                    "sameGenerationNoReclaim": sameGenerationNoReclaim,
                                    "inventoryRolesHeld": inventoryRolesHeld,
                                    "corruptProtected": corruptProtected,
                                    "lockedProtected": lockedProtected,
                                    "malformedTimeProtected": malformedTimeProtected,
                                    "malformedNoOlderFallback": malformedNoOlderFallback,
                                    "mtimeContradictionProtected": mtimeContradictionProtected,
                                    "legacyFallbackStillWorks": legacyFallbackStillWorks,
                                    "reclaimBindingNonTerminalRefused": reclaimBindingNonTerminalRefused,
                                    "reclaimBindingGenerationChangedRefused": reclaimBindingGenerationChangedRefused,
                                    "reclaimBindingFreshCommitRefused": reclaimBindingFreshCommitRefused,
                                    "reclaimBindingTerminalRemovedRefused": reclaimBindingTerminalRemovedRefused,
                                    "reclaimBindingCreatedAfterTerminalRefused": reclaimBindingCreatedAfterTerminalRefused,
                                    "reclaimBindingLegacyNullUpdateRefused": reclaimBindingLegacyNullUpdateRefused,
                                    "reclaimBindingUnchangedAccepted": reclaimBindingUnchangedAccepted,
                                    "slotLockHeldBlocksIsolate": slotLockHeldBlocksIsolate,
                                    "isolateAfterRelease": isolateAfterRelease,
                                    "claimAdmitted": claimAdmitted}}))
