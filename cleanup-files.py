"""Restricted file lifecycle executor. Input/output are bounded UTF-8 JSON.

No discovery by name, shell deletion, overwrite, or implicit cancellation.
Authorization and all-node ordering belong to the cleanup coordinator.
"""
import ctypes
import hashlib
import json
import os
import re
import socket
import stat
import subprocess
import sys
import time


class GuardError(Exception):
    def __init__(self, code, detail=""):
        self.code = code
        super().__init__(detail or code)


def deny(code, detail=""):
    raise GuardError(code, detail)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()


def below(root, value):
    root, value = os.path.normcase(root), os.path.normcase(value)
    return value != root and os.path.commonpath((root, value)) == root


def mount_points():
    if not os.path.exists("/proc/self/mountinfo"):
        return set()
    with open("/proc/self/mountinfo", "r", encoding="utf-8") as stream:
        return {os.path.abspath(re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), line.split()[4])) for line in stream if len(line.split()) > 4}


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


def path_guard(root, rel, allow_clean=False, missing=False):
    relative(rel)
    parts = rel.split("/")
    if ".git" in [p.lower() for p in parts] or (not allow_clean and "clean_dir" in [p.lower() for p in parts]):
        deny("PROTECTED_PATH")
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


def contents(root, full, expected_type):
    st = os.lstat(full)
    actual = "directory" if stat.S_ISDIR(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else "unknown"
    if actual != expected_type:
        deny("TYPE_CHANGED")
    rows = []
    mounts = mount_points()
    def visit(value, name):
        info = os.lstat(value)
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 1024:
            deny("LINK_OR_REPARSE_POINT", value)
        if info.st_dev != st.st_dev or (value != full and (os.path.ismount(value) or value in mounts)):
            deny("MOUNT_ESCAPE", value)
        if stat.S_ISDIR(info.st_mode):
            rows.append({"path": name, "type": "directory", "device": str(info.st_dev), "inode": str(info.st_ino)})
            for leaf in sorted(os.listdir(value)):
                relative(leaf)
                if leaf.lower() in (".git", "clean_dir"):
                    deny("PROTECTED_DESCENDANT", value)
                visit(os.path.join(value, leaf), name + "/" + leaf if name else leaf)
        elif stat.S_ISREG(info.st_mode):
            if info.st_nlink != 1:
                deny("SHARED_HARDLINK", value)
            h = hashlib.sha256()
            with open(value, "rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    h.update(block)
            after = os.lstat(value)
            if (info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                deny("CONTENT_CHANGED")
            rows.append({"path": name, "type": "file", "size": info.st_size, "sha256": h.hexdigest(), "mtime": str(info.st_mtime_ns), "device": str(info.st_dev), "inode": str(info.st_ino)})
        else:
            deny("UNCERTAIN_TYPE", value)
        if len(rows) > 50000:
            deny("INVENTORY_LIMIT")
    visit(full, "")
    content = [{k: v for k, v in row.items() if k not in ("mtime", "device", "inode")} for row in rows]
    return {"type": actual, "size": sum(row.get("size", 0) for row in rows), "fingerprint": digest(rows), "contentFingerprint": digest(content), "inventory": rows, "device": str(st.st_dev), "inode": str(st.st_ino)}


def open_handles(full):
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
        return
    if not os.path.isdir("/proc"):
        deny("HANDLE_CHECK_UNAVAILABLE")
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
            deny("HANDLE_CHECK_UNAVAILABLE", "pid=" + pid)


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


def inspect(root, target, archived=False):
    rel = relative(target["relativePath"])
    full = path_guard(root, rel, archived)
    if not below(root, os.path.dirname(full)):
        deny("UNSAFE_PARENT")
    if archived and (not rel.startswith("clean_dir/") or rel == "clean_dir/MANIFEST.md" or rel.startswith("clean_dir/.operations/")):
        deny("PROTECTED_PATH")
    tracked_dirty(root, rel)
    value = contents(root, full, target["type"])
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
    open_handles(full)
    destination = path_guard(root, target["destination"], True, True)
    if os.path.lexists(destination):
        deny("DESTINATION_EXISTS")
    return {**value, "references": references, "absolutePath": full, "parent": os.path.dirname(full), "leaf": os.path.basename(full), "destination": destination}


def parent_cd(root, full):
    parent = os.path.dirname(full)
    if not below(root, parent):
        deny("PARENT_CD_FAILED")
    try:
        os.chdir(parent)
        if os.path.realpath(os.getcwd()) != parent:
            deny("PARENT_CD_FAILED")
    except OSError:
        deny("PARENT_CD_FAILED")
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


def delete_file(root, full, expected):
    if expected.get("type") != "file":
        deny("UNCERTAIN_TYPE")
    path_guard(root, os.path.relpath(full, root).replace(os.sep, "/"))
    actual = contents(root, full, "file")["inventory"][0]
    if any(actual.get(key) != expected.get(key) for key in ("device", "inode", "size", "mtime", "sha256")):
        deny("CONTENT_CHANGED")
    child = parent_cd(root, full)
    info = os.lstat(child)
    if not stat.S_ISREG(info.st_mode) or str(info.st_ino) != expected["inode"] or str(info.st_dev) != expected["device"]:
        deny("TYPE_CHANGED")
    if info.st_size != expected["size"] or str(info.st_mtime_ns) != expected["mtime"]:
        deny("CONTENT_CHANGED")
    os.unlink(child)


def delete_directory(root, full, inventory, base=""):
    # Execute the immutable inventory. New children and runtime type changes never expand it.
    expected = next((row for row in inventory if row["path"] == base), None)
    if not expected or expected["type"] != "directory":
        deny("UNCERTAIN_TYPE")
    path_guard(root, os.path.relpath(full, root).replace(os.sep, "/"))
    children = [row for row in inventory if row["path"] != base and row["path"].rsplit("/", 1)[0] == base] if base else [row for row in inventory if row["path"] and "/" not in row["path"]]
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
            delete_file(root, value, row)
        elif row["type"] == "directory" and stat.S_ISDIR(st.st_mode):
            delete_directory(root, value, inventory, row["path"])
        else:
            deny("TYPE_CHANGED")
    child = parent_cd(root, full)
    info = os.lstat(child)
    if not stat.S_ISDIR(info.st_mode) or str(info.st_ino) != expected["inode"] or str(info.st_dev) != expected["device"]:
        deny("TYPE_CHANGED")
    os.rmdir(child)


def audit(root, row):
    manifest = path_guard(root, "clean_dir/MANIFEST.md", True, True)
    if os.path.lexists(manifest) and os.lstat(manifest).st_nlink != 1:
        deny("SHARED_HARDLINK")
    os.makedirs(os.path.join(root, "clean_dir"), exist_ok=True)
    with open(os.path.join(root, "clean_dir", "MANIFEST.md"), "a", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


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


def main(request):
    root, identity = root_guard(request["root"])
    expected_owner = request.get("target", {}).get("expectedOwner")
    if expected_owner is not None and not isinstance(expected_owner, dict):
        deny("OWNERSHIP_UNVERIFIED")
    action = request["action"]
    if action not in ("check", "verify", "inventory", "inspect", "move", "delete", "restore", "settle"):
        deny("UNKNOWN_ACTION")
    if action == "inventory":
        target = request["target"]
        full = path_guard(root, target["relativePath"], missing=request.get("allowMissing") is True)
        if not below(root, os.path.dirname(full)):
            deny("UNSAFE_PARENT")
        if not os.path.lexists(full):
            return {"ok": True, "rootIdentity": identity, "target": {"missing": True, "type": target["type"], "absolutePath": full}}
        value = contents(root, full, target["type"])
        if (target.get("expectedOwner") or {}).get("resultPathPolicy") == "declared":
            owner_hash = formal_cleanup_owner(root, target, target["expectedOwner"])
            value["formalOwnerSha256"] = owner_hash
            value["fingerprint"] = digest({"target": value["fingerprint"], "formalOwnerSha256": owner_hash})
        return {"ok": True, "rootIdentity": identity, "target": {**value, "absolutePath": full}}
    if action in ("check", "settle", "verify"):
        if request.get("rootIdentity") and request["rootIdentity"] != identity:
            deny("ROOT_IDENTITY_CHANGED")
        target = request["target"]
        source = path_guard(root, target["relativePath"], True, True)
        destination = path_guard(root, target["destination"], True, True)
        if os.path.lexists(source):
            if action == "check":
                value = inspect(root, target) if (target.get("expectedOwner") or {}).get("resultPathPolicy") == "declared" else contents(root, source, target["type"])
                if value["fingerprint"] != target["fingerprint"]:
                    deny("SOURCE_RECREATED_OR_CHANGED")
                if os.path.lexists(destination):
                    deny("DESTINATION_EXISTS")
                return {"ok": True, "state": "pending", "rootIdentity": identity}
            deny("SOURCE_RECREATED_OR_NOT_MOVED")
        if request.get("deleted") is True:
            if action == "check":
                return {"ok": True, "state": "completed" if request.get("receiptCompleted") is True else "absent_unverified", "rootIdentity": identity}
            return {"ok": True, "irreversible": True}
        if not os.path.lexists(destination):
            deny("RECEIPT_UNVERIFIED")
        value = contents(root, destination, target["type"])
        if value["contentFingerprint"] != target["contentFingerprint"] or value["inode"] != target["inode"]:
            deny("CONTENT_CHANGED")
        if action == "check":
            return {"ok": True, "state": "completed", "rootIdentity": identity}
        if action == "settle":
            audit(root, {"operationId": request["operationId"], "action": request.get("settledAction", "move"), "phase": "completed-after-settlement", "source": source, "destination": destination, **value})
        return {"ok": True, "rootIdentity": identity, "receipt": value}
    target = request["target"]
    archived = action == "restore" or (action == "inspect" and request.get("archived") is True)
    if action == "inspect":
        full = path_guard(root, target["relativePath"], archived, True)
        if not below(root, os.path.dirname(full)):
            deny("UNSAFE_PARENT")
        if not os.path.lexists(full):
            return {"ok": True, "rootIdentity": identity, "target": {"missing": True, "type": target["type"], "absolutePath": full}}
    value = inspect(root, target, archived)
    if action == "inspect":
        return {"ok": True, "rootIdentity": identity, "target": value}
    if identity != request["rootIdentity"] or value["fingerprint"] != target["fingerprint"]:
        deny("PREVIEW_CHANGED")
    batch = target.get("archiveBatch")
    if batch is not None and (not isinstance(batch, str) or not re.fullmatch(r"job-[a-f0-9]{48}", batch)):
        deny("UNSAFE_ARCHIVE_BATCH")
    archive_prefix = "clean_dir/" + (batch + "/" if batch else "")
    if action in ("move", "delete") and target["destination"] != archive_prefix + target["relativePath"]:
        deny("UNSAFE_DESTINATION")
    if action == "restore" and (not target["relativePath"].startswith(archive_prefix) or target["destination"] != target["relativePath"][len(archive_prefix):]):
        deny("UNSAFE_DESTINATION")
    record = {"operationId": request["operationId"], "action": action, "source": value["absolutePath"], "destination": value["destination"], "type": target["type"], "fingerprint": value["fingerprint"], "contentFingerprint": value["contentFingerprint"], "inventory": value["inventory"], "time": time.time()}
    audit(root, {**record, "phase": "intent"})
    # Repeat after durable intent; no stale inspection authorizes mutation.
    checked = inspect(root, target, archived)
    if checked["fingerprint"] != value["fingerprint"]:
        deny("CONTENT_CHANGED")
    if action == "delete":
        if target["type"] == "file":
            delete_file(root, value["absolutePath"], value["inventory"][0])
        elif target["type"] == "directory":
            delete_directory(root, value["absolutePath"], value["inventory"])
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
    audit(root, {**record, "phase": "completed"})
    return {"ok": True, "rootIdentity": identity, "receipt": {**record, "phase": "completed"}}


if __name__ == "__main__":
    lock = None
    try:
        raw = sys.stdin.buffer.read(1048577).rstrip(b"\x00")
        if len(raw) > 1048576:
            deny("REQUEST_TOO_LARGE")
        request = json.loads(raw.decode("utf-8"))
        if request.get("action") in ("move", "delete", "restore", "settle"):
            checked_root, _ = root_guard(request["root"])
            lock = mutation_lock(checked_root)
        result = main(request)
    except GuardError as error:
        result = {"ok": False, "error": {"code": error.code, "message": str(error)}}
    except PermissionError:
        result = {"ok": False, "error": {"code": "PERMISSION_DENIED", "message": "Permission denied"}}
    except Exception as error:
        result = {"ok": False, "error": {"code": "INSPECTION_OR_AUDIT_FAILED", "message": type(error).__name__}}
    finally:
        if lock is not None:
            lock.close()
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
