"""Restricted file lifecycle executor. Input/output are bounded UTF-8 JSON.

No discovery by name, shell deletion, overwrite, or implicit cancellation.
Authorization and all-node ordering belong to the cleanup coordinator.
"""
import ctypes
import base64
import hashlib
import json
import os
import re
import socket
import shlex
import stat
import struct
import subprocess
import sys
import time

MAX_CLEANUP_REQUEST_BYTES = 32 * 1024 * 1024
# Chunked frozen manifests keep every wire message and the whole process
# memory bounded: the server streams frozen rows into bounded persisted chunks
# (peak memory is one chunk plus one directory's names, never the row list)
# and never carries a full inventory in JSON. MAX_FROZEN_MANIFEST_ENTRIES is a
# walk-stop guard, not the memory bound. Only registered isolated archives use
# this chain; ordinary confirmed_paths scopes keep the 50000-entry boundary.
CHUNKED_MANIFEST_THRESHOLD = 50000
MAX_FROZEN_MANIFEST_ENTRIES = 2000000
CHUNKED_MANIFEST_ROWS = 10000
RUNTIME_PROGRAM_RE = re.compile(r"runtime-([0-9a-f]{64})\.py")


def manifest_key(operation_id, relative_path, destination):
    return hashlib.sha256(json.dumps({"operationId": operation_id, "relativePath": relative_path, "destination": destination},
                                     sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()


def decode_request(raw):
    if len(raw) > MAX_CLEANUP_REQUEST_BYTES:
        deny("REQUEST_TOO_LARGE")
    request = json.loads(raw.decode("utf-8"))
    inventory = request.get("target", {}).get("inventory")
    if isinstance(inventory, list) and len(inventory) > 50000:
        deny("INVENTORY_LIMIT")
    # v1.10: a read-only observation round carries up to 5000 keyed entries
    # without an inventory; it gets its own bounded budget and is refused
    # before any filesystem work happens.
    if request.get("action") == "batch-observe":
        if len(raw) > 8 * 1048576:
            deny("REQUEST_TOO_LARGE")
        return request
    # Replies already permit a 16 MiB frozen inventory. Large authenticated
    # inventory-bearing lifecycle requests get a separate, still bounded budget.
    if len(raw) > 1048576 and (not isinstance(inventory, list) or request.get("action") not in
            ("managed-start", "managed-observe", "delete", "move", "restore", "isolate", "inspect", "check", "verify", "settle")):
        deny("REQUEST_TOO_LARGE")
    return request


class GuardError(Exception):
    def __init__(self, code, detail="", reason=""):
        self.code = code
        self.blocking_path = detail if os.path.isabs(detail) else ""
        self.reason = reason
        super().__init__(detail or code)


def deny(code, detail="", reason=""):
    raise GuardError(code, detail, reason)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()


def frozen_target_digest(value):
    # Separate from existing inventory/operation hashes; match JSON numbers as doubles.
    def canonical(item):
        if isinstance(item, bool) or item is None:
            return json.dumps(item)
        if isinstance(item, (int, float)):
            number = float(item)
            if number != number or abs(number) == float("inf"):
                deny("CLEANUP_INPUT_CHANGED")
            return "n" + struct.pack(">d", 0.0 if number == 0 else number).hex()
        if isinstance(item, list):
            return "[" + ",".join(canonical(row) for row in item) + "]"
        if isinstance(item, dict):
            return "{" + ",".join(json.dumps(key, ensure_ascii=False) + ":" + canonical(item[key]) for key in sorted(item)) + "}"
        return json.dumps(item, ensure_ascii=False)
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def below(root, value):
    root, value = os.path.normcase(root), os.path.normcase(value)
    return value != root and os.path.commonpath((root, value)) == root


def checked_parent(root, full, code="UNSAFE_PARENT"):
    parent = os.path.dirname(full)
    try:
        valid = below(root, full) and (os.path.normcase(parent) == os.path.normcase(root) or below(root, parent))
    except ValueError:
        valid = False
    if not valid:
        deny(code, full, "目标必须在项目根目录内，直接父目录必须是项目根目录或其子目录")
    return parent


_MOUNT_CACHE = {"at": 0.0, "reads": 0, "value": None}


def mount_points():
    # One bounded read of the mount table per request burst; batched entry
    # checks share it instead of re-reading mountinfo for every path.
    now = time.monotonic()
    if _MOUNT_CACHE["value"] is not None and now - _MOUNT_CACHE["at"] < 1.0:
        return _MOUNT_CACHE["value"]
    if os.path.exists("/proc/self/mountinfo"):
        with open("/proc/self/mountinfo", "r", encoding="utf-8") as stream:
            value = {os.path.abspath(re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), line.split()[4])) for line in stream if len(line.split()) > 4}
    else:
        value = set()
    _MOUNT_CACHE["at"] = now
    _MOUNT_CACHE["value"] = value
    _MOUNT_CACHE["reads"] += 1
    return value


def darwin_handle_guard(root, full, inventory=None, allow_nested_git=False):
    # OS evidence only: reuse the bounded metadata walk and frozen vnode reader.
    # A top-level/fast confirmation is never itself evidence of closed handles.
    if sys.platform != "darwin":
        return []
    if inventory is None and os.path.isdir(full):
        try:
            inventory = contents(root, full, "directory", metadata_only=True,
                                 allow_nested_git=allow_nested_git)["inventory"]
        except GuardError as error:
            if error.code == "INVENTORY_LIMIT":
                deny("HANDLE_CHECK_UNAVAILABLE", "Darwin frozen handle inventory exceeds its bound")
            raise
    return open_handles(full, inventory)


def relative(value):
    if not isinstance(value, str) or not value or len(value) > 4096 or any(c in value for c in "\\\x00\r\n*?[]{}:") or any(ord(c) < 32 for c in value):
        deny("UNSAFE_PATH")
    if value.startswith("/") or any(p in ("", ".", "..") for p in value.split("/")):
        deny("UNSAFE_PATH")
    return value


def root_guard(raw):
    if not os.path.isabs(raw) or ".." in raw.replace("\\", "/").split("/"):
        deny("UNSAFE_ROOT")
    root = os.path.abspath(raw)
    if root == os.path.dirname(root) or os.path.normcase(root) == os.path.normcase(os.path.expanduser("~")):
        deny("UNSAFE_ROOT")
    cursor = root
    while cursor != os.path.dirname(cursor):
        st = os.lstat(cursor)
        if stat.S_ISLNK(st.st_mode) or getattr(st, "st_file_attributes", 0) & 1024:
            deny("LINK_OR_REPARSE_POINT")
        cursor = os.path.dirname(cursor)
    physical = os.path.realpath(root)
    if os.path.normcase(physical) != os.path.normcase(root) or not os.path.isdir(physical):
        deny("ROOT_IDENTITY_CHANGED")
    # Keep canonical physical spelling in receipts. Windows drive/filename case
    # aliases are equivalent only after every ancestor passes link/reparse checks.
    root = physical
    st = os.stat(root)
    return root, {"path": root, "device": str(st.st_dev), "inode": str(st.st_ino), "machine": socket.gethostname(), "user": str(os.getuid()) if hasattr(os, "getuid") else os.environ.get("USERNAME", "")}


def path_guard(root, rel, allow_clean=False, missing=False, nested_git_root=None):
    relative(rel)
    parts = rel.split("/")
    names = [p.lower() for p in parts]
    if ".git" in names:
        # Only internal executors receive this boundary, fixed to the approved
        # whole directory. API target paths can never nominate .git directly.
        allowed = nested_git_root and below(root, nested_git_root) and below(nested_git_root, os.path.join(root, *parts))
        scope_parts = os.path.relpath(nested_git_root, root).replace(os.sep, "/").lower().split("/") if allowed else []
        if not allowed or ".git" in scope_parts or "clean_dir" in scope_parts:
            deny("PROTECTED_PATH", os.path.join(root, *parts), "仓库元数据不可作为独立删除目标")
    if not allow_clean and "clean_dir" in names:
        deny("PROTECTED_PATH", os.path.join(root, *parts), "归档区受保护")
    cursor = root
    device = os.stat(root).st_dev
    mounts = mount_points()
    for part in parts:
        cursor = os.path.join(cursor, part)
        if not os.path.lexists(cursor):
            if missing:
                continue
            deny("MISSING_TARGET", cursor)
        st = os.lstat(cursor)
        if stat.S_ISLNK(st.st_mode) or getattr(st, "st_file_attributes", 0) & 1024:
            deny("LINK_OR_REPARSE_POINT", cursor)
        if st.st_dev != device or os.path.ismount(cursor) or cursor in mounts:
            deny("MOUNT_ESCAPE", cursor)
        if not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
            deny("UNCERTAIN_TYPE", cursor)
    full = os.path.abspath(cursor)
    physical = os.path.realpath(full)
    if not below(root, physical) or os.path.normcase(physical) != os.path.normcase(full):
        deny("PATH_ESCAPE")
    return physical


def contents(root, full, expected_type, metadata_only=False, expected_inventory=(), allow_nested_git=False, entry_limit=50000):
    st = os.lstat(full)
    actual = "directory" if stat.S_ISDIR(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else "unknown"
    if actual != expected_type:
        deny("TYPE_CHANGED")
    rows = []
    mounts = mount_points()
    progress = {"at": 0, "bytes": 0}
    # Unlinking a confirmed name changes the shared inode's ctime, including
    # aliases in another target of this frozen batch. It does not change bytes.
    shared_inodes = {(row.get("device"), row.get("inode")) for row in expected_inventory if row.get("hardlink") is True} if metadata_only else set()
    def report(force=False):
        now = time.monotonic()
        if force or now - progress["at"] >= 1:
            sys.stderr.write("SIMPLE_PROGRESS " + json.dumps({"phase": "verifying" if metadata_only else "hashing", "processedFiles": len(rows), "processedBytes": progress["bytes"]}) + "\n")
            sys.stderr.flush()
            progress["at"] = now
    def visit(value, name):
        info = os.lstat(value)
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 1024:
            deny("LINK_OR_REPARSE_POINT", value)
        if info.st_dev != st.st_dev or (value != full and (os.path.ismount(value) or value in mounts)):
            deny("MOUNT_ESCAPE", value)
        if stat.S_ISDIR(info.st_mode):
            rows.append({"path": name, "type": "directory", "device": str(info.st_dev), "inode": str(info.st_ino),
                         **({"mtime": str(info.st_mtime_ns), "ctime": str(info.st_ctime_ns)} if metadata_only else {})})
            report()
            for leaf in sorted(os.listdir(value)):
                relative(leaf)
                if leaf.lower() == "clean_dir" or leaf.lower() == ".git" and not (allow_nested_git and metadata_only and below(root, full)):
                    deny("PROTECTED_DESCENDANT", os.path.join(value, leaf),
                         "归档区受保护，不能随父目录删除" if leaf.lower() == "clean_dir" else "仓库元数据仅允许随双确认的整个子目录删除")
                visit(os.path.join(value, leaf), name + "/" + leaf if name else leaf)
        elif stat.S_ISREG(info.st_mode):
            shared = info.st_nlink > 1 or (str(info.st_dev), str(info.st_ino)) in shared_inodes
            if info.st_nlink != 1 and not metadata_only:
                deny("SHARED_HARDLINK", value)
            h = None
            if not metadata_only:
                h = hashlib.sha256()
                with open(value, "rb") as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        h.update(block)
                        progress["bytes"] += len(block)
                        report()
            after = os.lstat(value)
            if (info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                deny("CONTENT_CHANGED")
            rows.append({"path": name, "type": "file", "size": info.st_size, "mtime": str(info.st_mtime_ns), "device": str(info.st_dev), "inode": str(info.st_ino),
                         **({"hardlink": True} if metadata_only and shared else {"ctime": str(info.st_ctime_ns)} if metadata_only else {"sha256": h.hexdigest()})})
            report()
        else:
            deny("UNCERTAIN_TYPE", value)
        if len(rows) > entry_limit:
            deny("INVENTORY_LIMIT")
    visit(full, "")
    report(True)
    content = [{k: v for k, v in row.items() if k not in ("mtime", "device", "inode")} for row in rows]
    return {"type": actual, "size": sum(row.get("size", 0) for row in rows), "fingerprint": digest(rows), "contentFingerprint": digest(content), "inventory": rows, "device": str(st.st_dev), "inode": str(st.st_ino),
            **({"fingerprintMode": "metadata"} if metadata_only else {})}


def frozen_rows_stream(root, full, shared_inodes=frozenset(), allow_nested_git=True, entry_limit=MAX_FROZEN_MANIFEST_ENTRIES):
    # Bounded-memory frozen walk for the >50000 chain: it yields exactly the
    # metadata-only rows contents() would materialize, in the same pre-order,
    # but never keeps the row list. Process memory stays O(entries of a single
    # directory + tree depth + one chunk), no matter how large the archive is.
    st = os.lstat(full)
    if not stat.S_ISDIR(st.st_mode):
        deny("TYPE_CHANGED")
    mounts = mount_points()
    progress = {"at": 0, "count": 0}

    def report(force=False):
        now = time.monotonic()
        if force or now - progress["at"] >= 1:
            sys.stderr.write("SIMPLE_PROGRESS " + json.dumps({"phase": "verifying", "processedFiles": progress["count"], "processedBytes": 0}) + "\n")
            sys.stderr.flush()
            progress["at"] = now

    def emit(row):
        progress["count"] += 1
        if progress["count"] > entry_limit:
            deny("INVENTORY_LIMIT")
        report()
        return row

    def visit(value, name):
        info = os.lstat(value)
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 1024:
            deny("LINK_OR_REPARSE_POINT", value)
        if info.st_dev != st.st_dev or (value != full and (os.path.ismount(value) or value in mounts)):
            deny("MOUNT_ESCAPE", value)
        if stat.S_ISDIR(info.st_mode):
            yield emit({"path": name, "type": "directory", "device": str(info.st_dev), "inode": str(info.st_ino),
                        "mtime": str(info.st_mtime_ns), "ctime": str(info.st_ctime_ns)})
            for leaf in sorted(os.listdir(value)):
                relative(leaf)
                if leaf.lower() == "clean_dir" or leaf.lower() == ".git" and not (allow_nested_git and below(root, full)):
                    deny("PROTECTED_DESCENDANT", os.path.join(value, leaf),
                         "归档区受保护，不能随父目录删除" if leaf.lower() == "clean_dir" else "仓库元数据仅允许随双确认的整个子目录删除")
                yield from visit(os.path.join(value, leaf), name + "/" + leaf if name else leaf)
        elif stat.S_ISREG(info.st_mode):
            after = os.lstat(value)
            if (info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                deny("CONTENT_CHANGED")
            shared = info.st_nlink > 1 or (str(info.st_dev), str(info.st_ino)) in shared_inodes
            yield emit({"path": name, "type": "file", "size": info.st_size, "mtime": str(info.st_mtime_ns), "device": str(info.st_dev), "inode": str(info.st_ino),
                        **({"hardlink": True} if shared else {"ctime": str(info.st_ctime_ns)})})
        else:
            deny("UNCERTAIN_TYPE", value)

    yield from visit(full, "")
    report(True)


def stream_frozen_preview(root, full, shared_inodes=frozenset(), entry_limit=MAX_FROZEN_MANIFEST_ENTRIES, collect_limit=None):
    # Single streaming pass: returns (row count, frozen stream digest, rows)
    # where rows are collected only while they still fit the small-path bound;
    # once a larger scope is detected the collected list is released.
    h = hashlib.sha256()
    count = 0
    collected = [] if collect_limit else None
    for row in frozen_rows_stream(root, full, shared_inodes, True, entry_limit):
        count += 1
        h.update(json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n")
        if collected is not None:
            if len(collected) < collect_limit:
                collected.append(row)
            else:
                collected = None
    return count, h.hexdigest(), collected


def open_handles(full, inventory=None):
    if os.name == "nt":
        # Share mode zero rejects existing read/write/delete handles, including directories.
        api = ctypes.WinDLL("kernel32", use_last_error=True)
        api.CreateFileW.restype = ctypes.c_void_p
        api.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
        paths = [full]
        if os.path.isdir(full):
            paths += [os.path.join(base, leaf) for base, dirs, files in os.walk(full) for leaf in dirs + files]
        for value in paths:
            handle = api.CreateFileW(value, 0x80000000, 0, None, 3, 0x02000000, None)
            if handle == ctypes.c_void_p(-1).value:
                deny("OPEN_HANDLE_OR_PERMISSION", value)
            api.CloseHandle.argtypes = [ctypes.c_void_p]
            api.CloseHandle(handle)
        return []
    if sys.platform == "darwin":
        try:
            from mac_cleanup_handles import assert_no_open_handles, HandleProofError
        except Exception:
            deny("HANDLE_CHECK_UNAVAILABLE", "Mac handle adapter could not be loaded")
        try:
            assert_no_open_handles(full, inventory)
        except HandleProofError as error:
            deny(error.code, str(error))
        except Exception:
            deny("HANDLE_CHECK_UNAVAILABLE", "Darwin handle evidence is unavailable")
        return []
    if not os.path.isdir("/proc"):
        deny("HANDLE_CHECK_UNAVAILABLE")
    warnings = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit() or int(pid) == os.getpid():
            continue
        base = "/proc/" + pid
        try:
            if os.stat(base).st_uid != os.getuid():
                continue
            links = [base + "/cwd"] + [base + "/fd/" + leaf for leaf in os.listdir(base + "/fd")]
            for link in links:
                try:
                    value = os.readlink(link)
                    if value == full or (os.path.isabs(value) and below(full, value)):
                        deny("ACTIVE_HANDLE", "pid=" + pid)
                except FileNotFoundError:
                    pass
        except (FileNotFoundError, ProcessLookupError):
            pass
        except PermissionError:
            # /proc ptrace restrictions (e.g. a non-dumpable daemon with our
            # uid) say nothing about this target. Report limited visibility;
            # do not turn one unreadable process into a machine-wide file lock.
            # Continue scanning so a visible target handle still rejects it.
            warnings.append({"code": "PROC_VISIBILITY_LIMIT", "pid": pid})
    return warnings


def tracked_dirty(root, rel):
    cursor = root
    git_marker = os.path.join(cursor, ".git")
    while not os.path.lexists(git_marker) and cursor != os.path.dirname(cursor):
        cursor = os.path.dirname(cursor)
        git_marker = os.path.join(cursor, ".git")
    if not os.path.lexists(git_marker):
        return
    marker = os.lstat(git_marker)
    if stat.S_ISLNK(marker.st_mode) or getattr(marker, "st_file_attributes", 0) & 1024:
        deny("LINK_OR_REPARSE_POINT")
    result = subprocess.run(["git", "-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=no", "--", rel], capture_output=True, timeout=8, env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
    if result.returncode:
        deny("GIT_CHECK_FAILED")
    if result.stdout:
        deny("DIRTY_TRACKED_TARGET")


def formal_cleanup_owner(root, target, owner):
    """Bind a direct formal directory or its exact declared CSV to registered execution identity."""
    required = ("workflowId", "commandId", "globalJobId", "planRevision", "codeFingerprint", "index", "case", "seed", "outputDir", "collectionResultCsv")
    if any(key not in owner or owner[key] is None for key in required):
        deny("FORMAL_JOB_OWNER_REQUIRED")
    if any(type(owner[key]) is not int for key in ("index", "seed")) or owner["index"] < 0:
        deny("FORMAL_JOB_OWNER_INVALID")
    if owner["globalJobId"] != str(owner["workflowId"]) + ":" + str(owner["index"]):
        deny("FORMAL_JOB_OWNER_INVALID")
    if any(not isinstance(owner[key], str) or not owner[key] for key in ("workflowId", "commandId", "case")):
        deny("FORMAL_JOB_OWNER_INVALID")
    if any(not re.fullmatch(r"[a-f0-9]{64}", str(owner[key])) for key in ("planRevision", "codeFingerprint")):
        deny("FORMAL_JOB_OWNER_INVALID")
    output, csv = relative(owner["outputDir"]), relative(owner["collectionResultCsv"])
    if "attempts" in output.split("/") or not (target["type"] == "directory" and target["relativePath"] == output
            or target["type"] == "file" and target["relativePath"] == csv):
        deny("FORMAL_JOB_TARGET_MISMATCH")
    manifest = path_guard(root, output + "/formal_job_owner.json")
    info = os.lstat(manifest)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 65536:
        deny("FORMAL_JOB_OWNER_INVALID")
    with open(manifest, "rb") as stream:
        raw = stream.read(65537)
    if len(raw) > 65536:
        deny("FORMAL_JOB_OWNER_INVALID")
    try:
        record = json.loads(raw.decode("utf-8-sig"))
    except (ValueError, UnicodeError):
        deny("FORMAL_JOB_OWNER_INVALID")
    if (not isinstance(record, dict) or type(record.get("schemaVersion")) is not int or record["schemaVersion"] != 1
            or any(type(record.get(key)) is not int for key in ("index", "seed"))
            or any(record.get(key) != owner[key] for key in required)):
        deny("FORMAL_JOB_OWNER_MISMATCH")
    if record.get("state") not in ("failed", "completed", "training_completed") or owner.get("expectedState") and record.get("state") != owner["expectedState"]:
        deny("FORMAL_JOB_OWNER_NOT_TERMINAL")
    if not re.fullmatch(r"[a-f0-9]{64}", str(record.get("configHash", ""))):
        deny("FORMAL_JOB_CONFIG_UNVERIFIED")
    after = os.lstat(manifest)
    if (info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        deny("CONTENT_CHANGED")
    return hashlib.sha256(raw).hexdigest()


def manifest_records(root, full, value):
    records, hints = [], set()
    if not os.path.isdir(full):
        return records
    # Exact filenames inside the selected target only; never scan unrelated work_dirs.
    for row in value["inventory"]:
        name = row["path"].rsplit("/", 1)[-1]
        if name in ("config.yaml", "config_snapshot.yaml") and row["type"] == "file" and row["size"] <= 1024 * 1024:
            file = path_guard(root, os.path.relpath(os.path.join(full, row["path"]), root).replace(os.sep, "/"), True)
            with open(file, encoding="utf-8") as stream:
                text = stream.read()
            for found in re.finditer(r"(?m)^\s*(?:plan_file|planFile):\s*([^#\r\n]+)", text):
                hint = found.group(1).strip().strip("\"'")
                if hint:
                    hints.add(hint)
    for row in value["inventory"]:
        name = row["path"].rsplit("/", 1)[-1]
        if name not in ("artifact_manifest.json", "formal_job_owner.json", "run_wrapper_report.json", "checkpoint_manifest.json") or row["type"] != "file" or row["size"] > 1024 * 1024:
            continue
        file = path_guard(root, os.path.relpath(os.path.join(full, row["path"]), root).replace(os.sep, "/"), True)
        try:
            with open(file, encoding="utf-8-sig") as stream:
                body = json.load(stream)
            if not isinstance(body, dict):
                continue
            sources = [body.get("simpleExperimentMac", {}), body.get("identity", {}), body.get("job", {}), body]
            binding = {}
            aliases = {"planFile": ("planFile", "plan_file", "plan_path"), "runId": ("runId", "commandId", "run_id", "command_id"),
                       "outputDir": ("outputDir", "output_dir", "job_dir"), "resultCsv": ("resultCsv", "collectionResultCsv", "result_csv", "results_csv"),
                       "index": ("index", "experimentIndex"), "case": ("case",), "seed": ("seed",)}
            for field, names in aliases.items():
                for source in sources:
                    if not isinstance(source, dict):
                        continue
                    if field in ("index", "case", "seed") and isinstance(source.get("job"), dict):
                        source = {**source, **source["job"]}
                    key = next((key for key in names if source.get(key) is not None), None)
                    if key is not None:
                        binding[field] = source[key]
                        break
            records.append({"relativePath": os.path.relpath(file, root).replace(os.sep, "/"), "sha256": row["sha256"],
                            "binding": binding, "planHints": sorted(hints)})
        except (ValueError, UnicodeError):
            continue
    return records


def inspect(root, target, archived=False):
    path_only = target.get("authorizationMode") == "confirmed_paths"
    if path_only:
        target = {key: value for key, value in target.items() if key not in ("expectedOwner", "expectedSha256")}
    rel = relative(target["relativePath"])
    full = path_guard(root, rel, archived)
    checked_parent(root, full)
    if archived and (not rel.startswith("clean_dir/") or rel == "clean_dir/MANIFEST.md" or rel.startswith("clean_dir/.operations/")):
        deny("PROTECTED_PATH")
    if not path_only:
        tracked_dirty(root, rel)
    value = contents(root, full, target["type"], metadata_only=path_only, expected_inventory=target.get("inventory") or (),
                     allow_nested_git=path_only and target["type"] == "directory")
    if target.get("expectedSha256") and (target["type"] != "file" or value["inventory"][0].get("sha256") != target["expectedSha256"]):
        deny("OWNERSHIP_HASH_MISMATCH")
    owner = target.get("expectedOwner")
    formal = isinstance(owner, dict) and owner.get("resultPathPolicy") == "declared"
    if formal:
        owner_hash = formal_cleanup_owner(root, target, owner)
        value["formalOwnerSha256"] = owner_hash
        value["fingerprint"] = digest({"target": value["fingerprint"], "formalOwnerSha256": owner_hash})
    references = []
    if owner and target["type"] == "directory":
        aliases = {"workflowId": ("workflowId", "workflow_id", "planWorkflowId"), "commandId": ("commandId", "command_id"),
                   "workerId": ("workerId", "worker_id"), "attempt": ("attempt",), "case": ("case", "case_name"), "seed": ("seed",)}
        if formal:
            aliases.pop("attempt")
            aliases.update({key: (key,) for key in ("globalJobId", "planRevision", "codeFingerprint", "index")})
        for name in ("artifact_manifest.json", "run_wrapper_report.json", "checkpoint_manifest.json"):
            manifest = os.path.join(full, name)
            if not os.path.isfile(manifest):
                continue
            if os.path.getsize(manifest) > 4 * 1024 * 1024:
                deny("MANIFEST_LIMIT")
            with open(manifest, "r", encoding="utf-8-sig") as stream:
                body = json.load(stream)
            def refs(record, depth=0):
                if depth > 8 or not isinstance(record, (dict, list)):
                    return
                if isinstance(record, list):
                    for child in record:
                        refs(child, depth + 1)
                    return
                for field, child in record.items():
                    if field in ("code_backup_ref", "code_backup_path", "checkpoint_path", "config_path") and isinstance(child, str):
                        raw = child
                        if os.path.isabs(raw):
                            if not below(root, os.path.abspath(raw)):
                                continue
                            raw = os.path.relpath(raw, root).replace(os.sep, "/")
                        try:
                            relative(raw)
                            ref_path = path_guard(root, raw)
                            ref_stat = os.lstat(ref_path)
                            ref_type = "directory" if stat.S_ISDIR(ref_stat.st_mode) else "file"
                            manifest_hash = next(row["sha256"] for row in value["inventory"] if row["path"] == name)
                            references.append({"path": raw, "type": ref_type, "field": field, "manifest": name, "manifestSha256": manifest_hash})
                        except (GuardError, OSError):
                            pass
                    refs(child, depth + 1)
            refs(body)
            for record in (body, body.get("job", {}), body.get("identity", {})):
                if not isinstance(record, dict):
                    deny("OWNERSHIP_UNVERIFIED")
                for field, keys in aliases.items():
                    for key in keys:
                        if key in record and str(record[key]) != str(owner[field]):
                            deny("OWNERSHIP_MISMATCH", name + ":" + key)
                for key in ("outputDir", "output_dir", "job_dir"):
                    if key in record:
                        recorded = str(record[key]).replace("\\", "/").rstrip("/")
                        expected = owner["outputDir"].replace("\\", "/").rstrip("/")
                        if recorded not in (expected, full.replace(os.sep, "/")):
                            deny("OWNERSHIP_MISMATCH", name + ":" + key)
    if path_only:
        handle_warnings = darwin_handle_guard(root, full, value["inventory"], True)
    elif target.get("activityEvidenceMode") == "managed_tmux":
        managed_active(root, target, full, value)
        handle_warnings = []
    else:
        handle_warnings = open_handles(full, value["inventory"])
    destination = path_guard(root, target["destination"], True, True)
    if not path_only and os.path.lexists(destination):
        deny("DESTINATION_EXISTS")
    return {**value, "references": references, "manifests": [] if path_only else manifest_records(root, full, value), "handleWarnings": handle_warnings, "absolutePath": full, "parent": os.path.dirname(full), "leaf": os.path.basename(full), "destination": destination}


def parent_cd(root, full):
    parent = checked_parent(root, full, "PARENT_CD_FAILED")
    try:
        os.chdir(parent)
        if os.path.realpath(os.getcwd()) != parent:
            deny("PARENT_CD_FAILED", parent, "当前物理目录与目标直接父目录不一致")
    except OSError:
        deny("PARENT_CD_FAILED", parent, "无法进入或核验目标直接父目录")
    return "./" + os.path.basename(full)


def no_replace(source, destination):
    if os.name == "nt":
        api = ctypes.WinDLL("kernel32", use_last_error=True)
        api.MoveFileExW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32]
        if not api.MoveFileExW(source, destination, 0):
            deny("MOVE_FAILED", str(ctypes.get_last_error()))
    else:
        api = ctypes.CDLL(None, use_errno=True)
        if hasattr(api, "renameat2"):
            ok = api.renameat2(-100, os.fsencode(source), -100, os.fsencode(destination), 1)
        elif hasattr(api, "renamex_np"):
            ok = api.renamex_np(os.fsencode(source), os.fsencode(destination), 4)
        else:
            deny("NO_REPLACE_UNAVAILABLE")
        if ok != 0:
            deny("MOVE_FAILED", str(ctypes.get_errno()))


_progress_state = {"at": 0.0, "files": 0}


def progress_heartbeat():
    # A long deletion keeps the live progress moving without the old per-file
    # stderr flood: at most one bounded line per second.
    now = time.monotonic()
    if now - _progress_state["at"] >= 1:
        sys.stderr.write("SIMPLE_PROGRESS " + json.dumps({"phase": "deleting", "processedFiles": _progress_state["files"]}) + "\n")
        sys.stderr.flush()
        _progress_state["at"] = now


def delete_file(root, full, expected, metadata_only=False, nested_git_root=None, allow_clean=False):
    if expected.get("type") != "file":
        deny("UNCERTAIN_TYPE")
    path_guard(root, os.path.relpath(full, root).replace(os.sep, "/"), allow_clean, nested_git_root=nested_git_root if metadata_only else None)
    if not metadata_only:
        # A hash-bound confirmation re-verifies the bytes before entering the
        # parent; the post-chdir check below still re-checks every frozen field.
        actual = contents(root, full, "file", expected_inventory=[expected])["inventory"][0]
        if any(actual.get(key) != expected.get(key) for key in ("device", "inode", "size", "mtime", "sha256")):
            deny("CONTENT_CHANGED")
    # A metadata-only confirmation binds the exact frozen identity row: the
    # post-chdir lstat below compares inode/device/size/mtime/ctime (with the
    # frozen hardlink ctime exemption) against that row, and path_guard above
    # already refused links, reparse points, mounts and protected names on
    # every component of this path, so a second pre-lstat pass added no check.
    child = parent_cd(root, full)
    info = os.lstat(child)
    if not stat.S_ISREG(info.st_mode) or str(info.st_ino) != expected["inode"] or str(info.st_dev) != expected["device"]:
        deny("TYPE_CHANGED")
    if info.st_size != expected["size"] or str(info.st_mtime_ns) != expected["mtime"] or metadata_only and not expected.get("hardlink") and str(info.st_ctime_ns) != expected["ctime"]:
        deny("CONTENT_CHANGED")
    os.unlink(child)
    _progress_state["files"] += 1
    progress_heartbeat()


def build_inventory_index(inventory):
    # One pass over the frozen manifest replaces the per-directory rescan that
    # used to cost O(directories x manifest length) on every recursive level.
    rows = {}
    children = {}
    for row in inventory:
        rows[row["path"]] = row
        parent = row["path"].rsplit("/", 1)[0] if "/" in row["path"] else ""
        children.setdefault(parent, []).append(row)
    return rows, children


def delete_directory(root, full, inventory, base="", metadata_only=False, nested_git_root=None, allow_clean=False, index=None):
    # Execute the immutable inventory. New children and runtime type changes never expand it.
    rows, children_by_parent = index if index is not None else build_inventory_index(inventory)
    expected = rows.get(base)
    if not expected or expected["type"] != "directory":
        deny("UNCERTAIN_TYPE")
    path_guard(root, os.path.relpath(full, root).replace(os.sep, "/"), allow_clean, nested_git_root=nested_git_root if metadata_only else None)
    children = [row for row in children_by_parent.get(base, ()) if row["path"] != base]
    leaves = sorted(row["path"].split("/")[-1] for row in children)
    if sorted(os.listdir(full)) != leaves:
        deny("DIRECTORY_INVENTORY_CHANGED")
    for row in sorted(children, key=lambda child: child["path"]):
        leaf = row["path"].split("/")[-1]
        value = os.path.join(full, leaf)
        st = os.lstat(value)
        if str(st.st_ino) != row["inode"] or str(st.st_dev) != row["device"]:
            deny("IDENTITY_CHANGED")
        if row["type"] == "file" and stat.S_ISREG(st.st_mode):
            delete_file(root, value, row, metadata_only=metadata_only, nested_git_root=nested_git_root, allow_clean=allow_clean)
        elif row["type"] == "directory" and stat.S_ISDIR(st.st_mode):
            delete_directory(root, value, inventory, row["path"], metadata_only=metadata_only, nested_git_root=nested_git_root, allow_clean=allow_clean, index=index)
        else:
            deny("TYPE_CHANGED")
    child = parent_cd(root, full)
    info = os.lstat(child)
    if not stat.S_ISDIR(info.st_mode) or str(info.st_ino) != expected["inode"] or str(info.st_dev) != expected["device"]:
        deny("TYPE_CHANGED")
    os.rmdir(child)


def chunked_manifest_dir(root, key):
    return path_guard(root, "clean_dir/.operations/frozen/" + key, True)


def chunked_manifest_write(root, key, name, data):
    # The frozen manifest area is created only for a >50000 confirmation; the
    # first materialization builds the exact bounded directory before its
    # strict re-check, so a vanished parent can never write elsewhere.
    directory = path_guard(root, "clean_dir/.operations/frozen/" + key, True, True)
    os.makedirs(directory, exist_ok=True)
    directory = chunked_manifest_dir(root, key)
    full = path_guard(root, "clean_dir/.operations/frozen/" + key + "/" + name, True, True)
    if os.path.lexists(full):
        with open(full, "rb") as stream:
            if stream.read() != data:
                deny("CLEANUP_INPUT_CHANGED", full)
        return
    with open(full, "xb") as stream:
        stream.write(data)


def chunked_manifest_read(root, key, name, limit=262144):
    full = path_guard(root, "clean_dir/.operations/frozen/" + key + "/" + name, True, True)
    if not os.path.isfile(full) or os.lstat(full).st_nlink != 1 or os.lstat(full).st_size > limit:
        return None
    with open(full, "rb") as stream:
        try:
            return json.loads(stream.read().decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            deny("CLEANUP_INPUT_CHANGED", full)


def chunked_apply_rows(root, full, rows, run_fresh):
    # Reversed pre-order application: the frozen stream recorded every directory
    # strictly before its children, so applying rows in reverse (and chunks from
    # last to first) guarantees children disappear before their parent without
    # ever materializing a global sort. A recreated name or any new file fails
    # the identity or empty-parent check: it is refused, never absorbed, never
    # deleted, and the watermark only advances after a whole chunk succeeded.
    for row in reversed(rows):
        probe = os.path.join(full, *row["path"].split("/")) if row["path"] else full
        if not os.path.lexists(probe):
            if run_fresh:
                deny("DIRECTORY_INVENTORY_CHANGED", probe)
            continue
        if row["type"] == "file":
            delete_file(root, probe, row, metadata_only=True, nested_git_root=full, allow_clean=True)
            continue
        if row["type"] != "directory":
            deny("UNCERTAIN_TYPE", probe)
        st = os.lstat(probe)
        if str(st.st_ino) != row["inode"] or str(st.st_dev) != row["device"]:
            deny("IDENTITY_CHANGED", probe)
        child = parent_cd(root, probe)
        if os.listdir(child):
            deny("DIRECTORY_INVENTORY_CHANGED", probe, "冻结范围内出现新内容，未确认的新文件不会被删除")
        os.rmdir(child)


def chunked_read_chunk(root, key, index, expected_digest):
    full = path_guard(root, "clean_dir/.operations/frozen/%s/chunk-%06d.json" % (key, index), True, True)
    if not os.path.isfile(full) or os.lstat(full).st_nlink != 1 or os.lstat(full).st_size > 8 * 1024 * 1024:
        deny("CLEANUP_INPUT_CHANGED", full)
    with open(full, "rb") as stream:
        blob = stream.read()
    if expected_digest is not None and hashlib.sha256(blob).hexdigest() != expected_digest:
        deny("CLEANUP_INPUT_CHANGED", full, "冻结块内容被篡改，请重新预览并双确认")
    try:
        rows = json.loads(blob.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        deny("CLEANUP_INPUT_CHANGED", full)
    if not isinstance(rows, list):
        deny("CLEANUP_INPUT_CHANGED", full)
    return rows


def chunked_manifest_trim(root, key, summary, total_chunks):
    # P0 metadata trim: only files this operation provably produced are ever
    # removed, and the set is taken from the bound summary, never from scanning
    # the directory. The exact bound set is summary.json plus the hash-bound
    # chunk files enumerated by summary["chunkDigests"]. Each removal rechecks
    # the canonical guarded path, regular type, single link and the bound
    # digest/identity before entering the parent, then re-verifies the same
    # inode/device/size/mtime after the production parent_cd guard really
    # entered the direct parent (physical-cwd recheck), and only "./<leaf>"
    # reaches unlink/rmdir. Unknown, injected, changed, oversized or linked
    # entries are retained and reported; every skip or error is surfaced. The
    # completed artifact-subtree deletion never fails because of this optional
    # trim, and a directory that was not fully trimmed is never claimed as
    # trimmed.
    report = {"status": "retained", "removed": [], "retained": [], "errors": [],
              "directoryRemoved": False, "unknownNames": []}
    try:
        directory = chunked_manifest_dir(root, key)
    except (GuardError, OSError) as error:
        report["errors"].append("manifest-dir:" + str(getattr(error, "code", type(error).__name__)))
        return report
    bound = {"summary.json": ("summary", None)}
    digests = summary.get("chunkDigests") if isinstance(summary.get("chunkDigests"), list) else []
    for index in range(total_chunks):
        bound["chunk-%06d.json" % index] = ("chunk", digests[index] if index < len(digests) else None)
    try:
        directory_stat = os.lstat(directory)
    except OSError as error:
        report["errors"].append("directory-lstat:" + type(error).__name__)
        return report
    for name in sorted(bound):
        kind, expected_digest = bound[name]
        try:
            full = path_guard(root, "clean_dir/.operations/frozen/%s/%s" % (key, name), True, True)
            if not os.path.lexists(full):
                report["retained"].append({"name": name, "reason": "missing"})
                continue
            st = os.lstat(full)
            if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
                report["retained"].append({"name": name, "reason": "type"})
                continue
            if st.st_nlink != 1 or st.st_size > (262144 if kind == "summary" else 8 * 1024 * 1024):
                report["retained"].append({"name": name, "reason": "links-or-size"})
                continue
            with open(full, "rb") as stream:
                blob = stream.read()
            if kind == "chunk":
                if expected_digest is None or hashlib.sha256(blob).hexdigest() != expected_digest:
                    report["retained"].append({"name": name, "reason": "digest"})
                    continue
            else:
                try:
                    shown = json.loads(blob.decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    report["retained"].append({"name": name, "reason": "summary-parse"})
                    continue
                if (not isinstance(shown, dict) or shown.get("schemaVersion") != 1
                        or shown.get("fingerprint") != summary["fingerprint"] or shown.get("count") != summary["count"]):
                    report["retained"].append({"name": name, "reason": "summary-identity"})
                    continue
            child = parent_cd(root, full)
            after = os.lstat(child)
            if (not stat.S_ISREG(after.st_mode) or after.st_ino != st.st_ino or after.st_dev != st.st_dev
                    or after.st_size != st.st_size or after.st_mtime_ns != st.st_mtime_ns):
                report["retained"].append({"name": name, "reason": "identity-after-cd"})
                continue
            os.unlink(child)
            report["removed"].append(name)
        except (GuardError, OSError) as error:
            report["errors"].append("%s:%s" % (name, getattr(error, "code", type(error).__name__)))
    try:
        entries = sorted(os.listdir(directory))
    except OSError as error:
        report["errors"].append("listing:" + type(error).__name__)
        return report
    report["unknownNames"] = [name for name in entries if name not in bound]
    if not entries:
        try:
            child = parent_cd(root, directory)
            after = os.lstat(child)
            if not stat.S_ISDIR(after.st_mode) or after.st_ino != directory_stat.st_ino or after.st_dev != directory_stat.st_dev:
                report["errors"].append("directory:IDENTITY_AFTER_CD")
            else:
                os.rmdir(child)
                report["directoryRemoved"] = True
        except (GuardError, OSError) as error:
            report["errors"].append("directory:" + str(getattr(error, "code", type(error).__name__)))
    report["status"] = ("trimmed" if not entries and report["directoryRemoved"]
                        and not report["retained"] and not report["errors"] else "retained")
    return report


def chunked_permanent_delete(root, request, identity):
    # The only >50000-entry deletion chain (registered isolated archives with a
    # confirmed exact path; ordinary confirmed_paths scopes keep the existing
    # 50000-entry boundary and are NOT advertised as chunked). Every pass is
    # streaming: two bounded walks (the same metadata-only verification
    # strength as the confirmed-path small path) re-derive the frozen digest,
    # then persist hash-bound chunks plus the applied watermark before the
    # first unlink. Process memory never holds the whole row list. Only a
    # minimal anti-replay identity survives completion, never the file list.
    target = request["target"]
    if target.get("authorizationMode") != "confirmed_paths" or target.get("type") != "directory" or target.get("chunked") is not True:
        deny("INVALID_REQUEST")
    archived_rel = archived_control_rel(target)
    if archived_rel is None:
        deny("NOT_REGISTERED_ISOLATION")
    archived_state = isolation_state(root, archived_rel)
    if archived_state and archived_state.get("state") == "deleted":
        return {"ok": True, "rootIdentity": identity, "alreadyDeleted": True, "state": "completed", "verifiedBy": "isolation_deleted"}
    if not archived_state or archived_state.get("state") != "isolated":
        deny("NOT_REGISTERED_ISOLATION", archived_rel, "只有已登记的隔离产物子树可以经确认路径永久删除")
    if target["destination"] != archived_rel:
        deny("UNSAFE_DESTINATION")
    full = path_guard(root, archived_rel, True)
    checked_parent(root, full)
    darwin_handle_guard(root, full, allow_nested_git=True)
    key = manifest_key(request["operationId"], archived_rel, target["destination"])
    summary = chunked_manifest_read(root, key, "summary.json")
    applied = summary.get("applied", 0) if isinstance(summary, dict) else 0
    if summary is not None and (summary.get("schemaVersion") != 1 or not isinstance(summary.get("fingerprint"), str)
            or not isinstance(summary.get("count"), int)
            or summary.get("fingerprint") != target["fingerprint"] or not isinstance(applied, int) or not 0 <= applied <= summary["count"]):
        deny("CLEANUP_INPUT_CHANGED")
    if summary is None:
        # Pass 1 verifies the confirmed frozen digest with O(1) state; pass 2
        # re-walks while writing hash-bound chunks. No unlink happens in either
        # pass, so a scope that changed between confirmations is refused whole,
        # exactly like the previous whole-tree pre-check barrier.
        count1, digest1, _ = stream_frozen_preview(root, full, frozenset(), MAX_FROZEN_MANIFEST_ENTRIES, None)
        if count1 < CHUNKED_MANIFEST_THRESHOLD or digest1 != target["fingerprint"]:
            deny("CONTENT_CHANGED", full, "冻结清单与当前目标不一致，请重新预览并双确认")
        h = hashlib.sha256()
        count = 0
        buffer = []
        chunk_digests = []
        for row in frozen_rows_stream(root, full):
            count += 1
            h.update(json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n")
            buffer.append(row)
            if len(buffer) == CHUNKED_MANIFEST_ROWS:
                data = json.dumps(buffer, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
                chunked_manifest_write(root, key, "chunk-%06d.json" % len(chunk_digests), data)
                chunk_digests.append(hashlib.sha256(data).hexdigest())
                buffer = []
        if buffer:
            data = json.dumps(buffer, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
            chunked_manifest_write(root, key, "chunk-%06d.json" % len(chunk_digests), data)
            chunk_digests.append(hashlib.sha256(data).hexdigest())
        if count != count1 or h.hexdigest() != target["fingerprint"]:
            deny("CONTENT_CHANGED", full, "冻结清单与当前目标不一致，请重新预览并双确认")
        summary = {"schemaVersion": 1, "fingerprint": target["fingerprint"], "count": count, "applied": 0,
                   "chunkDigests": chunk_digests}
        write_control_json(root, "clean_dir/.operations/frozen/%s/summary.json" % key, summary)
    total = summary["count"]
    total_chunks = (total + CHUNKED_MANIFEST_ROWS - 1) // CHUNKED_MANIFEST_ROWS
    chunk_digests = summary.get("chunkDigests")
    if chunk_digests is not None and (not isinstance(chunk_digests, list) or len(chunk_digests) != total_chunks
            or any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value) for value in chunk_digests)):
        deny("CLEANUP_INPUT_CHANGED")
    run_fresh = applied == 0
    done = applied
    while done < total_chunks:
        # Watermark-driven apply loop: exactly one bounded chunk is in memory at
        # a time, applied from the newest frozen chunk backwards; the watermark
        # is persisted only after a whole chunk succeeded.
        index = total_chunks - 1 - done
        rows = chunked_read_chunk(root, key, index, chunk_digests[index] if chunk_digests is not None else None)
        chunked_apply_rows(root, full, rows, run_fresh)
        done += 1
        write_control_json(root, "clean_dir/.operations/frozen/%s/summary.json" % key,
                           {**summary, "applied": done})
        progress_heartbeat()
    if os.path.lexists(full):
        deny("SOURCE_STILL_EXISTS", full)
    write_control_json(root, isolation_control_rel(archived_rel), {"schemaVersion": 1, "state": "deleted",
                                                                    "operationId": request["operationId"], "destination": archived_rel, "deletedAt": time.time()})
    trim = chunked_manifest_trim(root, key, summary, total_chunks)
    result = {"ok": True, "rootIdentity": identity, "receipt": {"operationId": request["operationId"], "action": "delete", "phase": "completed",
            "chunked": True, "count": summary["count"], "fingerprint": summary["fingerprint"], "destination": target["destination"]}}
    if trim["status"] != "trimmed":
        # The artifact-subtree deletion fact stands on its own; an incomplete
        # optional trim is a separate honestly-reported fact, never hidden and
        # never turned into a second deletion pass.
        result["manifestTrim"] = trim
    return result


def audit(root, row):
    # A MANIFEST append is a short control transaction; it must never be the
    # reason a background deletion holds the root lock for a long traversal.
    deadline = time.monotonic() + 10
    while True:
        try:
            control = mutation_lock(root)
            break
        except GuardError as error:
            if error.code != "OPERATION_BUSY" or time.monotonic() >= deadline:
                raise
            time.sleep(0.05)
    try:
        manifest = path_guard(root, "clean_dir/MANIFEST.md", True, True)
        if os.path.lexists(manifest) and os.lstat(manifest).st_nlink != 1:
            deny("SHARED_HARDLINK")
        os.makedirs(os.path.join(root, "clean_dir"), exist_ok=True)
        with open(os.path.join(root, "clean_dir", "MANIFEST.md"), "a", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        control.close()


def mutation_lock(root):
    lock_path = path_guard(root, "clean_dir/.operations/cleanup.lock", True, True)
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    path_guard(root, "clean_dir/.operations/cleanup.lock", True, True)
    stream = open(lock_path, "a+b")
    try:
        if os.name == "nt":
            import msvcrt
            stream.seek(0)
            if not stream.read(1):
                stream.write(b"0"); stream.flush()
            stream.seek(0); msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        stream.close(); deny("OPERATION_BUSY")
    return stream


# --- Controlled fast isolation, registered archive deletion, and per-subtree
# single-writer locks (paired plan C1-C4). The root mutation lock is reserved
# for short control transactions (window admission, MANIFEST append). Long
# traversals hold only the exact isolation subtree chain. ---
ARCHIVED_BATCH_RE = re.compile(r"^clean_dir/(job-[a-f0-9]{48})/(.+)$")

# Staging two-generation slot layout owned by the pinned receiver (identity dir
# d-<hex>, fixed slots 0/1, sibling <slot>.lock held non-blockingly by claim).
STAGED_SLOT_REL_RE = re.compile(r"^simple_cluster/\.simple-sftp-staging/d-[0-9a-f]{8,64}/([01])$")


def staged_slot_lock(root, target):
    """Isolation-moment verification of one staged slot's lock.

    A receiver claim holds <slot>.lock (flock LOCK_EX|LOCK_NB) across admission and
    streaming, so a lock check done only at earlier preview time cannot prove the slot
    is unheld AT the rename. An ABSENT lock file means no holder (claim creates the file
    before locking and never removes it); a lock that is held, unopenable or whose
    check capability is missing refuses the isolation — fail closed, never a weaker path.
    The returned handle must stay open across the rename and is closed by the caller.
    """
    rel = str(target.get("relativePath") or "")
    if not STAGED_SLOT_REL_RE.match(rel):
        return None
    parent_rel, leaf = rel.rsplit("/", 1)
    leaf += ".lock"
    parent_full = path_guard(root, parent_rel)
    if os.name == "nt":
        try:
            stream = open(os.path.join(parent_full, leaf), "r+b")
        except FileNotFoundError:
            return None
        except OSError:
            deny("SLOT_LOCK_UNCERTAIN", os.path.join(parent_full, leaf), "槽锁文件无法打开，拒绝隔离")
        try:
            import msvcrt
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            stream.close()
            deny("SLOT_LOCK_HELD", os.path.join(parent_full, leaf), "槽锁被持有，拒绝隔离")
        return stream
    try:
        parent_fd = os.open(parent_full, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        deny("SLOT_LOCK_UNCERTAIN", parent_full, "无法钉住槽锁所在目录，拒绝隔离")
    # Same-source capability probe: the symbols checked here are EXACTLY the ones called below
    # (fcntl.flock / fcntl.LOCK_EX / fcntl.LOCK_NB). Probing os.flock instead once misjudged the
    # real WSL 3.12 interpreter — where os.flock is absent but fcntl.flock is the working,
    # receiver-side lock — as "no verification capability" and failed every released isolate
    # closed forever. A missing probe symbol still refuses: fail closed, never a weaker path.
    try:
        import fcntl
    except ImportError:
        fcntl = None
    if not getattr(os, "O_NOFOLLOW", 0) or not hasattr(os, "O_DIRECTORY") \
            or fcntl is None or not hasattr(fcntl, "flock") or not hasattr(fcntl, "LOCK_EX") or not hasattr(fcntl, "LOCK_NB"):
        try:
            os.close(parent_fd)
        finally:
            deny("SLOT_LOCK_UNCERTAIN", parent_full, "运行环境缺少槽锁核验能力，拒绝隔离")
    try:
        try:
            fd = os.open(leaf, os.O_RDWR | os.O_NOFOLLOW, dir_fd=parent_fd)
        except FileNotFoundError:
            return None
        except OSError:
            deny("SLOT_LOCK_UNCERTAIN", leaf, "槽锁文件无法打开，拒绝隔离")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            deny("SLOT_LOCK_HELD", leaf, "槽锁被持有，拒绝隔离")
        return fd
    finally:
        os.close(parent_fd)


def release_staged_slot_lock(handle):
    if handle is None:
        return
    try:
        handle.close() if not isinstance(handle, int) else os.close(handle)
    except OSError:
        pass


def verify_staged_journal_binding(root, target, binding):
    """P1-3 ruling: re-prove the expiry-reclaim eligibility against the CURRENT journal WHILE the
    slot lock is held. A free lock only proves no receiver is streaming — it does NOT prove the
    journal is still the committed, expired row the reclaim was authorized against; the same
    generation may have resumed, changed or freshly re-committed after the report. Every missing,
    corrupt, future, contradictory or simply different fact denies the rename; the earlier
    committed/expired verdict is never trusted across that window.

    0.2.114: requireExpired distinguishes WHO authorized the isolation. True (the default for every
    0.2.113 caller, byte-for-byte) is the automatic expiry reclaim: the age threshold must still
    hold. Exactly False is an explicitly user-confirmed early release frozen in the preview ledger:
    ONLY the final age-threshold rule is skipped — every other under-lock check (shape, identity,
    generation, committed status, per-field presence/format, exact terminalAt binding, future
    timestamp, createdAt contradiction, unreadable/corrupt journal) denies exactly as before."""
    identity = binding.get("identity") if isinstance(binding, dict) else None
    generation = binding.get("generation") if isinstance(binding, dict) else None
    expiry_ms = binding.get("expiryMs") if isinstance(binding, dict) else None
    expected_terminal = binding.get("terminalAt") if isinstance(binding, dict) else None
    require_expired = binding.get("requireExpired", True) if isinstance(binding, dict) else None
    if not (isinstance(identity, str) and re.fullmatch(r"[0-9a-f]{64}", identity)
            and isinstance(generation, str) and re.fullmatch(r"[0-9a-f]{64}", generation)
            and isinstance(expiry_ms, int) and not isinstance(expiry_ms, bool) and expiry_ms > 0
            and (expected_terminal is None or (isinstance(expected_terminal, int) and not isinstance(expected_terminal, bool) and expected_terminal > 0))
            and isinstance(require_expired, bool)):
        deny("INVALID_STAGED_JOURNAL_BINDING")
    rel = str(target.get("relativePath") or "")
    if not STAGED_SLOT_REL_RE.match(rel):
        deny("INVALID_STAGED_JOURNAL_BINDING")
    reason = "锁内复检发现暂存槽 journal 不再符合过期回收资格，拒绝隔离"

    def trusted_int(value):
        return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None

    # Same path-guard discipline the engine's own manifest readers use (the slot lock, already
    # held by the caller, keeps a racing receiver from rewriting between read and rename).
    journal_full = path_guard(root, rel + "/manifest.json")
    try:
        with open(journal_full, "rb") as handle:
            payload = handle.read(262144)
        manifest_mtime = os.stat(journal_full, follow_symlinks=False).st_mtime
    except OSError:
        deny("STAGED_JOURNAL_MISMATCH", rel, reason)
    try:
        row = json.loads(payload)
    except ValueError:
        deny("STAGED_JOURNAL_MISMATCH", rel, reason)
    if not isinstance(row, dict) or row.get("identity") != identity or row.get("generation") != generation \
            or row.get("status") != "committed":
        deny("STAGED_JOURNAL_MISMATCH", rel, reason)
    # FINAL REVIEW P1-A: presence/format of EVERY field is enforced before any basis is chosen —
    # a written-but-null updatedAt or terminalAt is malformed, never a slip to older evidence —
    # and a binding that froze the terminal moment demands it back: a journal that LOST terminalAt
    # after the report is a different journal, no fallback.
    created = trusted_int(row.get("createdAt"))
    if "createdAt" in row and created is None:
        deny("STAGED_JOURNAL_MISMATCH", rel, reason)
    created_s = created / 1_000_000_000 if created and created > 1_000_000_000_000 else float(created or 0)
    terminal = row.get("terminalAt")
    if "terminalAt" in row and trusted_int(terminal) is None:
        deny("STAGED_JOURNAL_MISMATCH", rel, reason)
    updated = row.get("updatedAt")
    if "updatedAt" in row and trusted_int(updated) is None:
        deny("STAGED_JOURNAL_MISMATCH", rel, reason)
    if terminal is None and expected_terminal is not None:
        deny("STAGED_JOURNAL_MISMATCH", rel, reason)
    if terminal is not None:
        # A binding carrying the terminal moment binds it EXACTLY: a fresh re-commit (new or
        # missing terminalAt) is a different journal, whatever else still matches.
        if expected_terminal is not None and terminal != expected_terminal:
            deny("STAGED_JOURNAL_MISMATCH", rel, reason)
        basis = float(terminal)
    elif updated is not None:
        basis = float(updated)
    else:
        basis = manifest_mtime
    # The three consistency rules (malformed above, future, createdAt-contradiction) apply to
    # EVERY basis actually used under the lock — not only to the mtime fallback branch. They also
    # apply to a user-confirmed release: that mode skips ONLY the age threshold below.
    now = time.time()
    if basis > now or (created_s and basis < created_s - 1):
        deny("STAGED_JOURNAL_MISMATCH", rel, reason)
    if require_expired and (now - basis) * 1000 < expiry_ms:
        deny("STAGED_JOURNAL_MISMATCH", rel, reason)


def archived_control_rel(target):
    """Exact confirmed-path deletion target for one registered isolated subtree."""
    rel = target.get("relativePath")
    if target.get("authorizationMode") != "confirmed_paths" or not isinstance(rel, str):
        return None
    return rel if ARCHIVED_BATCH_RE.match(rel) else None


def isolation_control_rel(destination_rel):
    return "clean_dir/.operations/isolation/" + hashlib.sha256(
        ("isolation:" + os.path.normcase(destination_rel)).encode("utf-8")).hexdigest() + ".json"


def completion_control_rel(key):
    return "clean_dir/.operations/managed/complete-" + key + ".json"


def read_control_json(root, control_rel, limit=65536):
    full = path_guard(root, control_rel, True, True)
    if not os.path.lexists(full):
        return None
    before = os.lstat(full)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
        deny("CLEANUP_CONTROL_CHANGED", full)
    with open(full, "rb") as stream:
        raw = stream.read(limit + 1)
    after = os.lstat(full)
    if len(raw) > limit or (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
        deny("CLEANUP_CONTROL_CHANGED", full)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError):
        deny("CLEANUP_CONTROL_CHANGED", full)
    if not isinstance(value, dict):
        deny("CLEANUP_CONTROL_CHANGED", full)
    return value


def write_control_json(root, control_rel, value):
    full = path_guard(root, control_rel, True, True)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    path_guard(root, control_rel, True, True)
    temp = full + "." + os.urandom(6).hex() + ".tmp"
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    with open(temp, "xb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, full)


def isolation_state(root, destination_rel):
    record = read_control_json(root, isolation_control_rel(destination_rel))
    if record is None:
        return None
    if record.get("schemaVersion") != 1 or record.get("destination") != destination_rel:
        deny("CLEANUP_CONTROL_CHANGED")
    return record


ISOLATION_COMPLETION_KEYS = ("isolationCompletionProtocol", "archiveBatch", "sourceRelativePath",
                             "destinationRelativePath", "renameCommitted", "sourceMissingAtMove",
                             "registered", "executorsChecked", "executors")


def register_isolation(root, destination_rel, source_rel, operation_id, value, moment, completion=None):
    # The pending isolation mapping survives a lost response; it is removed
    # only by a user-confirmed permanent deletion or a completed restore.
    # Optional completion facts are the move-moment facts THIS call observed
    # (atomic rename committed, source name absent during the move, the
    # node-local managed-window sweep found no overlapping cleanup executor).
    # A settlement repair passes no completion dict on purpose: a later repair
    # cannot re-observe the move moment and must never fabricate these fields.
    record = {"schemaVersion": 1, "state": "isolated", "operationId": operation_id, "destination": destination_rel,
              "source": source_rel, "type": value["type"], "inode": value["inode"], "isolatedAt": moment}
    if value.get("device") is not None:
        record["device"] = value["device"]
    if isinstance(completion, dict):
        for key in ISOLATION_COMPLETION_KEYS:
            if key in completion:
                record[key] = completion[key]
    write_control_json(root, isolation_control_rel(destination_rel), record)


# ---------------------------------------------------------------------------
# v1.9 fast confirmed-path deletion chain (the single production executor for
# user-confirmed exact paths). The confirmation binds the ENTRY identity only
# (device+inode+type of each explicitly selected path); descendants are never
# content-hashed or fingerprint-frozen. A selected directory is first renamed
# inside its verified direct parent, on the same filesystem and without ever
# overwriting, to a unique isolation name; afterwards only that new name is
# removed, so a result that reappears under the original path is preserved.
# Scattered files are removed grouped by their verified direct parent with
# one entry lstat each. Kept hard constraints: full ancestor link/reparse/
# mount/protected-name walk, safe root, physical direct-parent cwd check,
# delete arguments only ./<direct child>, serial mutation, double confirmation
# (the client binds the batch digest; a replaced entry refuses with
# ENTRY_IDENTITY_CHANGED and must be re-confirmed). No handle scan, no task
# registry gate, no content hashing.

FAST_BATCH_LIMIT = 5000
FAST_TREE_MAX_DEPTH = 256
ISOLATION_SUFFIX = "__iso_"
FAST_CAPABILITIES = {"confirmedPathFastDelete": 1, "batchEntryInspect": 1}
# Explicit batch-phase fact: the fast chain sets "started" immediately before
# the first mutation syscall, so a failed delete-fast batch can prove whether
# partial changes were made. Retry safety reads this fact - never the error
# code alone, because TYPE_CHANGED or ENTRY_IDENTITY_CHANGED can also raise
# mid-walk or during the file-group recheck after earlier unlinks.
FAST_MUTATION_FACTS = {"started": False}


def isolation_name(operation_id, rel, leaf):
    # Deterministic from the preview operation id and the exact relative path
    # so the confirmation page can show original -> isolation before execution.
    return leaf + ISOLATION_SUFFIX + hashlib.sha256(
        (str(operation_id) + "\n" + rel).encode("utf-8")).hexdigest()[:16]


def fast_entry_check(root, item, operation_id):
    """Entry-only guard + frozen identity compare; never enumerates descendants."""
    if not isinstance(item, dict) or item.get("type") not in ("file", "directory"):
        deny("UNCERTAIN_TYPE")
    rel = item.get("relativePath")
    if not isinstance(rel, str):
        deny("UNSAFE_PATH")
    relative(rel)
    archived = bool(ARCHIVED_BATCH_RE.match(rel))
    full = path_guard(root, rel, allow_clean=archived, missing=True)
    if not os.path.lexists(full):
        row = {"relativePath": rel, "type": item["type"], "missing": True, "absolutePath": full, "archived": archived}
        if archived:
            # A missing archived entry still answers from its registration, so
            # a finished permanent deletion stays distinguishable from an
            # unexplained absence; nothing is created or touched here.
            row["isolationState"] = (isolation_state(root, rel) or {}).get("state")
        return row
    st = os.lstat(full)
    actual = "directory" if stat.S_ISDIR(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else "unknown"
    if actual != item["type"]:
        deny("TYPE_CHANGED", full)
    checked_parent(root, full)
    row = {"relativePath": rel, "type": actual, "absolutePath": full, "archived": archived,
           "device": str(st.st_dev), "inode": str(st.st_ino),
           "size": st.st_size if actual == "file" else 0, "mtime": str(st.st_mtime_ns)}
    if archived:
        state = isolation_state(root, rel)
        row["isolationState"] = (state or {}).get("state")
        # Move-moment facts persisted with the registration at rename time,
        # whitelisted verbatim; an older record simply carries no such keys.
        completion = {name: state[name] for name in ISOLATION_COMPLETION_KEYS if isinstance(state, dict) and name in state}
        if completion:
            row["isolationCompletion"] = completion
    elif actual == "directory":
        row["isolationName"] = isolation_name(operation_id, rel, os.path.basename(full))
    for key in ("device", "inode"):
        if item.get(key) is not None and str(item[key]) != row[key]:
            deny("ENTRY_IDENTITY_CHANGED", full, "所选入口在确认后被替换为另一个对象，请重新确认")
    return row


def batch_inspect(root, identity, request):
    """One read-only metadata transfer for the whole confirmed selection.

    An empty target list is a pure capability probe: it returns the ABI
    versions without touching any entry, so a paired integration can detect
    the fast chain instead of guessing from released version numbers.
    """
    if request.get("authorizationMode") != "confirmed_paths":
        deny("INVALID_AUTHORIZATION_MODE")
    targets = request.get("targets")
    if not isinstance(targets, list) or len(targets) > FAST_BATCH_LIMIT:
        deny("FAST_BATCH_INVALID")
    operation_id = str(request.get("operationId") or "")
    mount_reads = _MOUNT_CACHE["reads"]
    started = time.monotonic()
    rows = [fast_entry_check(root, item, operation_id) for item in targets]
    return {"ok": True, "rootIdentity": identity, "capabilities": dict(FAST_CAPABILITIES), "targets": rows,
            # entryReads counts one entry-level metadata read per target; it
            # is deliberately not presented as a raw syscall total.
            "metrics": {"selected": len(rows), "entryReads": len(rows),
                        "mountReads": _MOUNT_CACHE["reads"] - mount_reads,
                        "entryCheckMs": round((time.monotonic() - started) * 1000, 1)}}


def batch_verify(root, identity, request):
    """Active presence query after a fast deletion; entry-only and read-only."""
    if request.get("authorizationMode") != "confirmed_paths":
        deny("INVALID_AUTHORIZATION_MODE")
    entries = request.get("entries")
    if not isinstance(entries, list) or not 1 <= len(entries) <= FAST_BATCH_LIMIT:
        deny("FAST_BATCH_INVALID")
    rows = []
    for item in entries:
        rel = item.get("relativePath") if isinstance(item, dict) else None
        if not isinstance(rel, str):
            deny("UNSAFE_PATH")
        relative(rel)
        full = path_guard(root, rel, allow_clean=bool(ARCHIVED_BATCH_RE.match(rel)), missing=True)
        if not os.path.lexists(full):
            rows.append({"relativePath": rel, "status": "gone"})
            continue
        st = os.lstat(full)
        same = (item.get("device") is None or str(st.st_dev) == str(item["device"])) \
            and (item.get("inode") is None or str(st.st_ino) == str(item["inode"]))
        kind = "directory" if stat.S_ISDIR(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else "unknown"
        rows.append({"relativePath": rel, "status": "present" if same else "replaced", "type": kind,
                     "device": str(st.st_dev), "inode": str(st.st_ino)})
    return {"ok": True, "rootIdentity": identity, "targets": rows}


def cleanup_executor_inventory(root):
    """One shared managed-pane sweep for a whole batch-observe request.

    Returns (inventory, checked). checked is False when the sweep cannot be
    performed here (Windows, or a tmux failure handled by the caller), so the
    answer reports executor facts as unchecked instead of laundering an empty
    list into "no executors". A malformed binding still refuses the round,
    exactly like current_cleanup_executors: an untrusted sweep proves nothing.
    """
    if os.name == "nt":
        return [], False
    lines = managed_tmux(["list-panes", "-a", "-F", "#{window_id}\t#{pane_id}\t#{pane_dead}\t#{@sftp_cleanup_target}"]).splitlines()
    inventory = []
    for line in lines:
        fields = line.split("\t")
        if len(fields) != 4 or fields[2] == "1" or not fields[3]:
            continue
        try:
            binding = json.loads(base64.urlsafe_b64decode(fields[3]).decode("utf-8"))
        except (ValueError, UnicodeError):
            deny("CLEANUP_WINDOW_BINDING_UNVERIFIED", fields[0])
        if binding.get("root") == root:
            inventory.append((fields[0], fields[1], binding))
    return inventory, True


def executors_for_paths(inventory, root, paths):
    """Window facts for one group's exact paths, matched inside the shared sweep."""
    result = []
    for window_id, pane_id, binding in inventory:
        for name in ("relativePath", "destination"):
            if not binding.get(name):
                continue
            active = path_guard(root, relative(binding[name]), True, True)
            if any(full == active or below(full, active) or below(active, full) for full in paths):
                result.append({"windowId": window_id, "paneId": pane_id})
                break
    return result


def observe_entry(root, rel, expected_type, device=None, inode=None):
    """Current facts for one exact path under the existing guards; never follows links.

    status stays inside the batch-verify vocabulary (present/gone/replaced):
    same frozen identity with the same kind is present; anything else observed
    on disk (identity drift, type change, link) is replaced - new data, never
    the frozen entry.
    """
    full = path_guard(root, rel, bool(ARCHIVED_BATCH_RE.match(rel)), True)
    if not os.path.lexists(full):
        return {"status": "gone", "absolutePath": full,
                "target": {"missing": True, "type": expected_type, "absolutePath": full}}
    st = os.lstat(full)
    kind = "directory" if stat.S_ISDIR(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else "unknown"
    same = (device is None or str(st.st_dev) == str(device)) and (inode is None or str(st.st_ino) == str(inode))
    return {"status": "present" if same and kind == expected_type else "replaced", "absolutePath": full,
            "target": {"missing": False, "type": kind, "absolutePath": full,
                       "device": str(st.st_dev), "inode": str(st.st_ino)}}


def batch_observe(root, identity, request):
    """v1.10 exception recovery: one read-only observation round per request.

    Every keyed entry answers with CURRENT filesystem facts (presence, kind,
    identity against the frozen device/inode), executor facts taken from the
    ONE shared window sweep, and - only where the caller supplied an explicit
    isolation path - that residue probe. Nothing is guessed and nothing is
    fabricated from local receipts: this walk takes no execution lock, writes
    nothing, and grants no authority for a later step. A poisoned path answers
    only for itself; the round never claims more than it observed.
    """
    entries = request.get("entries")
    if not isinstance(entries, list) or not 1 <= len(entries) <= FAST_BATCH_LIMIT:
        deny("FAST_BATCH_INVALID")
    if not isinstance(request.get("observationId"), str) or not request.get("observationId"):
        deny("INVALID_REQUEST")
    if request.get("rootIdentity") and request["rootIdentity"] != identity:
        deny("ROOT_IDENTITY_CHANGED")
    keys = [item.get("key") if isinstance(item, dict) else None for item in entries]
    if any(not isinstance(key, str) or not key for key in keys) or len(set(keys)) != len(keys):
        deny("INVALID_REQUEST")
    for item, key in zip(entries, keys):
        if not isinstance(item.get("relativePath"), str):
            deny("UNSAFE_PATH", key or "")
        if item.get("type") not in ("file", "directory"):
            deny("INVALID_REQUEST", key or "")
        if item.get("isolationRelativePath") is not None and not isinstance(item["isolationRelativePath"], str):
            deny("UNSAFE_PATH", key or "")
    try:
        inventory, checked = cleanup_executor_inventory(root)
    except GuardError:
        raise  # unverified binding: the round stays unknown, never an empty list
    except Exception:
        # No usable tmux here (missing binary, timeout): executor facts are
        # explicitly unchecked, which is not the same as "no executors".
        inventory, checked = [], False
    observations = []
    for item, key in zip(entries, keys):
        row = {"key": key, "relativePath": item["relativePath"], "type": item["type"]}
        iso_rel = item.get("isolationRelativePath")
        try:
            facts = observe_entry(root, relative(item["relativePath"]), item["type"], item.get("device"), item.get("inode"))
            paths = [facts["absolutePath"]]
            if iso_rel is not None:
                iso_facts = observe_entry(root, relative(iso_rel), "directory")
                paths.append(iso_facts["absolutePath"])
                row["isolationStatus"] = iso_facts["status"]
                row["isolationChecked"] = True
            row["status"] = facts["status"]
            row["target"] = facts["target"]
            row["executors"] = executors_for_paths(inventory, root, paths) if checked else []
            row["executorsChecked"] = checked
        except GuardError as error:
            row = {"key": key, "relativePath": item["relativePath"], "type": item.get("type"),
                   "executors": [], "executorsChecked": False,
                   "error": {"code": error.code, "message": str(error) or error.code}}
            if iso_rel is not None:
                row["isolationChecked"] = False
        observations.append(row)
    return {"ok": True, "observationId": request["observationId"], "rootIdentity": identity,
            "capabilities": dict(FAST_CAPABILITIES, batchCleanupObservation=1),
            "observations": observations,
            "metrics": {"selected": len(observations), "executorQueries": 1 if checked else 0}}


def isolation_parent_paths(destinations):
    if not isinstance(destinations, list) or not 1 <= len(destinations) <= 5000:
        deny("EMPTY_ISOLATION_SCOPE_INVALID")
    parents = set()
    for destination in destinations:
        if not isinstance(destination, str) or not ARCHIVED_BATCH_RE.fullmatch(destination):
            deny("EMPTY_ISOLATION_SCOPE_INVALID")
        relative(destination)
        parts = destination.split("/")[:-1]
        while len(parts) >= 2:
            parents.add("/".join(parts))
            parts.pop()
    return sorted(parents, key=lambda name: (-name.count("/"), name))


def isolation_parent_control(parent):
    return "clean_dir/.operations/isolation-parents/" + hashlib.sha256(parent.encode("utf-8")).hexdigest() + ".json"


def make_isolation_parents(root, destination):
    """Record only containers this isolation actually creates, never clean_dir itself."""
    relative_destination = os.path.relpath(destination, root).replace(os.sep, "/")
    if not ARCHIVED_BATCH_RE.fullmatch(relative_destination):
        deny("EMPTY_ISOLATION_SCOPE_INVALID")
    parts = relative_destination.split("/")[:-1]
    for count in range(1, len(parts) + 1):
        rel = "/".join(parts[:count])
        full = path_guard(root, rel, True, True)
        if os.path.lexists(full):
            if not stat.S_ISDIR(os.lstat(full).st_mode):
                deny("TYPE_CHANGED", full)
            continue
        os.mkdir(full)
        if count >= 2:
            info = os.lstat(full)
            write_control_json(root, isolation_parent_control(rel), {"path": rel, "batch": parts[1],
                "device": str(info.st_dev), "inode": str(info.st_ino)})


def inspect_isolation_parents(root, identity, request):
    destinations = request.get("destinations")
    paths = isolation_parent_paths(destinations)
    future = request.get("forReplacement") is True
    if not future and any((isolation_state(root, destination) or {}).get("state") != "deleted" for destination in destinations):
        return {"ok": True, "rootIdentity": identity, "eligible": False, "targets": []}
    targets = []
    for rel in paths:
        full = path_guard(root, rel, True, True)
        if not os.path.lexists(full):
            if future:
                targets.append({"relativePath": rel, "absolutePath": full, "type": "directory", "future": True})
            continue
        info = os.lstat(full)
        if not stat.S_ISDIR(info.st_mode):
            deny("TYPE_CHANGED", full)
        owned = read_control_json(root, isolation_parent_control(rel))
        if future and (not owned or owned.get("batch") != rel.split("/")[1]
                       or owned.get("device") != str(info.st_dev) or owned.get("inode") != str(info.st_ino)):
            continue  # Existing unowned containers never become implicit deletion targets.
        targets.append({"relativePath": rel, "absolutePath": full, "type": "directory",
                        "device": str(info.st_dev), "inode": str(info.st_ino)})
    # A legacy review may authorize only a known empty hierarchy, never its files.
    if not future:
        approved = {row["relativePath"] for row in targets}
        for row in targets:
            full = row["absolutePath"]
            for child in os.listdir(full):
                child_rel = row["relativePath"] + "/" + child
                if child_rel not in approved:
                    return {"ok": True, "rootIdentity": identity, "eligible": False, "targets": [], "reason": "EMPTY_ISOLATION_PARENT_NOT_EMPTY"}
    return {"ok": True, "rootIdentity": identity, "eligible": True, "targets": targets}


def prune_isolation_parents(root, identity, request):
    if request.get("rootIdentity") != identity or request.get("parentConfirmations") != 2:
        deny("CONFIRM_REQUIRED")
    allowed = set(isolation_parent_paths(request.get("destinations")))
    if any((isolation_state(root, destination) or {}).get("state") != "deleted" for destination in request["destinations"]):
        deny("ISOLATION_DELETE_NOT_COMPLETED")
    entries = request.get("entries")
    if not isinstance(entries, list) or not all(isinstance(row, dict) for row in entries) or len(entries) > 5000 or len({row.get("relativePath") for row in entries}) != len(entries):
        deny("EMPTY_ISOLATION_SCOPE_INVALID")
    checked = []
    for row in entries:
        rel = row.get("relativePath")
        if rel not in allowed or row.get("type") != "directory":
            deny("EMPTY_ISOLATION_SCOPE_INVALID")
        full = path_guard(root, rel, True, True)
        if not os.path.lexists(full):
            continue
        expected = read_control_json(root, isolation_parent_control(rel)) if row.get("future") else row
        info = os.lstat(full)
        if not expected or row.get("future") and (expected.get("path") != rel or expected.get("batch") != rel.split("/")[1]) \
                or not stat.S_ISDIR(info.st_mode) or expected.get("device") != str(info.st_dev) or expected.get("inode") != str(info.st_ino):
            deny("ENTRY_IDENTITY_CHANGED", full)
        checked.append((rel, full, str(info.st_dev), str(info.st_ino)))
    actual = {row[0] for row in checked}
    for rel, full, _, _ in checked:
        if any(rel + "/" + leaf not in actual for leaf in os.listdir(full)):
            deny("EMPTY_ISOLATION_PARENT_NOT_EMPTY", full)
    removed = 0
    for rel, full, device, inode in sorted(checked, key=lambda row: (-row[0].count("/"), row[0])):
        path_guard(root, rel, True)
        child = parent_cd(root, full)
        info = os.lstat(child)
        if not stat.S_ISDIR(info.st_mode) or str(info.st_dev) != device or str(info.st_ino) != inode or os.listdir(child):
            deny("ENTRY_IDENTITY_CHANGED", full)
        FAST_MUTATION_FACTS["started"] = True
        os.rmdir(child)  # Atomic empty-directory removal; never recursively remove contents.
        if os.path.lexists(child):
            deny("TARGET_STILL_EXISTS", full)
        removed += 1
        if read_control_json(root, isolation_parent_control(rel)):
            write_control_json(root, isolation_parent_control(rel), {"removed": True})
    return {"ok": True, "state": "completed", "rootIdentity": identity,
            "receipt": {"phase": "completed", "emptyDirectoriesRemoved": removed}}


def fast_tree_remove(root, entry_abs, allow_clean, stats):
    """Post-order removal of one fully authorized tree under the ./<leaf> rule.

    Precondition: the physical cwd is entry_abs's verified direct parent.
    The walk never follows links or crosses devices/mounts, refuses protected
    names, and unwinds the cwd chain back to the entry parent on any refusal.
    """
    tree_dev = os.lstat("./" + os.path.basename(entry_abs)).st_dev
    mounts = mount_points()

    def walk(rel_name, abs_dir, depth):
        if depth > FAST_TREE_MAX_DEPTH:
            deny("TREE_TOO_DEEP", abs_dir)
        if rel_name.lower() == "clean_dir" and not allow_clean:
            deny("PROTECTED_DESCENDANT", abs_dir, "归档区受保护，不能随父目录删除")
        info = os.lstat("./" + rel_name)
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 1024:
            deny("LINK_OR_REPARSE_POINT", abs_dir)
        if not stat.S_ISDIR(info.st_mode):
            deny("UNCERTAIN_TYPE", abs_dir)
        if info.st_dev != tree_dev or os.path.ismount(abs_dir) or abs_dir in mounts:
            deny("MOUNT_ESCAPE", abs_dir)
        os.chdir("./" + rel_name)
        try:
            for leaf in sorted(os.listdir(".")):
                relative(leaf)
                leaf_full = os.path.join(abs_dir, leaf)
                leaf_info = os.lstat("./" + leaf)
                if stat.S_ISLNK(leaf_info.st_mode) or getattr(leaf_info, "st_file_attributes", 0) & 1024:
                    deny("LINK_OR_REPARSE_POINT", leaf_full)
                if leaf.lower() == "clean_dir" and not allow_clean:
                    deny("PROTECTED_DESCENDANT", leaf_full, "归档区受保护，不能随父目录删除")
                if leaf_info.st_dev != tree_dev:
                    deny("MOUNT_ESCAPE", leaf_full)
                stats["entries"] += 1
                if stat.S_ISREG(leaf_info.st_mode):
                    FAST_MUTATION_FACTS["started"] = True
                    os.unlink("./" + leaf)
                    stats["files"] += 1
                    progress_heartbeat()
                elif stat.S_ISDIR(leaf_info.st_mode):
                    walk(leaf, leaf_full, depth + 1)
                else:
                    deny("UNCERTAIN_TYPE", leaf_full)
        finally:
            os.chdir("..")
        FAST_MUTATION_FACTS["started"] = True
        os.rmdir("./" + rel_name)
        stats["rmdirs"] += 1

    walk(os.path.basename(entry_abs), entry_abs, 1)


def delete_fast(root, identity, request):
    """The single confirmed-path production executor: entry-bound, batched,
    directories isolated by non-overwriting rename first, mutation serial."""
    if request.get("authorizationMode") != "confirmed_paths":
        deny("INVALID_AUTHORIZATION_MODE")
    if request.get("rootIdentity") != identity:
        deny("ROOT_IDENTITY_CHANGED")
    entries = request.get("entries")
    operation_id = request.get("operationId")
    if not isinstance(entries, list) or not 1 <= len(entries) <= FAST_BATCH_LIMIT \
            or not isinstance(operation_id, str) or not operation_id:
        deny("FAST_BATCH_INVALID")
    FAST_MUTATION_FACTS["started"] = False
    mount_reads = _MOUNT_CACHE["reads"]
    stage = {"check": 0.0, "mutate": 0.0, "confirm": 0.0}
    started = time.monotonic()
    # Phase 1: every entry re-confirms identity before anything is mutated,
    # so a refused batch never leaves a partially deleted selection.
    file_groups = {}
    directories = []
    already = []
    for item in entries:
        if not isinstance(item, dict) or not isinstance(item.get("device"), str) or not isinstance(item.get("inode"), str):
            deny("ENTRY_IDENTITY_CHANGED", "", "缺少入口设备/节点号绑定，请重新确认")
        row = fast_entry_check(root, item, operation_id)
        if row.get("missing"):
            deny("MISSING_TARGET", row["absolutePath"], "确认目标已不存在，请重新确认")
        if row["archived"] and row.get("isolationState") == "deleted":
            already.append(row["relativePath"])
            continue
        if row["archived"] and row.get("isolationState") != "isolated":
            deny("NOT_REGISTERED_ISOLATION", row["absolutePath"], "只有已登记的隔离产物子树可以经确认路径永久删除")
        if not row["archived"] and row["type"] == "directory" and item.get("isolationName") is not None \
                and item["isolationName"] != row["isolationName"]:
            deny("ENTRY_IDENTITY_CHANGED", row["absolutePath"], "隔离映射与本次确认不一致，请重新确认")
        if row["type"] == "file":
            file_groups.setdefault(os.path.dirname(row["absolutePath"]), []).append(row)
        else:
            directories.append(row)
    # Complete native evidence for every live entry before the first mutation.
    for row in [*directories, *(item for group in file_groups.values() for item in group)]:
        darwin_handle_guard(root, row["absolutePath"], allow_nested_git=True)
    stage["check"] = time.monotonic() - started
    stats = {"files": 0, "entries": 0, "rmdirs": 0, "renames": 0}
    receipts = []
    started = time.monotonic()
    # Phase 2a: directories — isolate by rename (never overwriting), then
    # remove only the new name. The original path is never deleted directly.
    for row in directories:
        full = row["absolutePath"]
        leaf = os.path.basename(full)
        child = parent_cd(root, full)
        if row["archived"]:
            fast_tree_remove(root, full, True, stats)
            if os.path.lexists("./" + leaf):
                deny("TARGET_STILL_EXISTS", full)
            write_control_json(root, isolation_control_rel(row["relativePath"]),
                               {"schemaVersion": 1, "state": "deleted", "operationId": operation_id,
                                "destination": row["relativePath"], "deletedAt": time.time()})
            receipts.append({"relativePath": row["relativePath"], "mode": "registered-isolation", "phase": "completed"})
            continue
        iso = row["isolationName"]
        iso_relative = row["relativePath"][:len(row["relativePath"]) - len(leaf)] + iso
        if os.path.lexists("./" + iso):
            deny("ISOLATION_NAME_TAKEN", os.path.join(os.path.dirname(full), iso))
        FAST_MUTATION_FACTS["started"] = True
        no_replace(child, "./" + iso)
        stats["renames"] += 1
        after = os.lstat("./" + iso)
        if str(after.st_ino) != row["inode"] or str(after.st_dev) != row["device"] or not stat.S_ISDIR(after.st_mode):
            deny("MOVE_VERIFICATION_FAILED", os.path.join(os.path.dirname(full), iso))
        iso_full = os.path.join(os.path.dirname(full), iso)
        fast_tree_remove(root, iso_full, False, stats)
        if os.path.lexists("./" + iso):
            deny("TARGET_STILL_EXISTS", iso_full)
        receipts.append({"relativePath": row["relativePath"], "mode": "isolate-then-delete", "isolationRelativePath": iso_relative,
                         "originalPathRecreated": os.path.lexists("./" + leaf), "phase": "completed"})
    # Phase 2b: scattered files, grouped by their verified direct parent;
    # one physical parent-cd per group, one entry lstat + unlink per file.
    for parent in sorted(file_groups):
        rows = file_groups[parent]
        parent_cd(root, rows[0]["absolutePath"])
        for row in rows:
            leaf = os.path.basename(row["absolutePath"])
            info = os.lstat("./" + leaf)
            if not stat.S_ISREG(info.st_mode):
                deny("TYPE_CHANGED", row["absolutePath"])
            if str(info.st_ino) != row["inode"] or str(info.st_dev) != row["device"]:
                deny("ENTRY_IDENTITY_CHANGED", row["absolutePath"], "所选文件在确认后被替换，请重新确认")
            FAST_MUTATION_FACTS["started"] = True
            os.unlink("./" + leaf)
            stats["files"] += 1
            progress_heartbeat()
            if row["archived"]:
                write_control_json(root, isolation_control_rel(row["relativePath"]),
                                   {"schemaVersion": 1, "state": "deleted", "operationId": operation_id,
                                    "destination": row["relativePath"], "deletedAt": time.time()})
        receipts.append({"parent": os.path.relpath(parent, root).replace(os.sep, "/"), "removedFiles": len(rows), "phase": "completed"})
    stage["mutate"] = time.monotonic() - started
    started = time.monotonic()
    groups = len(file_groups) + len(directories)
    metrics = {"selected": len(entries), "alreadyDeleted": len(already), "groups": groups, "renames": stats["renames"],
               "unlinkedFiles": stats["files"], "treeEntriesRemoved": stats["entries"], "treeDirsRemoved": stats["rmdirs"],
               "mountReads": _MOUNT_CACHE["reads"] - mount_reads,
               "stages": {"entryCheckMs": round(stage["check"] * 1000, 1), "mutateMs": round(stage["mutate"] * 1000, 1),
                          "confirmMs": round((time.monotonic() - started) * 1000, 1)}}
    return {"ok": True, "rootIdentity": identity,
            "receipt": {"operationId": operation_id, "action": "delete-fast", "phase": "completed",
                        "metrics": metrics, "receipts": receipts[:220], "alreadyDeleted": already[:220]}}


def top_identity(full, expected_type):
    st = os.lstat(full)
    actual = "directory" if stat.S_ISDIR(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else "unknown"
    if actual != expected_type:
        deny("TYPE_CHANGED")
    row = {"type": actual, "device": str(st.st_dev), "inode": str(st.st_ino), "mtime": str(st.st_mtime_ns), "ctime": str(st.st_ctime_ns)}
    if actual == "file":
        row["size"] = st.st_size
    row["fingerprint"] = digest({"fingerprintMode": "top_level", **row})
    return row


FAST_MANIFEST_NAMES = ("artifact_manifest.json", "formal_job_owner.json", "run_wrapper_report.json", "checkpoint_manifest.json")


def top_manifest_rows(root, rel, full):
    rows = []
    if not os.path.isdir(full):
        return rows
    for name in FAST_MANIFEST_NAMES + ("config.yaml", "config_snapshot.yaml"):
        file = path_guard(root, rel + "/" + name, True, True)
        if not os.path.isfile(file) or os.path.getsize(file) > 1024 * 1024:
            continue
        rows.append({**contents(root, file, "file")["inventory"][0], "path": name})
    return rows


def isolate_inspect(root, target, operation_id=None):
    """C1 pre-write authorization bounded to top-level identity plus declared
    ownership and real writer checks. Never hashes tree contents in foreground."""
    rel = relative(target["relativePath"])
    full = path_guard(root, rel)
    checked_parent(root, full)
    if target.get("authorizationMode") == "confirmed_paths":
        deny("INVALID_AUTHORIZATION_MODE", full, "快速隔离必须走精确声明与确认范围")
    tracked_dirty(root, rel)
    value = top_identity(full, target["type"])
    value["fingerprintMode"] = "top_level"
    value["inventory"] = top_manifest_rows(root, rel, full)
    darwin_handle_guard(root, full)
    value["manifests"] = manifest_records(root, full, value)
    value["references"] = []
    owner = target.get("expectedOwner")
    if isinstance(owner, dict) and owner.get("resultPathPolicy") == "declared":
        owner_hash = formal_cleanup_owner(root, target, owner)
        value["formalOwnerSha256"] = owner_hash
        value["fingerprint"] = digest({"target": value["fingerprint"], "formalOwnerSha256": owner_hash})
    if target.get("activityEvidenceMode") == "managed_tmux":
        managed_active(root, target, full, value)
    executors = current_cleanup_executors(root, full, operation_id)
    if executors:
        deny("ACTIVE_CLEANUP_EXECUTOR", executors[0]["windowId"], "已有清理执行器正在处理重叠目标")
    # Node-local move-stage fact: THIS inspect swept the managed cleanup
    # windows and found none overlapping the target. It proves only this
    # instant on this node and is never re-presented as a later check.
    value["executorsChecked"] = True
    value["executors"] = []
    for name in target.get("requiredInputs") or ():
        input_full = path_guard(root, relative(name), True, True)
        if os.path.lexists(input_full) and (input_full == full or below(full, input_full)):
            deny("ISOLATE_REQUIRED_INPUT_OVERLAP", input_full, "新运行仍按原路径引用该必需输入，不能移动其依赖源")
    destination = path_guard(root, target["destination"], True, True)
    if os.path.lexists(destination):
        deny("DESTINATION_EXISTS")
    ancestor = os.path.dirname(destination)
    while ancestor != root and not os.path.lexists(ancestor):
        ancestor = os.path.dirname(ancestor)
    if os.stat(ancestor).st_dev != os.stat(full).st_dev:
        deny("CROSS_FILESYSTEM", destination, "隔离必须与源在同一文件系统，不静默降级为复制")
    value.update({"absolutePath": full, "parent": os.path.dirname(full), "leaf": os.path.basename(full), "destination": destination})
    return value


def frozen_isolation_completion(root, target, destination):
    """v1.2 recovery proof: a finished isolation is proven only by the frozen
    pre-change identity still parked at the bound destination (rename keeps the
    source inode/device) or by the registered isolation record. A recreated
    canonical path is new-run data; it never revokes the completed operation,
    and it is never re-moved or re-deleted. Insufficient proof stays unknown."""
    if os.path.lexists(destination):
        try:
            after = top_identity(destination, target["type"])
        except GuardError:
            return None
        if after["inode"] == target.get("inode") and after["device"] == target.get("device"):
            return "destination_identity"
        return None
    destination_rel = os.path.relpath(destination, root).replace(os.sep, "/")
    registered = isolation_state(root, destination_rel)
    if not registered:
        return None
    if registered.get("state") == "deleted":
        return "isolation_deleted"
    if registered.get("state") == "isolated" and registered.get("source") == relative(target["relativePath"]):
        return "destination_identity"
    return None


def subtree_lock_rel(component_rel):
    return "clean_dir/.operations/locks/" + hashlib.sha256(
        ("subtree:" + os.path.normcase(component_rel)).encode("utf-8")).hexdigest() + ".lock"


def acquire_target_locks(root, rels):
    """C2 exact subtree single writer: leaf exclusive, ancestors shared.
    Non-overlapping targets run in parallel; parent/child overlap blocks."""
    wanted = {}
    for rel in rels:
        parts = relative(rel).split("/")
        for index in range(1, len(parts) + 1):
            component = "/".join(parts[:index])
            mode = "exclusive" if index == len(parts) else "shared"
            wanted[component] = "exclusive" if (mode == "exclusive" or wanted.get(component) == "exclusive") else "shared"
    opened = []
    try:
        for component in sorted(wanted, key=subtree_lock_rel):
            full = path_guard(root, subtree_lock_rel(component), True, True)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            path_guard(root, subtree_lock_rel(component), True, True)
            stream = open(full, "a+b")
            try:
                if os.name == "nt":
                    # msvcrt offers no shared range: Windows also serializes siblings.
                    import msvcrt
                    stream.seek(0)
                    if not stream.read(1):
                        stream.write(b"0"); stream.flush()
                    stream.seek(0)
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), (fcntl.LOCK_EX if wanted[component] == "exclusive" else fcntl.LOCK_SH) | fcntl.LOCK_NB)
            except OSError:
                stream.close()
                deny("OPERATION_BUSY")
            opened.append(stream)
    except BaseException:
        for stream in opened:
            stream.close()
        raise
    return opened


def finalize_managed_window(root, request, completion=None):
    """C3 server-side self close: persist the minimal anti-replay completion
    identity first, then release exactly this request's bound pane — proven
    live, matching @sftp_cleanup and still marked remain-on-exit — by turning
    the flag off and destroying that single pane. A wrapper that exits without
    closing (tmux 3.0a/3.2a/3.3a keep a remain-on-exit window through a later
    flag change and shell teardown) must not leave a dead window behind.
    Failures keep the window for inspection; never re-delete.
    For an isolation move, the completion record additionally persists the
    move-moment facts this very process observed (the whitelisted completion
    dict); they describe the move, never a later deletion-time check."""
    key = managed_key({**request, "cleanupAction": request["action"]})
    completion_record = {"schemaVersion": 1, "state": "completed", "cleanupKey": key,
                         "operationId": request["operationId"], "action": request["action"], "completedAt": time.time()}
    if isinstance(completion, dict):
        completion_record["completion"] = {name: completion[name] for name in ISOLATION_COMPLETION_KEYS if name in completion}
    write_control_json(root, completion_control_rel(key), completion_record)
    try:
        pane = os.environ.get("TMUX_PANE", "")
        if not pane:
            return {"finalized": False, "receiptWritten": True}
        fields = managed_tmux(["display-message", "-p", "-t", pane, "#{window_id}\t#{pane_id}\t#{pane_dead}\t#{@sftp_cleanup}\t#{remain-on-exit}"]).split("\t")
        if len(fields) != 5 or fields[3] != key or fields[2] != "0" or fields[4] != "on":
            return {"finalized": False, "receiptWritten": True}
        managed_tmux(["set-option", "-w", "-t", fields[0], "remain-on-exit", "off"])
        managed_tmux(["kill-pane", "-t", fields[1]])
        return {"finalized": True, "receiptWritten": True}
    except GuardError:
        return {"finalized": False, "receiptWritten": True}


def managed_tmux(args):
    result = subprocess.run(["tmux", *args], capture_output=True, text=True, timeout=5)
    if result.returncode:
        error = result.stderr or ""
        low = error.lower()
        absent = "no server running" in low or "no sessions" in low or "error connecting" in low and any(value in low for value in ("no such file or directory", "connection refused"))
        if args[0] == "list-panes" and absent:
            return ""
        deny("CLEANUP_TMUX_QUERY_FAILED", error[-1000:])
    return result.stdout.rstrip("\r\n")


def managed_key(request):
    if not re.fullmatch(r"[a-zA-Z0-9._:-]{1,128}", str(request.get("operationId") or "")):
        deny("CLEANUP_OPERATION_REQUIRED")
    return digest({"operation": request["operationId"], "root": request["rootIdentity"],
                   "path": request["target"]["relativePath"], "action": request["cleanupAction"], "fingerprint": request["target"]["fingerprint"]})


def current_cleanup_executors(root, full, exclude_operation=None):
    if os.name == "nt":
        return []
    result = []
    for line in managed_tmux(["list-panes", "-a", "-F", "#{window_id}\t#{pane_id}\t#{pane_dead}\t#{@sftp_cleanup_target}"]).splitlines():
        fields = line.split("\t")
        if len(fields) != 4 or fields[2] == "1" or not fields[3]:
            continue
        try:
            binding = json.loads(base64.urlsafe_b64decode(fields[3]).decode("utf-8"))
        except (ValueError, UnicodeError):
            deny("CLEANUP_WINDOW_BINDING_UNVERIFIED", fields[0])
        if binding.get("root") != root:
            continue
        # A managed window is never an external writer against itself.
        if exclude_operation is not None and binding.get("operationId") == exclude_operation:
            continue
        for name in ("relativePath", "destination"):
            if not binding.get(name):
                continue
            active = path_guard(root, relative(binding[name]), True, True)
            if full == active or below(full, active) or below(active, full):
                result.append({"windowId": fields[0], "paneId": fields[1]})
                break
    return result


def managed_active(root, target, full, value):
    # Only real managed tmux windows are execution evidence. No historical PID/owner/claim scan.
    if os.name == "nt":
        return
    fmt = "#{pane_id}\t#{window_id}\t#{pane_dead}\t#{@se_job}\t#{@simple_experiment_command}\t#{@simple_experiment_project}"
    records = manifest_records(root, full, value)
    run_ids = {row["binding"].get("runId") for row in records} - {None, ""}
    sources = [full, path_guard(root, target["destination"], True, True)]
    for line in managed_tmux(["list-panes", "-a", "-F", fmt]).splitlines():
        fields = line.split("\t")
        if len(fields) != 6 or fields[2] == "1":
            continue
        try:
            job = json.loads(base64.urlsafe_b64decode(fields[3]).decode("utf-8")) if fields[3] else {}
        except (ValueError, UnicodeError):
            deny("CLEANUP_TASK_BINDING_UNVERIFIED", fields[1])
        if job.get("root") == root and (not job.get("pane") or job["pane"] == fields[0]):
            for name in ("outputDir", "collectionResultCsv"):
                if not job.get(name):
                    continue
                active = path_guard(root, relative(job[name]), False, True)
                if any(active == source or below(active, source) or below(source, active) for source in sources):
                    deny("ACTIVE_TMUX_TASK", fields[1] + ":" + fields[0])
        elif fields[4] in run_ids:
            deny("ACTIVE_TMUX_TASK", fields[1] + ":" + fields[0])


def managed_delete_progress(root, target):
    inventory = target.get("inventory") or []
    source = path_guard(root, target["relativePath"], archived_control_rel(target) is not None, True)
    expected = {row["path"]: row for row in inventory}
    seen, mounts = set(), mount_points()
    def scan(full, rel):
        try:
            info = os.lstat(full)
        except FileNotFoundError:
            return
        row = expected.get(rel)
        if not row:
            return  # Progress never follows new children or expands the approved inventory.
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 1024:
            deny("LINK_OR_REPARSE_POINT", full)
        if str(info.st_dev) != row["device"] or str(info.st_ino) != row["inode"] or full in mounts:
            deny("IDENTITY_CHANGED", full)
        seen.add(rel)
        if stat.S_ISDIR(info.st_mode):
            try:
                with os.scandir(full) as children:
                    for child in children:
                        name = rel + "/" + child.name if rel else child.name
                        if name in expected:
                            scan(child.path, name)
            except FileNotFoundError:
                pass  # This executor removed the directory during the query.
    scan(source, "")
    removed = [row for row in inventory if row["path"] not in seen]
    return {"removedEntries": len(removed), "totalEntries": len(inventory), "removedBytes": sum(row.get("size", 0) for row in removed),
            "totalBytes": sum(row.get("size", 0) for row in inventory)}


def frozen_observation_target(root, request, key):
    expected = request.get("frozenTargetDigest")
    if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
        deny("CLEANUP_INPUT_CHANGED")
    file = path_guard(root, "clean_dir/.operations/managed/" + key + ".json", True, True)
    if not os.path.lexists(file):
        return None
    before = os.lstat(file)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_CLEANUP_REQUEST_BYTES:
        deny("CLEANUP_INPUT_CHANGED", file)
    fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
    with open(file, "rb") as stream:
        opened = os.fstat(stream.fileno())
        # Windows path stat may expose creation time as ctime while handle stat
        # exposes change time. Compare each clock against itself across the read.
        identity_fields = fields[:-1] if os.name == "nt" else fields
        if opened.st_nlink != 1 or any(getattr(before, name) != getattr(opened, name) for name in identity_fields):
            deny("CLEANUP_INPUT_CHANGED", file)
        raw = stream.read(MAX_CLEANUP_REQUEST_BYTES + 1)
        opened_after = os.fstat(stream.fileno())
    record = decode_request(raw)
    after = os.lstat(file)
    if any(getattr(before, name) != getattr(after, name) or getattr(opened, name) != getattr(opened_after, name) for name in fields):
        deny("CLEANUP_INPUT_CHANGED", file)
    target = record.get("target")
    if not isinstance(target, dict) or frozen_target_digest(target) != expected or record.get("root") != root or record.get("rootIdentity") != request.get("rootIdentity") \
            or record.get("operationId") != request.get("operationId") or record.get("action") != request.get("cleanupAction") or record.get("managedInner") is not True:
        deny("CLEANUP_INPUT_CHANGED", file)
    if any(target.get(name) != request["target"].get(name) for name in
           ("relativePath", "destination", "type", "fingerprint", "contentFingerprint", "inode", "fingerprintMode", "authorizationMode")):
        deny("CLEANUP_INPUT_CHANGED", file)
    return target


def managed_observe(request):
    root, identity = root_guard(request["root"])
    if identity != request.get("rootIdentity"):
        deny("ROOT_IDENTITY_CHANGED")
    key, target = managed_key(request), request["target"]
    archived_source = request["cleanupAction"] == "restore" or archived_control_rel(target) is not None
    source = path_guard(root, target["relativePath"], archived_source, True)
    destination = path_guard(root, target["destination"], True, True)
    executor = None
    inventory = "" if request.get("localObservation") else managed_tmux(["list-panes", "-a", "-F", "#{window_id}\t#{pane_id}\t#{pane_dead}\t#{pane_dead_status}\t#{@sftp_cleanup}"])
    for line in inventory.splitlines():
        fields = line.split("\t")
        if len(fields) == 5 and fields[4] == key:
            executor = {"windowId": fields[0], "paneId": fields[1], "dead": fields[2] == "1",
                        "exitCode": int(fields[3]) if re.fullmatch(r"-?\d+", fields[3]) else None}
            if not executor["dead"]:
                break
    # A persisted completion identity is authoritative even while the bound
    # pane lingers: never re-delete and never re-capture a recreated canonical
    # directory as this operation's source.
    if not request.get("localObservation"):
        receipt = read_control_json(root, completion_control_rel(key), 4096)
        if receipt is not None and (receipt.get("schemaVersion") != 1 or receipt.get("cleanupKey") != key
                or receipt.get("operationId") != request.get("operationId") or receipt.get("action") != request.get("cleanupAction")
                or receipt.get("state") != "completed"):
            deny("CLEANUP_INPUT_CHANGED")
        if receipt is not None:
            answer = {"ok": True, "state": "completed", "verifiedBy": "completion_receipt", "irreversible": request["cleanupAction"] == "delete",
                      "finalizePending": bool(executor and not executor["dead"]), "rootIdentity": identity, "executor": executor}
            completion = receipt.get("completion")
            if isinstance(completion, dict) and request.get("cleanupAction") == "isolate":
                # The persisted move-moment facts, echoed verbatim through the
                # whitelist. They describe THIS node at move time and are
                # never re-derived from the current filesystem here.
                answer["completion"] = {name: completion[name] for name in ISOLATION_COMPLETION_KEYS if name in completion}
            return answer
    if request.get("frozenTargetDigest") and (executor and not executor["dead"] or os.path.lexists(source)):
        frozen = frozen_observation_target(root, request, key)
        if frozen is None:
            if executor and not executor["dead"]:
                return {"ok": True, "state": "executing", "executor": executor, "rootIdentity": identity, "progress": None}
            return {"ok": True, "state": "unknown", "code": "CLEANUP_FROZEN_INPUT_MISSING", "rootIdentity": identity}
        target = frozen
    if executor and not executor["dead"]:
        progress = managed_delete_progress(root, target) if request["cleanupAction"] == "delete" else None
        return {"ok": True, "state": "executing", "executor": executor, "rootIdentity": identity, "progress": progress}
    if not os.path.lexists(source):
        if request["cleanupAction"] == "delete":
            return {"ok": True, "state": "completed", "verifiedBy": "source_absence", "irreversible": True, "rootIdentity": identity, "executor": executor}
        if not os.path.lexists(destination):
            return {"ok": True, "state": "partial", "code": "SOURCE_AND_DESTINATION_MISSING", "rootIdentity": identity, "executor": executor}
        if target.get("fingerprintMode") == "top_level":
            after = top_identity(destination, target["type"])
            if after["inode"] != target.get("inode") or after["device"] != target.get("device"):
                return {"ok": True, "state": "changed", "code": "DESTINATION_CHANGED", "rootIdentity": identity, "executor": executor}
            return {"ok": True, "state": "completed", "verifiedBy": "destination_identity", "rootIdentity": identity, "executor": executor}
        value = contents(root, destination, target["type"])
        if value["contentFingerprint"] != target["contentFingerprint"] or value["inode"] != target["inode"]:
            return {"ok": True, "state": "changed", "code": "DESTINATION_CHANGED", "rootIdentity": identity, "executor": executor}
        return {"ok": True, "state": "completed", "verifiedBy": "destination_identity", "rootIdentity": identity, "executor": executor}
    if target.get("fingerprintMode") == "top_level":
        proven = frozen_isolation_completion(root, target, destination)
        if proven is not None:
            # The canonical source reappeared as new-run data while no receipt
            # was readable (crash before finalize): the frozen binding keeps
            # this isolation completed; nothing on the new path is touched.
            return {"ok": True, "state": "completed", "verifiedBy": proven, "rootIdentity": identity, "executor": executor}
        value = isolate_inspect(root, target, request.get("operationId"))
    elif target.get("chunked") is True and request["cleanupAction"] == "delete" and archived_control_rel(target) is not None:
        # Pending observation of a chunked deletion stays bounded: it reports
        # the frozen summary watermark instead of walking the archive again.
        manifest = chunked_manifest_read(root, manifest_key(request.get("operationId"), archived_control_rel(target), target["destination"]), "summary.json")
        return {"ok": True, "state": "pending", "rootIdentity": identity, "executor": executor, "chunked": True,
                "applied": manifest.get("applied", 0) if isinstance(manifest, dict) else 0, "count": target.get("count")}
    else:
        value = inspect(root, target, archived_source)
    state = "pending" if value["fingerprint"] == target["fingerprint"] else "changed"
    return {"ok": True, "state": state, "rootIdentity": identity, "executor": executor}


def runtime_prepare(request):
    # First-install/upgrade of the single new deletion engine into the existing
    # protected program area: content-addressed, exclusive create, byte + hash
    # verified; an unknown same-name file is refused, never overwritten.
    source = request.get("runtimeSource")
    sha = request.get("runtimeSha256")
    if not isinstance(source, str) or not isinstance(sha, str) or not re.fullmatch(r"[a-f0-9]{64}", sha):
        deny("INVALID_REQUEST")
    code = source.encode("utf-8")
    if len(code) > 262144 or hashlib.sha256(code).hexdigest() != sha:
        deny("RUNTIME_CODE_MISMATCH")
    root, identity = root_guard(request["root"])
    if request.get("rootIdentity") is not None and identity != request["rootIdentity"]:
        deny("ROOT_IDENTITY_CHANGED")
    os.makedirs(path_guard(root, "clean_dir/.operations/managed", True, True), exist_ok=True)
    name = "clean_dir/.operations/managed/runtime-" + sha + ".py"
    full = path_guard(root, name, True, True)

    def verified():
        st = os.lstat(full)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size != len(code):
            deny("RUNTIME_PROGRAM_MISMATCH", full)
        with open(full, "rb") as handle:
            if handle.read() != code:
                deny("RUNTIME_PROGRAM_MISMATCH", full, "程序区域已有不同身份的同名文件，拒绝覆盖")
    if os.path.lexists(full):
        verified()
        return {"ok": True, "state": "verified", "runtimeSha256": sha, "programRelativePath": name, "rootIdentity": identity}
    try:
        with open(full, "xb") as handle:
            handle.write(code)
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError:
        verified()
        return {"ok": True, "state": "verified", "runtimeSha256": sha, "programRelativePath": name, "rootIdentity": identity}
    return {"ok": True, "state": "installed", "runtimeSha256": sha, "programRelativePath": name, "rootIdentity": identity}


def managed_start(request):
    prefix = str(request.get("tmuxSessionPrefix") or "simple").strip()
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,31}", prefix):
        deny("INVALID_TMUX_SESSION_PREFIX")
    proof = managed_observe(request)
    if proof["state"] in ("executing", "completed"):
        return proof
    if proof["state"] != "pending":
        deny("CLEANUP_TARGET_CHANGED")
    root, _ = root_guard(request["root"])
    key = managed_key(request)
    # Immutable confirmed input is an audit asset, never a live state record.
    # The window may only execute the verified program already pinned in the
    # managed program area (installed by runtime-prepare), never a request-
    # supplied source and never an argv-embedded copy of the engine.
    program = os.path.abspath(__file__) if "__file__" in globals() else ""
    pinned = RUNTIME_PROGRAM_RE.fullmatch(os.path.basename(program)) if program else None
    managed_dir = path_guard(root, "clean_dir/.operations/managed", True)
    if not pinned or os.path.normcase(os.path.dirname(program)) != os.path.normcase(managed_dir):
        deny("RUNTIME_PROGRAM_REQUIRED", program, "清理托管窗口只能由已固化的受验程序路径启动")
    code_name = "clean_dir/.operations/managed/" + pinned.group(0)
    code_full = path_guard(root, code_name, True)
    with open(code_full, "rb") as handle:
        if hashlib.sha256(handle.read()).hexdigest() != pinned.group(1):
            deny("RUNTIME_CODE_MISMATCH", code_full)
    command = {name: request[name] for name in ("root", "rootIdentity", "operationId", "target")}
    command.update(action=request["cleanupAction"], managedInner=True)
    input_name = "clean_dir/.operations/managed/" + key + ".json"
    full = path_guard(root, input_name, True, True)
    data = json.dumps(command, ensure_ascii=False, sort_keys=True).encode("utf-8")
    if os.path.lexists(full):
        with open(full, "rb") as handle:
            if handle.read() != data:
                deny("CLEANUP_INPUT_CHANGED")
    else:
        with open(full, "xb") as handle:
            handle.write(data)
    session = prefix + "-clean-" + digest(root)[:16]
    if subprocess.run(["tmux", "has-session", "-t", session], capture_output=True, timeout=3).returncode:
        managed_tmux(["new-session", "-d", "-s", session])
    # The window must never reach completion before the parent publishes its
    # options: a pane that finished under remain-on-exit=off and was flagged
    # on afterwards lingers dead forever. The wrapper waits (bounded) for the
    # exact binding, then execs the engine.
    launch = ("for i in $(seq 1 500); do [ -n \"$(tmux display-message -p -t \"$TMUX_PANE\" '#{@sftp_cleanup}')\" ] && break; sleep 0.01; done; exec "
              + shlex.join([sys.executable, "-B", "-X", "utf8", path_guard(root, code_name, True)]) + " < " + shlex.quote(path_guard(root, input_name, True)))
    # The parent holds the existing mutation lock until window binding is published;
    # the child acquires that same lock before touching any approved target.
    pane = managed_tmux(["new-window", "-d", "-t", session, "-n", "cleanup-" + key[:12], "-c", root,
                         "-P", "-F", "#{pane_id}", "--", "bash", "-c", launch])
    managed_tmux(["set-option", "-w", "-t", pane, "remain-on-exit", "on"])
    managed_tmux(["set-option", "-w", "-t", pane, "@sftp_cleanup", key])
    binding = {"root": root, "operationId": request["operationId"], "relativePath": request["target"]["relativePath"],
               "destination": request["target"]["destination"]}
    managed_tmux(["set-option", "-w", "-t", pane, "@sftp_cleanup_target", base64.urlsafe_b64encode(json.dumps(binding).encode("utf-8")).decode("ascii")])
    return {"ok": True, "state": "requested", "rootIdentity": request["rootIdentity"]}


def main(request):
    root, identity = root_guard(request["root"])
    if request.get("action") == "check-isolation-parents":
        entries = request.get("entries") or []
        allowed = set(isolation_parent_paths(request.get("destinations")))
        if any(row.get("relativePath") not in allowed for row in entries):
            deny("EMPTY_ISOLATION_SCOPE_INVALID")
        return {"ok": True, "rootIdentity": identity, "state": "completed" if all(
            not os.path.lexists(path_guard(root, row["relativePath"], True, True)) for row in entries) else "unknown"}
    if request.get("action") == "inspect-isolation-parents":
        return inspect_isolation_parents(root, identity, request)
    if request.get("action") == "prune-isolation-parents":
        return prune_isolation_parents(root, identity, request)
    expected_owner = request.get("target", {}).get("expectedOwner")
    if expected_owner is not None and not isinstance(expected_owner, dict):
        deny("OWNERSHIP_UNVERIFIED")
    action = request["action"]
    if action == "runtime-prepare":
        return runtime_prepare(request)
    if action == "batch-inspect":
        return batch_inspect(root, identity, request)
    if action == "batch-verify":
        return batch_verify(root, identity, request)
    if action == "batch-observe":
        return batch_observe(root, identity, request)
    if action == "delete-fast":
        return delete_fast(root, identity, request)
    if request.get("target", {}).get("authorizationMode") == "confirmed_paths":
        if action in ("move", "restore", "settle", "isolate") or action in ("managed-start", "managed-observe") and request.get("cleanupAction") != "delete":
            deny("INVALID_AUTHORIZATION_MODE")
        if action == "delete" or action == "managed-start" and request.get("cleanupAction") == "delete":
            # v1.9 keeps exactly one confirmed-path production executor; the old
            # frozen-inventory and managed-window deletion routes are retired
            # instead of silently falling back to them.
            deny("UPDATE_REQUIRED", "", "确认路径永久删除已切换为入口绑定的隔离式快速链（delete-fast），请更新 SimpleSFTP 端后重试")
    if action == "managed-observe":
        return managed_observe(request)
    if action == "managed-start":
        return managed_start(request)
    if action not in ("check", "verify", "inventory", "inspect", "isolate", "move", "delete", "restore", "settle"):
        deny("UNKNOWN_ACTION")
    if action == "inventory":
        target = request["target"]
        full = path_guard(root, target["relativePath"], missing=request.get("allowMissing") is True)
        checked_parent(root, full)
        live = {"executorsChecked": True, "executors": current_cleanup_executors(root, full)} if request.get("observeExecutors") else {}
        if not os.path.lexists(full):
            return {"ok": True, "rootIdentity": identity, **live, "target": {"missing": True, "type": target["type"], "absolutePath": full}}
        if request.get("presenceOnly"):
            actual = os.lstat(full)
            if not (target["type"] == "directory" and stat.S_ISDIR(actual.st_mode) or target["type"] == "file" and stat.S_ISREG(actual.st_mode)):
                deny("TYPE_CHANGED")
            return {"ok": True, "rootIdentity": identity, **live, "target": {"missing": False, "type": target["type"], "absolutePath": full}}
        if request.get("manifestOnly"):
            if target["type"] != "directory" or not os.path.isdir(full):
                deny("TYPE_CHANGED")
            inventory = []
            for name in ("artifact_manifest.json", "formal_job_owner.json", "run_wrapper_report.json", "checkpoint_manifest.json", "config.yaml", "config_snapshot.yaml"):
                file = path_guard(root, target["relativePath"] + "/" + name, True, True)
                if not os.path.isfile(file) or os.path.getsize(file) > 1024 * 1024:
                    continue
                row = contents(root, file, "file")["inventory"][0]
                inventory.append({**row, "path": name})
            return {"ok": True, "rootIdentity": identity, **live, "target": {"type": "directory", "absolutePath": full,
                "manifests": manifest_records(root, full, {"inventory": inventory})}}
        value = contents(root, full, target["type"])
        value["manifests"] = manifest_records(root, full, value)
        if (target.get("expectedOwner") or {}).get("resultPathPolicy") == "declared":
            owner_hash = formal_cleanup_owner(root, target, target["expectedOwner"])
            value["formalOwnerSha256"] = owner_hash
            value["fingerprint"] = digest({"target": value["fingerprint"], "formalOwnerSha256": owner_hash})
        return {"ok": True, "rootIdentity": identity, **live, "target": {**value, "absolutePath": full}}
    if action in ("check", "settle", "verify"):
        if request.get("rootIdentity") and request["rootIdentity"] != identity:
            deny("ROOT_IDENTITY_CHANGED")
        target = request["target"]
        archived_rel = archived_control_rel(target)
        already_deleted = False
        if archived_rel is not None:
            archived_state = isolation_state(root, archived_rel)
            already_deleted = bool(archived_state and archived_state.get("state") == "deleted")
        source = path_guard(root, target["relativePath"], archived_rel is not None, True)
        destination = path_guard(root, target["destination"], True, True)
        if already_deleted:
            # A finished permanent deletion stays completed even if the same
            # name reappears; a rebuilt path never authorizes re-deletion.
            return {"ok": True, "state": "completed", "verifiedBy": "isolation_deleted", "irreversible": True, "rootIdentity": identity}
        if os.path.lexists(source):
            proven_isolation = target.get("fingerprintMode") == "top_level" and frozen_isolation_completion(root, target, destination)
            if proven_isolation and action == "check":
                # The frozen binding proves the isolation finished before the
                # new run recreated the canonical path; that new data never
                # revokes the completed operation.
                return {"ok": True, "state": "completed", "verifiedBy": proven_isolation, "rootIdentity": identity}
            if not proven_isolation:
                if action == "check":
                    if target.get("chunked") is True and archived_rel is not None:
                        # Bounded resumable proof: the frozen summary watermark,
                        # never a full re-walk, answers a chunked preflight.
                        manifest = chunked_manifest_read(root, manifest_key(request.get("operationId"), archived_rel, target["destination"]), "summary.json")
                        return {"ok": True, "state": "pending", "rootIdentity": identity, "chunked": True,
                                "applied": manifest.get("applied", 0) if isinstance(manifest, dict) else 0, "count": target.get("count")}
                    if target.get("fingerprintMode") == "top_level":
                        value = isolate_inspect(root, target, request.get("operationId"))
                    else:
                        value = inspect(root, target) if target.get("authorizationMode") == "confirmed_paths" or (target.get("expectedOwner") or {}).get("resultPathPolicy") == "declared" else contents(root, source, target["type"])
                    if value["fingerprint"] != target["fingerprint"]:
                        deny("SOURCE_RECREATED_OR_CHANGED")
                    if os.path.lexists(destination):
                        deny("DESTINATION_EXISTS")
                    return {"ok": True, "state": "pending", "rootIdentity": identity}
                deny("SOURCE_RECREATED_OR_NOT_MOVED")
            # settle/verify of a proven isolation continue below to the frozen
            # destination verification and idempotent record repair; the
            # recreated source itself is never read, moved or deleted.
        if request.get("deleted") is True:
            if action == "check":
                return {"ok": True, "state": "completed" if request.get("receiptCompleted") is True else "absent_unverified", "rootIdentity": identity}
            return {"ok": True, "irreversible": True}
        if target.get("fingerprintMode") == "top_level" and not os.path.lexists(destination):
            registered = isolation_state(root, os.path.relpath(destination, root).replace(os.sep, "/"))
            if registered and registered.get("state") == "deleted":
                # The isolated subtree already finished its user-confirmed
                # permanent deletion: that proves (and closes) the isolation.
                return {"ok": True, "state": "completed", "verifiedBy": "isolation_deleted", "irreversible": True, "rootIdentity": identity}
        if not os.path.lexists(destination):
            deny("RECEIPT_UNVERIFIED")
        if target.get("fingerprintMode") == "top_level":
            value = top_identity(destination, target["type"])
            if value["inode"] != target.get("inode") or value["device"] != target.get("device"):
                deny("CONTENT_CHANGED")
        else:
            value = contents(root, destination, target["type"])
            if value["contentFingerprint"] != target["contentFingerprint"] or value["inode"] != target["inode"]:
                deny("CONTENT_CHANGED")
        if action == "check":
            return {"ok": True, "state": "completed", "rootIdentity": identity}
        if action == "settle":
            if target.get("fingerprintMode") == "top_level":
                # Crash-window repair: the rename committed but the completion
                # record never did. Trust only the frozen binding; re-register
                # idempotently, never re-move and never auto-rollback.
                destination_rel = os.path.relpath(destination, root).replace(os.sep, "/")
                if isolation_state(root, destination_rel) is None:
                    register_isolation(root, destination_rel, relative(target["relativePath"]), request["operationId"],
                                       {"type": target["type"], "inode": target.get("inode")}, time.time())
            audit(root, {"operationId": request["operationId"], "action": request.get("settledAction", "move"), "phase": "completed-after-settlement",
                         "source": source, "destination": destination,
                         **({"fingerprintMode": "top_level", "fingerprint": target.get("fingerprint")} if target.get("fingerprintMode") == "top_level" else value)})
        return {"ok": True, "rootIdentity": identity, "receipt": ({"fingerprintMode": "top_level", "fingerprint": target.get("fingerprint"), "destination": value}
                                                                  if target.get("fingerprintMode") == "top_level" else value)}
    target = request["target"]
    if request.get("isolate") is True:
        if action != "inspect":
            deny("INVALID_REQUEST")
        # Per-backend version fact for the background-delete chain: the JS
        # side only advertises safety.backgroundIsolatedDelete when EVERY
        # isolate inspect of this backend answered with this flag. An older
        # engine keeps the old downgrade chain honest.
        # 0.2.114: staged-slot inspects additionally answer THIS engine's support for the
        # user-confirmed early release (requireExpired:false recheck mode) with the same
        # per-backend proof discipline; anything else (or an older engine) stays silent.
        return {"ok": True, "rootIdentity": identity, "backgroundIsolatedDelete": 1,
                **({"userConfirmedSlotRelease": 1}
                   if STAGED_SLOT_REL_RE.match(str(target.get("relativePath") or "")) else {}),
                "target": isolate_inspect(root, target, request.get("operationId"))}
    if action == "isolate":
        batch = target.get("archiveBatch")
        if batch is None or not isinstance(batch, str) or not re.fullmatch(r"job-[a-f0-9]{48}", batch):
            deny("UNSAFE_ARCHIVE_BATCH")
        if target.get("destination") != "clean_dir/" + batch + "/" + target["relativePath"]:
            deny("UNSAFE_DESTINATION")
        # ONE live pre-write authorization (top-level identity, ownership,
        # required inputs, node-local executor sweep). The former second full
        # isolate_inspect sat a few syscalls before the rename, re-read the
        # same fixed-name manifests and the same git status, and added no
        # protection a racing writer could not bypass anyway; it is removed.
        # What still re-runs immediately before the mutation is exactly the
        # structural set: destination non-overwrite, path_guard and the
        # verified direct parent. A lost response stays unknown: the caller
        # settles through the frozen binding and never re-sends this rename.
        value = isolate_inspect(root, target, request.get("operationId"))
        record = {"operationId": request["operationId"], "action": "isolate", "source": value["absolutePath"], "destination": value["destination"],
                  "type": target["type"], "fingerprint": value["fingerprint"], "sourceRelativePath": target["relativePath"], "time": time.time()}
        audit(root, {**record, "phase": "intent"})
        path_guard(root, target["destination"], True, True)
        if os.path.lexists(value["destination"]):
            deny("DESTINATION_EXISTS", value["destination"])
        make_isolation_parents(root, value["destination"])
        path_guard(root, target["destination"], True, True)
        child = parent_cd(root, value["absolutePath"])
        # Staged slots additionally prove the slot lock is FREE at THIS rename moment
        # (held across the rename until the source name is gone), closing the window
        # between an earlier preview and the mutation; a racing claim keeps its flock
        # and this isolation refuses instead of moving an active checkpoint.
        slot_lock = staged_slot_lock(root, target)
        try:
            # Reclaim-bound isolations re-prove the FULL expiry eligibility here — identity,
            # generation, committed status, terminal moment and age against the CURRENT journal,
            # under the held slot lock and before the rename (a free lock alone proves nothing
            # about the journal); an unbound isolate keeps exactly the previous lock-only gate.
            if request.get("stagedJournal") is not None:
                verify_staged_journal_binding(root, target, request["stagedJournal"])
            # Exactly one atomic rename; a missing no-replace primitive or a
            # cross-filesystem target fails closed, never degrades to a copy.
            no_replace(child, value["destination"])
            # Completion proof for this move: the atomic no-replace rename
            # committed, the source name is absent in this very move, the
            # registration lands, and the durable completion audit line below
            # closes the record. The isolated copy itself is NOT re-read here;
            # this receipt never claims the isolated content was re-verified.
            if os.path.lexists(value["absolutePath"]):
                deny("SOURCE_STILL_EXISTS")
        finally:
            release_staged_slot_lock(slot_lock)
        destination_rel = os.path.relpath(value["destination"], root).replace(os.sep, "/")
        completion = {"isolationCompletionProtocol": 1, "archiveBatch": batch,
                      "sourceRelativePath": target["relativePath"], "destinationRelativePath": target["destination"],
                      "renameCommitted": True, "sourceMissingAtMove": True, "registered": True,
                      "executorsChecked": True, "executors": value["executors"]}
        register_isolation(root, destination_rel, relative(target["relativePath"]),
                           request["operationId"], value, time.time(), completion)
        audit(root, {**record, "phase": "completed"})
        return {"ok": True, "rootIdentity": identity, "receipt": {**record, "phase": "completed", **completion}}
    archived_control = archived_control_rel(target)
    if archived_control is not None and action == "delete":
        archived_state = isolation_state(root, archived_control)
        if archived_state and archived_state.get("state") == "deleted":
            # Replay of a completed permanent deletion: minimal identity only.
            return {"ok": True, "rootIdentity": identity, "alreadyDeleted": True, "state": "completed", "verifiedBy": "isolation_deleted"}
        if not archived_state or archived_state.get("state") != "isolated":
            deny("NOT_REGISTERED_ISOLATION", archived_control, "只有已登记的隔离产物子树可以经确认路径永久删除")
        if target.get("chunked") is True:
            # >50000-entry registered archives run only through the bounded
            # frozen chunk manifest; the single-pass inventory path is closed.
            return chunked_permanent_delete(root, request, identity)
    archived = action == "restore" or (action == "inspect" and request.get("archived") is True) \
        or (archived_control is not None and action in ("inspect", "delete"))
    if action == "inspect":
        full = path_guard(root, target["relativePath"], archived, True)
        checked_parent(root, full)
        if not os.path.lexists(full):
            return {"ok": True, "rootIdentity": identity, "target": {"missing": True, "type": target["type"], "absolutePath": full}}
        if archived and archived_control is not None and target.get("authorizationMode") == "confirmed_paths" and target["type"] == "directory":
            # A registered archive may exceed the single-message inventory cap.
            # The frozen walk streams: process memory is bounded regardless of
            # archive size, and for a >50000 scope the preview returns only the
            # bounded frozen summary. The frozen digest (not any file list) is
            # what both confirmations bind to.
            expected = target.get("inventory") or ()
            shared = {(row.get("device"), row.get("inode")) for row in expected if row.get("hardlink") is True}
            count, frozen_fingerprint, rows = stream_frozen_preview(root, full, shared,
                                                                    MAX_FROZEN_MANIFEST_ENTRIES, CHUNKED_MANIFEST_THRESHOLD + 1)
            actual = os.lstat(full)
            if count > CHUNKED_MANIFEST_THRESHOLD:
                return {"ok": True, "rootIdentity": identity, "target": {"type": "directory", "absolutePath": full, "chunked": True,
                        "count": count, "fingerprint": frozen_fingerprint, "device": str(actual.st_dev), "inode": str(actual.st_ino)}}
            content = [{k: v for k, v in row.items() if k not in ("mtime", "device", "inode")} for row in rows]
            value = {"type": "directory", "size": sum(row.get("size", 0) for row in rows), "fingerprint": digest(rows),
                     "contentFingerprint": digest(content), "inventory": rows, "device": str(actual.st_dev), "inode": str(actual.st_ino),
                     "fingerprintMode": "metadata", "references": [], "manifests": [], "handleWarnings": [],
                     "absolutePath": full, "parent": os.path.dirname(full), "leaf": os.path.basename(full),
                     "destination": path_guard(root, target["destination"], True, True)}
            return {"ok": True, "rootIdentity": identity, "target": value}
    value = inspect(root, target, archived)
    if action == "inspect":
        return {"ok": True, "rootIdentity": identity, "target": value}
    if identity != request["rootIdentity"] or value["fingerprint"] != target["fingerprint"]:
        deny("PREVIEW_CHANGED")
    batch = target.get("archiveBatch")
    if batch is not None and (not isinstance(batch, str) or not re.fullmatch(r"job-[a-f0-9]{48}", batch)):
        deny("UNSAFE_ARCHIVE_BATCH")
    archive_prefix = "clean_dir/" + (batch + "/" if batch else "")
    if archived_control is not None and action == "delete":
        if target["destination"] != archived_control:
            deny("UNSAFE_DESTINATION")
    elif action in ("move", "delete") and target["destination"] != archive_prefix + target["relativePath"]:
        deny("UNSAFE_DESTINATION")
    if action == "restore" and (not target["relativePath"].startswith(archive_prefix) or target["destination"] != target["relativePath"][len(archive_prefix):]):
        deny("UNSAFE_DESTINATION")
    record = {"operationId": request["operationId"], "action": action, "source": value["absolutePath"], "destination": value["destination"], "type": target["type"], "fingerprint": value["fingerprint"], "contentFingerprint": value["contentFingerprint"], "inventory": value["inventory"], "time": time.time()}
    if target.get("authorizationMode") != "confirmed_paths":
        audit(root, {**record, "phase": "intent"})
    # Repeat after durable intent; no stale inspection authorizes mutation.
    checked = inspect(root, target, archived)
    if checked["fingerprint"] != value["fingerprint"]:
        deny("CONTENT_CHANGED")
    if action == "delete":
        # C4: only a registered isolated artifact subtree may be deleted
        # metadata-only through the confirmed-path flow; the traversal may
        # therefore walk clean_dir, while the control regions were refused
        # above and the frozen inventory can never expand.
        archived_clean = archived_control is not None
        if target["type"] == "file":
            delete_file(root, value["absolutePath"], value["inventory"][0], metadata_only=target.get("authorizationMode") == "confirmed_paths", allow_clean=archived_clean)
        elif target["type"] == "directory":
            path_only = target.get("authorizationMode") == "confirmed_paths"
            delete_directory(root, value["absolutePath"], value["inventory"], metadata_only=path_only,
                             nested_git_root=value["absolutePath"] if path_only else None, allow_clean=archived_clean)
        else:
            deny("UNCERTAIN_TYPE")
    else:
        path_guard(root, target["destination"], True, True)
        os.makedirs(os.path.dirname(value["destination"]), exist_ok=True)
        path_guard(root, target["destination"], True, True)
        child = parent_cd(root, value["absolutePath"])
        no_replace(child, value["destination"])
        after = contents(root, value["destination"], target["type"])
        if after["contentFingerprint"] != value["contentFingerprint"] or after["inode"] != value["inode"]:
            deny("MOVE_VERIFICATION_FAILED")
    if os.path.lexists(value["absolutePath"]):
        deny("SOURCE_STILL_EXISTS")
    if archived_control is not None and action == "delete":
        # Separate lifecycles: the pending isolation mapping ends here with a
        # minimal opaque completion identity; no frozen list or fingerprint stays.
        write_control_json(root, isolation_control_rel(archived_control), {"schemaVersion": 1, "state": "deleted",
                                                                           "operationId": request["operationId"], "destination": archived_control, "deletedAt": time.time()})
    if action == "restore" and ARCHIVED_BATCH_RE.match(target["relativePath"]):
        restored_state = isolation_state(root, target["relativePath"])
        if restored_state and restored_state.get("state") == "isolated":
            write_control_json(root, isolation_control_rel(target["relativePath"]), {"schemaVersion": 1, "state": "restored",
                                                                                     "operationId": request["operationId"], "destination": target["relativePath"], "restoredAt": time.time()})
    if target.get("authorizationMode") != "confirmed_paths":
        audit(root, {**record, "phase": "completed"})
    return {"ok": True, "rootIdentity": identity, "receipt": {**record, "phase": "completed"}}


if __name__ == "__main__":
    lock = None
    locks = []
    request = {}
    checked_root = None
    try:
        # A pinned program file may only run when its bytes still match the
        # identity embedded in its name; tampering fails before any request is
        # read, so a mutated runtime never touches a target.
        program = os.path.abspath(__file__) if "__file__" in globals() else ""
        pinned = RUNTIME_PROGRAM_RE.fullmatch(os.path.basename(program)) if program else None
        if pinned:
            with open(program, "rb") as stream:
                if hashlib.sha256(stream.read()).hexdigest() != pinned.group(1):
                    deny("RUNTIME_CODE_MISMATCH", program)
        raw = sys.stdin.buffer.read(MAX_CLEANUP_REQUEST_BYTES + 1).rstrip(b"\x00")
        request = decode_request(raw)
        action = request.get("action")
        if action in ("move", "delete", "restore", "settle", "isolate", "managed-start", "delete-fast", "prune-isolation-parents"):
            checked_root, _ = root_guard(request["root"])
        if action == "managed-start":
            # C2: the root lock stays a short control transaction covering the
            # frozen input write and exact window admission only.
            deadline = time.monotonic() + (3 if request.get("managedInner") else 0)
            while True:
                try:
                    lock = mutation_lock(checked_root)
                    break
                except GuardError as error:
                    if error.code != "OPERATION_BUSY" or time.monotonic() >= deadline:
                        raise
                    time.sleep(0.02)
        elif action in ("delete-fast", "prune-isolation-parents"):
            entries = request.get("entries") or []
            rels = [entry.get("relativePath") for entry in entries if isinstance(entry, dict)] \
                if isinstance(entries, list) else []
            rels = [value for value in rels if isinstance(value, str) and value]
            deadline = time.monotonic() + 3
            while True:
                try:
                    locks = acquire_target_locks(checked_root, rels)
                    break
                except GuardError as error:
                    if error.code != "OPERATION_BUSY" or time.monotonic() >= deadline:
                        raise
                    time.sleep(0.02)
        elif action in ("move", "delete", "restore", "settle", "isolate"):
            # C2: long traversals hold only the exact isolation subtree chain,
            # so a background deletion never parks the next foreground isolate.
            target = request.get("target") or {}
            rels = [value for value in (target.get("relativePath"),
                                        None if action == "delete" else target.get("destination"))
                    if isinstance(value, str) and value]
            deadline = time.monotonic() + (3 if request.get("managedInner") else 0)
            while True:
                try:
                    locks = acquire_target_locks(checked_root, rels)
                    break
                except GuardError as error:
                    if error.code != "OPERATION_BUSY" or time.monotonic() >= deadline:
                        raise
                    time.sleep(0.02)
        result = main(request)
        # C3: the server-side wrapper finalizes its own exact pane. The minimal
        # anti-replay completion identity is persisted before the window is
        # released; failure keeps remain-on-exit on and the window preserved.
        if request.get("managedInner") is True and result.get("ok") and action in ("delete", "move", "restore", "isolate"):
            completion = None
            if action == "isolate" and isinstance(result.get("receipt"), dict) \
                    and result["receipt"].get("isolationCompletionProtocol") == 1:
                candidate = {name: result["receipt"][name] for name in ISOLATION_COMPLETION_KEYS if name in result["receipt"]}
                # The bounded control read keeps its 4096-byte limit; an
                # oversized completion echo is simply omitted (the isolated
                # copy then keeps the older review chain), never truncated.
                if len(json.dumps(candidate, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) <= 3072:
                    completion = candidate
            try:
                result["finalize"] = finalize_managed_window(checked_root, request, completion)
            except GuardError as error:
                result["finalize"] = {"finalized": False, "receiptWritten": False, "code": error.code}
    except GuardError as error:
        result = {"ok": False, "error": {"code": error.code, "message": str(error),
                  **({"blockingPath": error.blocking_path} if error.blocking_path else {}),
                  **({"reason": error.reason} if error.reason else {})}}
    except PermissionError as error:
        result = {"ok": False, "error": {"code": "PERMISSION_DENIED", "message": "Permission denied", "reason": "没有权限读取或修改该路径",
                  **({"blockingPath": error.filename} if error.filename and os.path.isabs(error.filename) else {})}}
    except Exception as error:
        result = {"ok": False, "error": {"code": "INSPECTION_OR_AUDIT_FAILED", "message": type(error).__name__,
                  **({"blockingPath": error.filename, "reason": str(error.strerror or type(error).__name__)}
                     if isinstance(error, OSError) and error.filename and os.path.isabs(error.filename) else {})}}
    finally:
        for stream in locks:
            stream.close()
        if lock is not None:
            lock.close()
    if request.get("action") == "delete-fast" and not result.get("ok"):
        # Explicit transport fact for every failure envelope of a fast batch:
        # whether any mutation syscall of this process had already begun. It is
        # set immediately before each rename/unlink/rmdir, so false proves a
        # zero-mutation refusal while true marks a partial or unknown state.
        result["error"].setdefault("mutationStarted", FAST_MUTATION_FACTS["started"])
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    if request.get("managedInner") and not result.get("ok"):
        sys.exit(1)
