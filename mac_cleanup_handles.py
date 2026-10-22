"""Darwin read-only vnode evidence. Never mutates files or signals processes.

ABI reference: Apple XNU bsd/sys/proc_info.h and libproc/libproc.h.
This adapter implements the same-user handle query, not cleanup authorization.
"""
import ctypes as C
import errno
import json
import os
import stat
import sys
import time


class HandleProofError(Exception):
    def __init__(self, code, detail=""):
        self.code = code
        super().__init__(detail or code)


def unavailable(detail):
    raise HandleProofError("HANDLE_CHECK_UNAVAILABLE", detail)


class _Gone(Exception):
    pass


U32, U64, I32, I64 = C.c_uint32, C.c_uint64, C.c_int32, C.c_int64


class BsdInfo(C.Structure):
    _fields_ = [(name, U32) for name in (
        "flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid", "rgid", "svuid", "svgid", "reserved")]
    _fields_ += [("comm", C.c_char * 16), ("name", C.c_char * 32)]
    _fields_ += [(name, U32) for name in ("nfiles", "pgid", "pjobc", "tdev", "tpgid")]
    _fields_ += [("nice", I32), ("start_seconds", U64), ("start_microseconds", U64)]


class VnodeStat(C.Structure):
    _fields_ = [("dev", U32), ("mode", C.c_uint16), ("nlink", C.c_uint16), ("ino", U64), ("uid", U32), ("gid", U32)]
    _fields_ += [(name, I64) for name in ("atime", "atimensec", "mtime", "mtimensec", "ctime", "ctimensec", "birthtime", "birthtimensec", "size", "blocks")]
    _fields_ += [("blksize", I32), ("flags", U32), ("gen", U32), ("rdev", U32), ("spare", I64 * 2)]


class VnodeInfo(C.Structure):
    _fields_ = [("stat", VnodeStat), ("type", I32), ("pad", I32), ("fsid", I32 * 2)]


class VnodePath(C.Structure):
    _fields_ = [("vnode", VnodeInfo), ("path", C.c_char * 1024)]


class CwdInfo(C.Structure):
    _fields_ = [("cwd", VnodePath), ("root", VnodePath)]


class FileInfo(C.Structure):
    _fields_ = [("flags", U32), ("status", U32), ("offset", I64), ("type", I32), ("guard", U32)]


class FdVnode(C.Structure):
    _fields_ = [("file", FileInfo), ("vnode_path", VnodePath)]


class FdInfo(C.Structure):
    _fields_ = [("fd", I32), ("type", U32)]


class FileportInfo(C.Structure):
    _fields_ = [("port", U32), ("type", U32)]


class ThreadInfo(C.Structure):
    _fields_ = [("user_time", U64), ("system_time", U64)]
    _fields_ += [(name, I32) for name in ("cpu_usage", "policy", "run_state", "flags", "sleep_time", "curpri", "priority", "maxpriority")]
    _fields_ += [("name", C.c_char * 64)]


class ThreadPath(C.Structure):
    _fields_ = [("thread", ThreadInfo), ("vnode_path", VnodePath)]


class RegionInfo(C.Structure):
    _fields_ = [(name, U32) for name in ("protection", "max_protection", "inheritance", "flags")]
    _fields_ += [("offset", U64)]
    _fields_ += [(name, U32) for name in ("behavior", "user_wired_count", "user_tag", "pages_resident", "pages_shared", "pages_swapped", "pages_dirtied", "ref_count", "shadow_depth", "share_mode", "private_pages", "shared_pages", "obj_id", "depth")]
    _fields_ += [("address", U64), ("size", U64)]


class RegionPath(C.Structure):
    _fields_ = [("region", RegionInfo), ("vnode_path", VnodePath)]


class DarwinHandles:
    """Bounded libproc reader; unreadable or changing evidence is never 'unused'."""
    def __init__(self):
        if sys.platform != "darwin" or C.sizeof(C.c_void_p) != 8:
            unavailable("Darwin 64-bit libproc is required")
        expected = ((BsdInfo, 136), (VnodeStat, 136), (VnodeInfo, 152), (VnodePath, 1176),
                    (CwdInfo, 2352), (FileInfo, 24), (FdVnode, 1200), (FdInfo, 8),
                    (FileportInfo, 8), (ThreadInfo, 112), (ThreadPath, 1288), (RegionInfo, 96), (RegionPath, 1272))
        if any(C.sizeof(kind) != size for kind, size in expected):
            unavailable("Unsupported proc_info ABI layout")
        try:
            self.api = C.CDLL("/usr/lib/libproc.dylib", use_errno=True)
            signatures = {
                "proc_listpids": [U32, U32, C.c_void_p, C.c_int],
                "proc_pidinfo": [C.c_int, C.c_int, U64, C.c_void_p, C.c_int],
                "proc_pidfdinfo": [C.c_int, C.c_int, C.c_int, C.c_void_p, C.c_int],
                "proc_pidfileportinfo": [C.c_int, U32, C.c_int, C.c_void_p, C.c_int],
            }
            for name, args in signatures.items():
                function = getattr(self.api, name)
                function.argtypes, function.restype = args, C.c_int
        except (OSError, AttributeError):
            unavailable("Darwin libproc entry points are unavailable")
        self.deadline = time.monotonic() + 6
        self.uid = os.getuid()
        self.identity(os.getpid())
        cwd = self.query(os.getpid(), 9, CwdInfo).cwd.vnode.stat
        physical_cwd = os.stat(os.getcwd())
        if (int(cwd.dev), int(cwd.ino)) != (physical_cwd.st_dev & 0xffffffff, physical_cwd.st_ino):
            unavailable("Native vnode layout failed its current-directory identity check")

    def call(self, function, *args):
        if time.monotonic() > self.deadline:
            unavailable("Darwin handle query exceeded its time budget")
        C.set_errno(0)
        result = function(*args)
        return result, C.get_errno()

    def query(self, pid, flavor, kind, arg=0, function=None, end=False):
        value = kind()
        if function is None:
            size, error = self.call(self.api.proc_pidinfo, pid, flavor, arg, C.byref(value), C.sizeof(value))
        else:
            size, error = self.call(function, pid, arg, flavor, C.byref(value), C.sizeof(value))
        # REGIONPATHINFO uses EINVAL/ESRCH for exhaustion; the caller still
        # rechecks the process birth identity after the complete scan.
        if end and size <= 0 and error in (errno.EINVAL, errno.ESRCH):
            return None
        if size <= 0 and error == errno.ESRCH:
            raise _Gone()
        if size != C.sizeof(value):
            unavailable("pid=%s flavor=%s incomplete native evidence errno=%s" % (pid, flavor, error))
        return value

    def listing(self, function, args, kind):
        # Keep spare room so a full buffer can never be mistaken for a complete list.
        capacity = 256
        for _ in range(9):
            values = (kind * capacity)()
            size, error = self.call(function, *args, values, C.sizeof(values))
            if size < 0 or error:
                if error == errno.ESRCH:
                    raise _Gone()
                unavailable("Native enumeration failed errno=%s" % error)
            width = C.sizeof(kind)
            if size % width or size > C.sizeof(values):
                unavailable("Native enumeration returned a partial record")
            if size + width < C.sizeof(values):
                return list(values[:size // width])
            capacity *= 2
        unavailable("Native enumeration exceeded its capacity")

    def identity(self, pid):
        value = self.query(pid, 3, BsdInfo)
        if value.pid != pid or value.uid != self.uid or not value.start_seconds or value.start_microseconds >= 1000000:
            unavailable("Process identity changed during handle query")
        return value, (pid, value.uid, value.start_seconds, value.start_microseconds)

    def snapshot(self):
        pids = self.listing(self.api.proc_listpids, (4, self.uid), I32)
        if os.getpid() not in pids or any(pid < 0 for pid in pids):
            unavailable("Native process inventory contains an invalid PID")
        rows = {}
        for pid in sorted(set(pids) - {0, os.getpid()}):
            try:
                value, identity = self.identity(pid)
                rows[pid] = (value, identity)
            except _Gone:
                continue  # ESRCH is an exit observation, not a permission fallback.
        return rows

    def inspect(self, pid, before, targets):
        def vnode(value, required=False):
            info = value.vnode.stat
            if required and not info.ino:
                unavailable("pid=%s returned an unreadable vnode identity" % pid)
            if (int(info.dev), int(info.ino)) in targets:
                raise HandleProofError("ACTIVE_HANDLE", "pid=" + str(pid))
        cwd = self.query(pid, 9, CwdInfo)
        if not cwd.cwd.vnode.stat.ino:
            unavailable("pid=%s has no readable working-directory evidence" % pid)
        vnode(cwd.cwd)
        vnode(cwd.root)
        if before.flags & 0x100:
            threads = self.listing(self.api.proc_pidinfo, (pid, 6, 0), U64)
            for tid in threads:
                vnode(self.query(pid, 10, ThreadPath, int(tid)).vnode_path)
        descriptors = self.listing(self.api.proc_pidinfo, (pid, 1, 0), FdInfo)
        for descriptor in descriptors:
            if descriptor.fd < 0 or descriptor.type not in (0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11):
                unavailable("Native descriptor inventory contains an invalid FD")
            if descriptor.type == 1:
                vnode(self.query(pid, 2, FdVnode, descriptor.fd, self.api.proc_pidfdinfo).vnode_path, True)
        ports = self.listing(self.api.proc_pidinfo, (pid, 14, 0), FileportInfo)
        for port in ports:
            if port.type not in (1, 2, 3, 6):
                unavailable("Native fileport inventory contains an unsupported type")
            if port.type == 1:
                vnode(self.query(pid, 2, FdVnode, port.port, self.api.proc_pidfileportinfo).vnode_path, True)
        address = 0
        for _ in range(65536):
            region = self.query(pid, 8, RegionPath, address, end=True)
            if region is None:
                break
            vnode(region.vnode_path)
            next_address = int(region.region.address) + int(region.region.size)
            if not region.region.size or next_address <= address or next_address >= 2 ** 64:
                unavailable("Native memory-region enumeration did not advance")
            address = next_address
        else:
            unavailable("Native memory-region inventory exceeded its capacity")


def assert_no_open_handles(full, inventory=None):
    if not isinstance(full, str) or not os.path.isabs(full) or os.path.realpath(full) != full:
        unavailable("Handle target must be an exact canonical path")
    before = os.lstat(full)
    if not (stat.S_ISREG(before.st_mode) or stat.S_ISDIR(before.st_mode)):
        unavailable("Handle target must be a regular file or directory")
    if inventory is None:
        if not stat.S_ISREG(before.st_mode):
            unavailable("Directory handle proof requires the frozen cleanup inventory")
        inventory = [{"device": str(before.st_dev), "inode": str(before.st_ino)}]
    if not inventory or len(inventory) > 50000:
        unavailable("Invalid frozen handle inventory")
    try:
        targets = {(int(row["device"]) & 0xffffffff, int(row["inode"])) for row in inventory}
    except (KeyError, ValueError, TypeError):
        unavailable("Invalid frozen vnode identity")
    identity = (before.st_dev & 0xffffffff, before.st_ino)
    if identity not in targets or any(inode <= 0 for _, inode in targets):
        unavailable("Target identity does not match the frozen inventory")
    reader = DarwinHandles()
    processes = reader.snapshot()
    for pid, (process, birth) in processes.items():
        try:
            reader.inspect(pid, process, targets)
            if reader.identity(pid)[1] != birth:
                unavailable("Process was replaced during handle query")
        except _Gone:
            try:
                reader.identity(pid)
            except _Gone:
                continue
            unavailable("A live process returned incomplete handle evidence")
    after_processes = reader.snapshot()
    if any(pid not in processes or processes[pid][1] != row[1] for pid, row in after_processes.items()):
        unavailable("Same-user process inventory changed; query again")
    after = os.lstat(full)
    if (before.st_dev, before.st_ino, before.st_mode, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_mode, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise HandleProofError("CONTENT_CHANGED")
    return {"schemaVersion": 1, "scope": "visible_same_user_processes", "uid": reader.uid,
            "path": full, "device": str(after.st_dev), "inode": str(after.st_ino), "processCount": len(after_processes)}


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            unavailable("Handle query input exceeds its limit")
        request = json.loads(raw.decode("utf-8"))
        inventory = request.get("inventory")
        if inventory is not None and (not isinstance(inventory, list) or not all(isinstance(row, dict) for row in inventory)):
            unavailable("Handle query inventory must be a list of vnode identities")
        proof = assert_no_open_handles(request["path"], inventory)
        if proof["device"] != request.get("device") or proof["inode"] != request.get("inode"):
            raise HandleProofError("CONTENT_CHANGED")
        result = {"ok": True, "proof": proof}
    except HandleProofError as error:
        result = {"ok": False, "error": {"code": error.code, "message": str(error)}}
    except Exception:
        result = {"ok": False, "error": {"code": "HANDLE_CHECK_UNAVAILABLE", "message": "Native handle evidence is unavailable"}}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
