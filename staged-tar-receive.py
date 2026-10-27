"""Stream verified files into identity-owned two-generation slots; publish only after the complete archive validates.

No unlink/rmtree commands and no silent clearing: replace consumes staged files; foreign checkpoints are never
overwritten. Slots live in identity-owned directories under the reserved staging subtree
(simple_cluster/.simple-sftp-staging/d-<identity>/[0|1]); each identity rotates only its own slot, so at most
"current + one previous" generations can exist per logical source. Terminal foreign checkpoints are reported
read-only (staleReport) for the confirmed managed-deletion executor; a full pair refuses a third generation
with TRANSFER_STAGE_PENDING until that confirmed cleanup happens.
"""
import base64
import fcntl
import hashlib
import json
import os
import re
import stat
import sys
import time
import zlib

BLOCK = 512
CHUNK = 65536
MAX_METADATA = 65536
MAX_JOURNAL = 1024 * 1024
LARGE_CHUNK = 8 * 1024 * 1024
MAX_LARGE_FILE = LARGE_CHUNK * 8192
STAGING_CONTAINER = "simple_cluster"
STAGING_DIRECTORY = ".simple-sftp-staging"
# Each logical source (identity) owns one directory with exactly two fixed slots: current and previous.
IDENTITY_TOKEN = re.compile(r"^[0-9a-f]{8,64}$")
IDENTITY_SLOTS = ("0", "1")
TERMINAL_JOURNAL_STATES = ("committed", "failed")
# Manifests and chunk targets may never publish into the staging subtree (current or legacy protocol layout).
RESERVED_STAGING_LEAF = re.compile(r"^\.simple-sftp-(stage-[0-9a-f]{2}|staging)$")

_progress = {}

def report_progress(phase, byte_count=0, file_count=0, force=False):
    row = _progress.setdefault(phase, {"bytes": 0, "files": 0, "at": 0})
    row["bytes"] += byte_count
    row["files"] += file_count
    now = time.monotonic()
    if force or now - row["at"] >= 0.25:
        sys.stderr.write("SIMPLE_PROGRESS " + json.dumps({"phase": phase, "processedBytes": row["bytes"], "processedFiles": row["files"]}) + "\n")
        sys.stderr.flush()
        row["at"] = now

def ordinary(fd):
    value = os.fstat(fd)
    if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
        raise ValueError("unsafe linked staging file")

def open_file(parent_fd, leaf, flags):
    fd = os.open(leaf, flags | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=parent_fd)
    try:
        ordinary(fd)
        return fd
    except BaseException:
        os.close(fd)
        raise

def folder(parent_fd, leaf):
    try:
        os.mkdir(leaf, 0o700, dir_fd=parent_fd)
    except FileExistsError:
        pass
    return os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)

def read_journal(slot_fd):
    try:
        fd = open_file(slot_fd, "manifest.json", os.O_RDONLY)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as handle:
        content = handle.read(MAX_JOURNAL + 1)
    if len(content) > MAX_JOURNAL:
        raise ValueError("staging journal too large")
    return json.loads(content)

def journal(slot_fd, data):
    # updatedAt orders failed-slot reclamation; journal writes are the only mutation point for slot state.
    # terminalAt is the terminal moment: written when a row ENTERS committed and carried verbatim while the
    # same committed row is rewritten; any non-terminal rewrite drops it (a resumed run is not terminal).
    previous = read_journal(slot_fd)
    same_generation = previous and previous.get("identity") == data.get("identity") and journal_generation(previous) == journal_generation(data)
    created_at = previous.get("createdAt", previous.get("updatedAt", 0)) if same_generation else 0
    payload = dict(data)
    if data.get("status") == "committed":
        carried = previous.get("terminalAt") if same_generation and previous.get("status") == "committed" else None
        payload["terminalAt"] = carried if isinstance(carried, int) and not isinstance(carried, bool) and carried > 0 else int(time.time())
    encoded = json.dumps(dict(payload, createdAt=created_at or time.time_ns(), updatedAt=int(time.time())), separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_JOURNAL:
        raise ValueError("staging journal too large")
    fd = open_file(slot_fd, "manifest.writing", os.O_WRONLY | os.O_CREAT)
    with os.fdopen(fd, "wb") as handle:
        handle.truncate(0)
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        existing = os.stat("manifest.json", dir_fd=slot_fd, follow_symlinks=False)
        if not stat.S_ISREG(existing.st_mode) or existing.st_nlink != 1:
            raise ValueError("unsafe journal target")
    except FileNotFoundError:
        pass
    os.replace("manifest.writing", "manifest.json", src_dir_fd=slot_fd, dst_dir_fd=slot_fd)
    os.fsync(slot_fd)

def staging_directory(root_fd):
    # Reserved plugin staging subtree inside the project's machine-state directory; components refuse symlinks.
    container = folder(root_fd, STAGING_CONTAINER)
    try:
        return folder(container, STAGING_DIRECTORY)
    finally:
        os.close(container)

def slot_journal(slot_fd):
    try:
        return read_journal(slot_fd)
    except (ValueError, OSError):
        return "unresolved"

def request_scope(request):
    # logicalKey is a verifiable STABLE source scope (never stage ids, content hashes or node
    # identities); generation is the caller's stable run/command id — retries and extra batches of
    # one run reuse the same generation and therefore the same slot. Legacy requests that only carry
    # `identity` keep working: identity then serves as both the scope key and its own generation.
    logical_key = str(request.get("logicalKey") or request.get("identity") or "")
    generation = str(request.get("generation") or logical_key)
    if not IDENTITY_TOKEN.fullmatch(logical_key) or not IDENTITY_TOKEN.fullmatch(generation):
        raise ValueError("invalid transfer scope")
    return logical_key, generation

def journal_generation(row):
    return str(row.get("generation") or row.get("identity") or "")

def identity_parent(stage_fd, logical_key):
    # One logical source owns one directory holding exactly two slots; components refuse symlink leaves.
    if not IDENTITY_TOKEN.fullmatch(logical_key or ""):
        raise ValueError("invalid transfer scope")
    leaf = "d-" + logical_key[:24]
    return folder(stage_fd, leaf), leaf

def as_int(value):
    # JSON ints only: bools, floats and strings never count as a timestamp (fail toward "no time").
    return value if isinstance(value, int) and not isinstance(value, bool) else None

def created_seconds(row):
    # createdAt is written in ns (time_ns); a plausible pre-ns second value is accepted, anything else is 0.
    created = as_int(row.get("createdAt"))
    if not created or created <= 0:
        return 0
    return created / 1_000_000_000 if created > 1_000_000_000_000 else float(created)

def time_field(row, field):
    # (present, parsed) — rules out the ruled confusion: a LEGACY row simply lacks the field and may
    # fall back; a row that CARRIES the field with an unusable value (string, bool, float, null,
    # non-positive or non-integer) is malformed and must NEVER fall through to older evidence.
    if field not in row:
        return False, None
    value = row[field]
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return True, value
    return True, None

def time_facts(row, slot_fd):
    # Expiry-age basis facts, remote clock only, never mutated here. Preference: terminalAt (new
    # journals), legacy fallback updatedAt, and ONLY when a valid journal carries no usable
    # timestamp at all, the NON-FOLLOWING manifest.json mtime. Slot-directory, lock-file and
    # data-file mtimes are never trusted. PRESENT-but-MALFORMED yields time-format immediately —
    # never an older basis; a future or createdAt-contradictory basis yields its problem
    # (callers never expire), and the manifest-mtime fallback is contradiction-checked too.
    now = time.time()
    created_s = created_seconds(row)
    def basis(source, seconds):
        if seconds > now:
            return {"timeSource": source, "ageMs": None, "expiryProblem": "time-future"}
        if created_s and seconds < created_s - 1:
            return {"timeSource": source, "ageMs": None, "expiryProblem": "time-contradiction"}
        return {"timeSource": source, "ageMs": int((now - seconds) * 1000), "expiryProblem": None}
    malformed = {"timeSource": None, "ageMs": None, "expiryProblem": "time-format"}
    # FINAL REVIEW P1-B: EVERY present field is format-checked BEFORE any age basis is chosen.
    # A legally old terminalAt next to a written-but-unusable updatedAt is still a journal nobody
    # can vouch for — selecting around a malformed field was the bug.
    created_present, created_parsed = time_field(row, "createdAt")
    if created_present and created_parsed is None:
        return malformed
    terminal_present, terminal = time_field(row, "terminalAt")
    if terminal_present and terminal is None:
        return malformed  # a written-but-unusable commit time outranks every older fallback
    updated_present, updated = time_field(row, "updatedAt")
    if updated_present and updated is None:
        return malformed
    if terminal_present:
        return basis("terminalAt", float(terminal))
    if updated_present:
        return basis("updatedAt", float(updated))
    try:
        # Valid journal without any timestamp: only the journal manifest's own non-followed mtime may answer.
        moment = os.stat("manifest.json", dir_fd=slot_fd, follow_symlinks=False).st_mtime
    except OSError:
        return {"timeSource": None, "ageMs": None, "expiryProblem": "mtime-unreadable"}
    if moment > now:
        return {"timeSource": "manifestMtime", "ageMs": None, "expiryProblem": "time-future"}
    if created_s and moment < created_s - 1:
        return {"timeSource": "manifestMtime", "ageMs": None, "expiryProblem": "time-contradiction"}
    return {"timeSource": "manifestMtime", "ageMs": int((now - moment) * 1000), "expiryProblem": None}

def slot_report(did, leaf, journal_row, locked=False):
    # Read-only checkpoint facts used by the confirmed managed-deletion preview and the structured
    # TRANSFER_STAGE_PENDING stage block; nothing is mutated here. Times travel as stored (never derived).
    row = journal_row if isinstance(journal_row, dict) else None
    return {"path": STAGING_CONTAINER + "/" + STAGING_DIRECTORY + "/" + did + "/" + leaf,
            "status": (row or {}).get("status") or "unresolved",
            "identity": (row or {}).get("identity") or "",
            "generation": journal_generation(row or {}),
            "createdAt": as_int((row or {}).get("createdAt")) or 0,
            "terminalAt": as_int((row or {}).get("terminalAt")) or 0,
            "updatedAt": as_int((row or {}).get("updatedAt")) or 0,
            "locked": bool(locked)}

def stale_report(root, logical_key, generation=None, expiry_ms=None):
    # STRICT read-only classification: nothing is created (no staging subtree, no lock files) and
    # nothing is mutated. WITH an incoming generation this is an admission preview: virtual join
    # puts the incoming generation into a free or own-generation slot; only when both slots hold
    # OTHER terminal generations does the oldest one become the leaving candidate for the confirmed
    # double-confirmed managed-deletion executor, while the retained newest generation stays held.
    # WITHOUT a generation this is pure inventory: current and previous generations are inside the
    # retention window and are NEVER proposed for deletion; corrupt or actively locked slots report
    # as held so nothing can be proposed over them.
    # With an integer expiry_ms the leaving row additionally carries the REMOTE-clock expiry verdict
    # (expiredCommitted): only a fully readable, identity-matching, committed, unlocked slot whose
    # trusted terminal basis is at least expiry_ms old can ever say true; every time problem
    # (missing/format/future/contradiction) keeps the slot protected. Verdicts never authorize a
    # deletion by themselves — the confirmed managed executor and its isolation-moment checks stay.
    if os.path.realpath(root) != root or root in ("/", ""):
        raise ValueError("PARENT_CD_FAILED: invalid root")
    if not IDENTITY_TOKEN.fullmatch(logical_key or ""):
        raise ValueError("invalid transfer scope")
    admission = generation is not None
    if admission and not IDENTITY_TOKEN.fullmatch(str(generation)):
        raise ValueError("invalid transfer scope")
    if expiry_ms is not None and (not isinstance(expiry_ms, int) or isinstance(expiry_ms, bool) or expiry_ms < 0):
        expiry_ms = None
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    stage_fd = did_fd = None
    try:
        try:
            container = os.open(STAGING_CONTAINER, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        except FileNotFoundError:
            return {"stale": [], "held": []}
        try:
            try:
                stage_fd = os.open(STAGING_DIRECTORY, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=container)
            except FileNotFoundError:
                return {"stale": [], "held": []}
        finally:
            os.close(container)
        did = "d-" + logical_key[:24]
        try:
            did_fd = os.open(did, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=stage_fd)
        except FileNotFoundError:
            return {"stale": [], "held": []}
        stale, held, all_slots = [], [], []
        occupied, empty_slots, own_generation_seen, busy = [], 0, False, 0
        for leaf in IDENTITY_SLOTS:
            try:
                slot_fd = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=did_fd)
            except FileNotFoundError:
                empty_slots += 1
                continue
            try:
                locked = False
                unreadable = False
                try:
                    # Read-only probe: an absent lock file means no holder; nothing is created here.
                    lock_fd = os.open(leaf + ".lock", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=did_fd)
                    try:
                        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        locked = True
                    finally:
                        os.close(lock_fd)
                except FileNotFoundError:
                    pass
                except OSError:
                    # A lock leaf that cannot even be inspected holds the slot conservatively.
                    unreadable = True
                if locked or unreadable:
                    busy += 1
                    try:
                        base = slot_report(did, leaf, read_journal(slot_fd), locked=locked)
                    except (ValueError, OSError):
                        base = slot_report(did, leaf, None, locked=locked)
                    row = dict(base, status="locked" if locked else "unresolved",
                               protectedReason="slot-locked" if locked else "lock-unreadable")
                    held.append(row)
                    all_slots.append(row)
                    continue
                journal_row = slot_journal(slot_fd)
                facts = time_facts(journal_row, slot_fd) if isinstance(journal_row, dict) else {}
            finally:
                os.close(slot_fd)
            if journal_row == "unresolved":
                row = dict(slot_report(did, leaf, None), status="unresolved", protectedReason="journal-unresolved")
                held.append(row)
                all_slots.append(row)
                continue
            if journal_row is None:
                empty_slots += 1
                continue
            occupied.append((leaf, journal_row, facts))
        terminal_rows = []
        for leaf, journal_row, facts in occupied:
            report = dict(slot_report(did, leaf, journal_row), **facts)
            all_slots.append(report)
            if journal_row.get("identity") != logical_key:
                held.append(dict(report, status="unresolved", protectedReason="identity-mismatch"))
            elif admission and journal_generation(journal_row) == generation:
                own_generation_seen = True
            elif journal_row.get("status") not in TERMINAL_JOURNAL_STATES:
                held.append(dict(report, protectedReason="journal-non-terminal"))
            elif not admission:
                # Inventory: current/previous terminal generations are the retained window —
                # reported as held so callers see the full truth, never as stale.
                held.append(dict(report, protectedReason="within-retention-window"))
            else:
                terminal_rows.append((leaf, journal_row, report))
        # Eviction is proposed ONLY when EVERY slot is one of our own valid terminal generations
        # (a foreign, unresolved, non-terminal or locked slot keeps the whole identity fail-closed)
        # and the virtual join has nowhere free for the incoming generation.
        if admission and len(terminal_rows) == len(IDENTITY_SLOTS) and not (empty_slots or own_generation_seen or busy):
            # Virtual join has nowhere free: with BOTH slots terminal for other generations the
            # OLDEST leaves the window as the single confirmed-deletion candidate, while the newest
            # stays protected. Any busy/protected slot fails closed with no candidate at all.
            terminal_rows.sort(key=lambda row: (int(row[1].get("createdAt") or row[1].get("updatedAt") or 0), row[0]))
            leaving = dict(terminal_rows[0][2], type="directory")
            if expiry_ms is not None:
                # Remote-clock expiry verdict over the trusted basis only. Anything but a committed,
                # timestamp-trusted row older than the threshold says "not expired" — never the reverse.
                basis_age = leaving.get("ageMs")
                is_committed = leaving.get("status") == "committed"
                verdict = bool(is_committed and leaving.get("expiryProblem") is None
                               and isinstance(basis_age, int) and basis_age >= expiry_ms)
                leaving["expiredCommitted"] = verdict
                leaving["expiryReason"] = ("expired" if verdict
                                           else "not-committed" if not is_committed
                                                else str(leaving.get("expiryProblem") or "within-threshold"))
            stale.append(leaving)
            held.extend(dict(row[2], protectedReason="within-retention-window") for row in terminal_rows[1:])
        # Inventory mode (no incoming generation) never proposes retained current/previous copies.
        leaving_paths = {row["path"] for row in stale}
        for row in all_slots:
            row["role"] = "leaving" if row["path"] in leaving_paths else "held"
        return {"stale": stale, "held": held, "slots": all_slots}
    finally:
        for fd in (did_fd, stage_fd, root_fd):
            if fd is not None:
                os.close(fd)

def claim(stage_fd, logical_key, generation):
    # Two-generation admission for ONE logical source: a free slot may be taken, and a slot whose
    # journal already carries THIS generation may be resumed/re-run (retry batches share one
    # generation). Slots held by other generations — terminal or in-flight — are never overwritten:
    # admission fails closed with TRANSFER_STAGE_PENDING until the leaving generation is removed by
    # the confirmed managed-deletion executor. The chosen slot is RE-VALIDATED under its exclusive
    # lock, so a classification raced by a concurrent claim cannot land on a newly occupied slot.
    did_fd, did = identity_parent(stage_fd, logical_key)
    try:
        resume = empty = None
        busy = protected = 0
        for leaf in IDENTITY_SLOTS:
            lock_fd = open_file(did_fd, leaf + ".lock", os.O_RDWR | os.O_CREAT)
            slot_fd = None
            try:
                try:
                    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    # A live holder owns this slot; only its own generation may be resuming there.
                    held = None
                    probe_fd = None
                    try:
                        probe_fd = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=did_fd)
                        held = read_journal(probe_fd)
                    except (ValueError, OSError):
                        held = None
                    finally:
                        if probe_fd is not None:
                            os.close(probe_fd)
                    if held and held.get("identity") == logical_key and journal_generation(held) == generation:
                        raise ValueError("TRANSFER_STAGE_BUSY: checkpoint owner still active")
                    busy += 1
                    continue
                try:
                    # Probe read-only: an absent slot is empty and stays absent until accepted.
                    slot_fd = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=did_fd)
                except FileNotFoundError:
                    if empty is None:
                        empty = leaf
                    continue
                previous = slot_journal(slot_fd)
                if previous == "unresolved":
                    # Corrupt/unreadable checkpoints stay protected until a confirmed managed cleanup.
                    protected += 1
                    continue
                if previous is None:
                    if empty is None:
                        empty = leaf
                    continue
                if previous.get("identity") == logical_key and journal_generation(previous) == generation:
                    # This run's own terminated checkpoint: resume/re-run in place, no new generation.
                    resume = leaf
                else:
                    # Another generation (terminal or in-flight) is retained until confirmed cleanup.
                    protected += 1
            finally:
                if slot_fd is not None:
                    os.close(slot_fd)
                os.close(lock_fd)
        target = resume or empty
        if target is None:
            if busy and not protected:
                raise ValueError("TRANSFER_STAGE_BUSY: staging checkpoint is active")
            raise ValueError("TRANSFER_STAGE_PENDING: this source's two staging slots hold other or unresolved generations awaiting confirmed managed cleanup; a third generation must not land")
        lock_fd = open_file(did_fd, target + ".lock", os.O_RDWR | os.O_CREAT)
        slot_fd = None
        accepted = False
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            slot_fd = folder(did_fd, target)
            previous = slot_journal(slot_fd)
            if previous == "unresolved":
                protected_by = "unresolved"
            elif previous is None or (previous.get("identity") == logical_key and journal_generation(previous) == generation):
                protected_by = None
            else:
                protected_by = "occupied"
            if protected_by is not None:
                raise ValueError("TRANSFER_STAGE_PENDING: staging slot was claimed by another generation while admitting; nothing was overwritten")
            accepted = True
            return slot_fd, lock_fd, did + "/" + target
        finally:
            if not accepted:
                if slot_fd is not None:
                    os.close(slot_fd)
                os.close(lock_fd)
    finally:
        os.close(did_fd)

def emit_pending_stage_facts(root, logical_key, generation):
    # Machine-readable snapshot of WHY admission is blocked, emitted on stderr right before the
    # unchanged TRANSFER_STAGE_PENDING text: slot facts come from the same strict read-only
    # classification, never from parsing error strings. A diagnostic failure never masks the error.
    try:
        report = stale_report(root, logical_key, generation)
        facts = {"schemaVersion": 1, "code": "TRANSFER_STAGE_PENDING", "identity": logical_key,
                 "incomingGeneration": generation, "slots": report["slots"]}
        sys.stderr.write("SIMPLE_STAGE_PENDING " + json.dumps(facts, separators=(",", ":")) + "\n")
        sys.stderr.flush()
    except (OSError, ValueError):
        pass

def exactly(stream, size):
    result = bytearray()
    while len(result) < size:
        data = stream.read(min(CHUNK, size - len(result)))
        if not data:
            raise ValueError("incomplete tar stream")
        result.extend(data)
    return bytes(result)

def receive(root, request, stream):
    if os.path.realpath(root) != root or root in ("/", ""):
        raise ValueError("PARENT_CD_FAILED: invalid root")
    logical_key, generation = request_scope(request)
    entries = request["entries"]
    expected = {}
    for index, item in enumerate(entries):
        name = item["path"]
        if len(name) > 4096 or any(p in ("", ".", "..") or ":" in p or RESERVED_STAGING_LEAF.fullmatch(p) for p in name.split("/")) or any(c in name for c in "\x00\r\n") or name in expected:
            raise ValueError("unsafe manifest path")
        digest = item["sha256"]
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError("missing manifest hash")
        expected[name] = dict(item, index=index)
    if not expected or len(expected) > 5000:
        raise ValueError("invalid manifest count")
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    stage_fd = slot_fd = lock_fd = None
    state = {"identity": logical_key, "generation": generation, "status": "preparing", "entries": entries}
    try:
        stage_fd = staging_directory(root_fd)
        try:
            slot_fd, lock_fd, leaf = claim(stage_fd, logical_key, generation)
        except ValueError as admission_error:
            if str(admission_error).startswith("TRANSFER_STAGE_PENDING"):
                emit_pending_stage_facts(root, logical_key, generation)
            raise
        journal(slot_fd, state)
        seen = set()
        long_name = None
        pax = {}
        while True:
            header = exactly(stream, BLOCK)
            if not any(header):
                if any(exactly(stream, BLOCK)):
                    raise ValueError("bad tar terminator")
                trailing = 0
                while True:
                    data = stream.read(CHUNK)
                    if not data:
                        break
                    trailing += len(data)
                    if any(data) or trailing > 1024 * 1024:
                        raise ValueError("unexpected archive trailer")
                break
            checksum = int(header[148:156].strip(b"\0 ") or b"0", 8)
            if checksum != sum(header[:148]) + 256 + sum(header[156:]):
                raise ValueError("invalid tar checksum")
            size_field = header[124:136]
            size = int.from_bytes(bytes([size_field[0] & 0x7f]) + size_field[1:], "big") if size_field[0] == 0x80 else int(size_field.strip(b"\0 ") or b"0", 8)
            kind = header[156:157]
            if kind in (b"x", b"g", b"L"):
                if size < 0 or size > MAX_METADATA:
                    raise ValueError("tar metadata exceeds limit")
                content = exactly(stream, size)
                exactly(stream, (-size) % BLOCK)
                if kind == b"L":
                    long_name = content.rstrip(b"\0\n").decode("utf-8")
                else:
                    for line in content.decode("utf-8").splitlines():
                        record = line.split(" ", 1)[1]
                        key, value = record.split("=", 1)
                        pax[key] = value
                continue
            name = header[:100].split(b"\0", 1)[0].decode("utf-8")
            # GNU uses this area for sparse metadata; USTAR uses it for path prefixes.
            prefix = header[345:500].split(b"\0", 1)[0].decode("utf-8") if header[257:263] == b"ustar\0" else ""
            name = pax.get("path") or long_name or ((prefix + "/" if prefix else "") + name)
            size = int(pax.get("size", size))
            long_name = None
            pax = {}
            if name.startswith("./"):
                name = name[2:]
            item = expected.get(name)
            if kind not in (b"0", b"\0") or item is None or name in seen or size < 0:
                raise ValueError("unexpected or unsafe tar entry")
            if item.get("size") is not None and int(item["size"]) != size:
                raise ValueError("staged size mismatch")
            if size > int(item.get("size") if item.get("size") is not None else 128 * 1024 * 1024):
                raise ValueError("unknown-size entry exceeds limit")
            fd = open_file(slot_fd, str(item["index"]) + ".part", os.O_WRONLY | os.O_CREAT)
            digest = hashlib.sha256()
            with os.fdopen(fd, "wb") as output:
                output.truncate(0)
                remaining = size
                while remaining:
                    block = exactly(stream, min(CHUNK, remaining))
                    remaining -= len(block)
                    digest.update(block)
                    output.write(block)
                    report_progress("unpacking", len(block))
                output.flush()
                os.fsync(output.fileno())
            exactly(stream, (-size) % BLOCK)
            if digest.hexdigest() != item["sha256"]:
                raise ValueError("staged SHA256 mismatch")
            seen.add(name)
            report_progress("unpacking", file_count=1)
        if seen != set(expected):
            raise ValueError("incomplete archive manifest")
        state["status"] = "publishing"
        report_progress("unpacking", force=True)
        journal(slot_fd, state)
        for name, item in expected.items():
            parent_fd = os.dup(root_fd)
            try:
                parts = name.split("/")
                for part in parts[:-1]:
                    next_fd = folder(parent_fd, part)
                    os.close(parent_fd)
                    parent_fd = next_fd
                try:
                    target = os.stat(parts[-1], dir_fd=parent_fd, follow_symlinks=False)
                    # os.replace below swaps only the directory entry, never writes through the existing inode, so a legal multi-link regular target (scientific pending alias) publishes while its aliases keep their exact inode and bytes.
                    if not stat.S_ISREG(target.st_mode) or target.st_nlink < 1:
                        raise ValueError("unsafe publication target")
                except FileNotFoundError:
                    pass
                os.replace(str(item["index"]) + ".part", parts[-1], src_dir_fd=slot_fd, dst_dir_fd=parent_fd)
                os.fsync(parent_fd)
                report_progress("publishing", file_count=1)
            finally:
                os.close(parent_fd)
        journal(slot_fd, {"identity": logical_key, "generation": generation, "status": "committed", "count": len(expected)})
        report_progress("publishing", force=True)
        sys.stderr.write("SIMPLE_STAGE_COMMITTED " + leaf + "\n")
    except BaseException as exc:
        if slot_fd is not None:
            state.update(status="failed", error=str(exc)[:512])
            journal(slot_fd, state)
        raise
    finally:
        for fd in (slot_fd, lock_fd, stage_fd, root_fd):
            if fd is not None:
                os.close(fd)

def chunk_target(request):
    root, name = request["root"], request["entries"][0]["path"]
    if os.path.realpath(root) != root or root in ("/", "") or any(p in ("", ".", "..") or ":" in p or RESERVED_STAGING_LEAF.fullmatch(p) for p in name.split("/")) or any(c in name for c in "\x00\r\n"):
        raise ValueError("PARENT_CD_FAILED: unsafe chunk target")
    item = request["entries"][0]
    size = int(item["size"])
    if size < 0 or size > MAX_LARGE_FILE or len(item["sha256"]) != 64 or any(c not in "0123456789abcdef" for c in item["sha256"]):
        raise ValueError("invalid large file manifest")
    return root, name, size

def source_chunk(request, output):
    root, name, size = chunk_target(request)
    offset = int(request["offset"])
    length = min(LARGE_CHUNK, size - offset)
    if offset < 0 or offset >= size or offset % LARGE_CHUNK:
        raise ValueError("invalid chunk range")
    parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    descriptor = None
    try:
        for part in name.split("/")[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = next_fd
        descriptor = open_file(parent, name.split("/")[-1], os.O_RDONLY)
        before = os.fstat(descriptor)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if before.st_size != size:
            raise ValueError("source size changed")
        with os.fdopen(descriptor, "rb") as handle:
            descriptor = None
            handle.seek(offset)
            # A single bounded block allows hash-before-write, without a temporary archive.
            data = exactly(handle, length)
            report_progress("packing", len(data))
            if identity(os.fstat(handle.fileno())) != identity(before):
                raise ValueError("source changed while reading chunk")
            header = json.dumps({"offset": offset, "size": length, "sha256": hashlib.sha256(data).hexdigest()}, separators=(",", ":")).encode()
            output.write(header + b"\n")
            output.write(data)
            output.flush()
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent)

def chunk_state(request, stream=None):
    root, name, size = chunk_target(request)
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    stage_fd = slot_fd = lock_fd = None
    try:
        stage_fd = staging_directory(root_fd)
        logical_key, generation = request_scope(request)
        try:
            slot_fd, lock_fd, leaf = claim(stage_fd, logical_key, generation)
        except ValueError as admission_error:
            if str(admission_error).startswith("TRANSFER_STAGE_PENDING"):
                emit_pending_stage_facts(root, logical_key, generation)
            raise
        state = read_journal(slot_fd)
        # A same-generation checkpoint restarts from scratch whenever it is not mid-chunked: committed
        # re-runs, failed retries, and crashed preparing/publishing states all legally reuse the slot.
        if not state or state.get("identity") != logical_key or journal_generation(state) != generation or state.get("status") != "chunked":
            state = {"identity": logical_key, "generation": generation, "status": "chunked", "entries": request["entries"], "blocks": []}
        if state.get("status") != "chunked" or state.get("entries") != request["entries"]:
            raise ValueError("chunk checkpoint ownership mismatch")
        blocks = state["blocks"]
        if not isinstance(blocks, list) or len(blocks) > 8192:
            raise ValueError("chunk checkpoint exceeds limit")
        offset = min(len(blocks) * LARGE_CHUNK, size)
        fd = open_file(slot_fd, "0.part", os.O_RDWR | os.O_CREAT)
        with os.fdopen(fd, "r+b") as handle:
            if stream is None:
                for index, digest in enumerate(blocks):
                    data = exactly(handle, min(LARGE_CHUNK, size - index * LARGE_CHUNK))
                    report_progress("verifying", len(data))
                    if hashlib.sha256(data).hexdigest() != digest:
                        raise ValueError("verified checkpoint block changed")
                if offset == size and blocks:
                    # Publication may have failed after validation. Reprocess only the last block.
                    blocks.pop()
                    offset = len(blocks) * LARGE_CHUNK
                handle.truncate(offset)
                journal(slot_fd, state)
                return {"offset": offset, "chunkBytes": LARGE_CHUNK}
            if int(request["offset"]) != offset or offset >= size:
                raise ValueError("stale or invalid chunk offset")
            journal(slot_fd, state)
            # One receive stream owns the slot and lock until EOF/publication.
            while offset < size:
                raw = stream.readline(513)
                if len(raw) > 512 or not raw.endswith(b"\n"):
                    raise ValueError("invalid chunk header")
                header = json.loads(raw)
                length = min(LARGE_CHUNK, size - offset)
                if header.get("offset") != offset or header.get("size") != length:
                    raise ValueError("chunk range mismatch")
                handle.seek(offset)
                handle.truncate(offset)
                digest = hashlib.sha256()
                remaining = length
                while remaining:
                    data = exactly(stream, min(CHUNK, remaining))
                    remaining -= len(data)
                    digest.update(data)
                    handle.write(data)
                    report_progress("unpacking", len(data))
                if (not request.get("multiple") or offset + length == size) and stream.read(1):
                    raise ValueError("unexpected chunk trailer")
                if digest.hexdigest() != header.get("sha256"):
                    raise ValueError("chunk SHA256 mismatch")
                handle.flush()
                os.fsync(handle.fileno())
                blocks.append(digest.hexdigest())
                journal(slot_fd, state)
                offset += length
                report_progress("unpacking", file_count=int(offset == size), force=True)
                if request.get("multiple"):
                    sys.stderr.write("SIMPLE_CHUNK_VERIFIED " + str(offset) + "\n")
                    sys.stderr.flush()
                elif offset < size:
                    return {"offset": offset, "completed": False}
            handle.seek(0)
            complete = hashlib.sha256()
            for data in iter(lambda: handle.read(CHUNK), b""):
                complete.update(data)
                report_progress("verifying", len(data))
            if complete.hexdigest() != request["entries"][0]["sha256"]:
                # Keep the last good target; this different source cannot be resumed as valid.
                state["blocks"] = []
                journal(slot_fd, state)
                raise ValueError("whole file SHA256 mismatch")
        parent = os.dup(root_fd)
        try:
            for part in name.split("/")[:-1]:
                next_fd = folder(parent, part)
                os.close(parent)
                parent = next_fd
            try:
                target = os.stat(name.split("/")[-1], dir_fd=parent, follow_symlinks=False)
                # Same publication contract as the tar path: os.replace swaps only the directory entry, never writes through the existing inode, so a legal multi-link regular target (scientific pending alias) publishes while its aliases keep their exact inode and bytes.
                if not stat.S_ISREG(target.st_mode) or target.st_nlink < 1:
                    raise ValueError("unsafe publication target")
            except FileNotFoundError:
                pass
            os.replace("0.part", name.split("/")[-1], src_dir_fd=slot_fd, dst_dir_fd=parent)
            os.fsync(parent)
        finally:
            os.close(parent)
        journal(slot_fd, {"identity": logical_key, "generation": generation, "status": "committed", "count": 1})
        report_progress("verifying", file_count=1, force=True)
        return {"offset": offset, "completed": True}
    finally:
        for fd in (slot_fd, lock_fd, stage_fd, root_fd):
            if fd is not None:
                os.close(fd)

if __name__ == "__main__":
    encoded = sys.argv[1]
    if len(encoded) > 65536:
        raise ValueError("staging request too large")
    decoder = zlib.decompressobj(-15)
    data = decoder.decompress(base64.b64decode(encoded), MAX_METADATA + 1)
    if len(data) > MAX_METADATA or not decoder.eof:
        raise ValueError("staging manifest exceeds limit")
    request = json.loads(data)
    if request.get("mode") in ("readChunk", "readChunks"):
        if request["mode"] == "readChunks":
            for offset in range(int(request["offset"]), int(request["entries"][0]["size"]), LARGE_CHUNK):
                source_chunk(dict(request, offset=offset), sys.stdout.buffer)
        else:
            source_chunk(request, sys.stdout.buffer)
    elif request.get("mode") == "receiveChunks":
        print(json.dumps(chunk_state(dict(request, multiple=True), sys.stdin.buffer)))
    elif request.get("mode") in ("chunkStatus", "receiveChunk"):
        print(json.dumps(chunk_state(request, sys.stdin.buffer if request["mode"] == "receiveChunk" else None)))
    elif request.get("mode") == "staleReport":
        # Read-only: with `generation` this is an incoming-admission preview (which slot would have
        # to leave the two-generation window); without it a pure inventory that never proposes the
        # retained current/previous generations for deletion. An optional `expiry` object carrying
        # an integer `ms` adds the remote-clock expiry verdict to the leaving row only.
        expiry = request.get("expiry")
        expiry_ms = expiry.get("ms") if isinstance(expiry, dict) else None
        print(json.dumps(stale_report(request["root"], str(request.get("logicalKey") or request.get("identity") or ""),
                                      str(request["generation"]) if request.get("generation") is not None else None,
                                      expiry_ms)))
    else:
        receive(request["root"], request, sys.stdin.buffer)
