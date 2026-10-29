"""Pure in-memory fake-OS regression for the pinned runtime-prepare bootstrap (M1/M2).

Injects fake os/socket/sys modules and a guarded builtins.open so the installer
under test never touches the real filesystem. Counters prove every rejection
(same-device inode swap, missing O_NOFOLLOW/O_DIRECTORY flag, dir_fd capability
NotImplementedError) aborts BEFORE any mkdir or program write, while the normal
pinned-fd flow with a known identity is still accepted. No engine import, no
sleep, no subprocess, no real filesystem access; retained as a source fixture.
"""
import builtins
import hashlib
import io
import json
import posixpath
import stat as real_stat
import sys

ROOT = "/srv/project"
DEV = 7
CODE = "print('engine-under-test')\n"
SHA = hashlib.sha256(CODE.encode("utf-8")).hexdigest()
MACHINE = "fakebox"
UID = 0
PROG = ROOT + "/clean_dir/.operations/managed/runtime-" + SHA + ".py"


class Info:
    __slots__ = ("st_mode", "st_dev", "st_ino", "st_uid", "st_size", "st_nlink", "st_file_attributes")

    def __init__(self, mode, dev, ino, size=0, nlink=1):
        self.st_mode = mode
        self.st_dev = dev
        self.st_ino = ino
        self.st_uid = UID
        self.st_size = size
        self.st_nlink = nlink
        self.st_file_attributes = 0


class FakePath:
    def __init__(self, owner):
        self.h = owner

    def isabs(self, p):
        return p.startswith("/")

    def normpath(self, p):
        return posixpath.normpath(p)

    def realpath(self, p):
        return posixpath.normpath(p if p.startswith("/") else posixpath.join("/cwd", p))

    def abspath(self, p):
        return posixpath.normpath(p if p.startswith("/") else posixpath.join("/", p))

    def join(self, *parts):
        return posixpath.join(*parts)

    def dirname(self, p):
        return posixpath.dirname(p)

    def basename(self, p):
        return posixpath.basename(p)

    def isdir(self, p):
        i = self.h.nodes.get(p)
        return i is not None and real_stat.S_ISDIR(i.st_mode)

    def isfile(self, p):
        i = self.h.nodes.get(p)
        return i is not None and real_stat.S_ISREG(i.st_mode)

    def exists(self, p):
        return p in self.h.nodes

    def lexists(self, p):
        return p in self.h.nodes or p in self.h.links

    def islink(self, p):
        return p in self.h.links

    def ismount(self, p):
        return p in self.h.mounts


class FakeOS:
    def __init__(self, *, support_dirfd_open=True, support_dirfd_mkdir=True,
                 no_support=(), root_ino_override=None, root_kind="dir",
                 chain_dirs=False, program=None):
        self.O_RDONLY = 0
        self.O_WRONLY = 1
        self.O_RDWR = 2
        self.O_CREAT = 0o100
        self.O_EXCL = 0o200
        if "O_NOFOLLOW" not in no_support:
            self.O_NOFOLLOW = 0o400000
        if "O_DIRECTORY" not in no_support:
            self.O_DIRECTORY = 0o4000000
        self.nodes = {}
        self.data = {}
        self.links = set()
        self.mounts = set()
        self.fds = {}
        self.next_fd = 50
        self.next_ino = 500
        self.support_dirfd_open = support_dirfd_open
        self.support_dirfd_mkdir = support_dirfd_mkdir
        self.root_ino_override = root_ino_override
        self.counts = {"open": 0, "mkdir": 0, "create": 0, "write": 0}
        self.path = FakePath(self)
        self.environ = {}
        self.sep = "/"
        self._dir("/", ino=1)
        self._dir("/srv", ino=50)
        if root_kind == "dir":
            self._dir(ROOT, ino=100)
        else:
            self._file(ROOT, b"not-a-directory", ino=100)
        if chain_dirs:
            self._dir(ROOT + "/clean_dir")
            self._dir(ROOT + "/clean_dir/.operations")
            self._dir(ROOT + "/clean_dir/.operations/managed")
            if program is not None:
                self._file(PROG, program)
        for name in no_support:
            if hasattr(self, name):
                delattr(self, name)

    def getuid(self):
        return UID

    def _dir(self, p, ino=None, dev=DEV):
        if ino is None:
            ino = self.next_ino
            self.next_ino += 1
        self.nodes[p] = Info(real_stat.S_IFDIR | 0o700, dev, ino)

    def _file(self, p, content, ino=None, nlink=1):
        if ino is None:
            ino = self.next_ino
            self.next_ino += 1
        dev = self.nodes.get(posixpath.dirname(p))
        dev = dev.st_dev if dev is not None else DEV
        self.nodes[p] = Info(real_stat.S_IFREG | 0o600, dev, ino, size=len(content), nlink=nlink)
        self.data[p] = bytearray(content)

    def _resolve(self, path, dir_fd, *, mkdir_call=False):
        if dir_fd is not None:
            entry = self.fds.get(dir_fd)
            if entry is None:
                raise OSError(9, "bad dir_fd")
            base = entry["path"]
            if mkdir_call and "/" in path:
                raise ValueError("mkdir name must be a single component")
            target = posixpath.normpath(posixpath.join(base, path))
        else:
            if not posixpath.isabs(path):
                raise AssertionError("path-based fallback reopened: " + str(path))
            target = posixpath.normpath(path)
        return target

    def open(self, path, flags, mode=0o777, *, dir_fd=None):
        self.counts["open"] += 1
        target = self._resolve(path, dir_fd)
        if dir_fd is not None and not self.support_dirfd_open:
            raise NotImplementedError("dir_fd unavailable on this platform")
        parent = self.nodes.get(posixpath.dirname(target))
        if flags & self.O_CREAT:
            if parent is None or not real_stat.S_ISDIR(parent.st_mode):
                raise FileNotFoundError(2, "parent missing: " + target)
            if target in self.nodes or target in self.links:
                raise FileExistsError(17, target)
            self._file(target, b"")
            self.counts["create"] += 1
            return self._fd(target)
        if target in self.links and getattr(self, "O_NOFOLLOW", 0) and flags & self.O_NOFOLLOW:
            raise OSError(40, "ELOOP")
        info = self.nodes.get(target)
        if info is None:
            raise FileNotFoundError(2, target)
        if flags & getattr(self, "O_DIRECTORY", 0) and not real_stat.S_ISDIR(info.st_mode):
            raise NotADirectoryError(20, target)
        if flags & (self.O_WRONLY | self.O_RDWR) and not real_stat.S_ISREG(info.st_mode):
            raise IsADirectoryError(21, target)
        return self._fd(target)

    def _fd(self, target):
        fd = self.next_fd
        self.next_fd += 1
        entry = {"path": target}
        if target == ROOT and self.root_ino_override is not None:
            entry["ino_override"] = self.root_ino_override
        self.fds[fd] = entry
        return fd

    def fstat(self, fd):
        entry = self.fds[fd]
        info = self.nodes[entry["path"]]
        if "ino_override" in entry:
            return Info(real_stat.S_IFDIR | 0o700, info.st_dev, entry["ino_override"])
        return info

    def lstat(self, path):
        target = posixpath.normpath(path)
        if target in self.links:
            return Info(real_stat.S_IFLNK | 0o777, DEV, 900)
        info = self.nodes.get(target)
        if info is None:
            raise FileNotFoundError(2, target)
        return info

    stat = lstat

    def mkdir(self, name, mode=0o777, *, dir_fd=None):
        target = self._resolve(name, dir_fd, mkdir_call=True)
        if dir_fd is not None and not self.support_dirfd_mkdir:
            raise NotImplementedError("dir_fd unavailable on this platform")
        parent = self.nodes.get(posixpath.dirname(target))
        if parent is None or not real_stat.S_ISDIR(parent.st_mode):
            raise FileNotFoundError(2, "parent missing: " + target)
        if target in self.nodes or target in self.links:
            raise FileExistsError(17, target)
        self._dir(target)
        self.counts["mkdir"] += 1

    def close(self, fd):
        if fd not in self.fds:
            raise OSError(9, "bad fd")
        del self.fds[fd]

    def fsync(self, fd):
        if fd not in self.fds:
            raise OSError(9, "bad fd")

    def write(self, fd, data):
        entry = self.fds[fd]
        blob = bytes(data)
        self.data[entry["path"]].extend(blob)
        self.nodes[entry["path"]].st_size = len(self.data[entry["path"]])
        self.counts["write"] += 1
        return len(blob)

    def fdopen(self, fd, mode="r"):
        entry = self.fds[fd]
        return io.BytesIO(bytes(self.data[entry["path"]]))


def run_bootstrap(bootstrap, harness, *, identity=None, code=CODE, sha=SHA, root=ROOT):
    payload = {"action": "runtime-prepare", "root": root, "runtimeSource": code, "runtimeSha256": sha}
    if identity is not None:
        payload["rootIdentity"] = identity
    fake_sys = type("M", (), {})()
    fake_sys.stdin = type("S", (), {})()
    fake_sys.stdin.buffer = io.BytesIO(json.dumps(payload).encode("utf-8"))
    fake_sys.stdout = io.StringIO()
    fake_sys.stderr = io.StringIO()
    fake_sys.modules = {}
    fake_socket = type("M", (), {})()
    fake_socket.gethostname = lambda: MACHINE

    def guarded_open(file, *args, **kwargs):
        raise AssertionError("real filesystem access attempted: " + str(file))

    fake_builtins = dict(vars(builtins))
    fake_builtins["open"] = guarded_open
    saved = {name: sys.modules.get(name) for name in ("os", "socket", "sys")}
    sys.modules["os"] = harness
    sys.modules["socket"] = fake_socket
    sys.modules["sys"] = fake_sys
    exit_code = None
    try:
        try:
            exec(compile(bootstrap, "bootstrap-under-test", "exec"), {"__builtins__": fake_builtins})
        except SystemExit as stop:
            exit_code = stop.code
        except BaseException as crash:  # noqa: BLE001 - recorded as a scenario failure, never swallowed
            fake_sys.stdout.write(json.dumps({"ok": False, "error": {"code": "CRASH:" + type(crash).__name__, "message": str(crash)[:300]}}))
    finally:
        for name, module in saved.items():
            if module is None:
                del sys.modules[name]
            else:
                sys.modules[name] = module
    text = fake_sys.stdout.getvalue()
    parsed = json.loads(text) if text else {"ok": False, "error": {"code": "NO_OUTPUT", "message": "exit=%r" % (exit_code,)}}
    return parsed, harness


def main():
    with open(sys.argv[1], "r", encoding="utf-8") as stream:
        bootstrap = stream.read()
    results = []

    def check(name, condition, detail=""):
        results.append((name, bool(condition), detail if not condition else ""))

    check("static-no-plain-chain", "plain_chain" not in bootstrap)
    check("static-no-weak-dirfd", "dirfd is None" not in bootstrap)
    check("static-no-flag-getattr", "getattr(os,'O_NOFOLLOW',0)" not in bootstrap and "getattr(os,'O_DIRECTORY',0)" not in bootstrap)
    check("static-capability-fail-closed", "RUNTIME_CAPABILITY_UNAVAILABLE" in bootstrap)
    check("static-identity-from-pinned-fd", "identity={'path':root,'device':str(info.st_dev),'inode':str(info.st_ino)" in bootstrap and "os.stat(root)" not in bootstrap)

    # 1: first install pins the root, creates the chain via parent fd, O_EXCL-writes the program.
    parsed, h = run_bootstrap(bootstrap, FakeOS())
    expected_identity = {"path": ROOT, "device": str(DEV), "inode": "100", "machine": MACHINE, "user": str(UID)}
    check("first-install-ok", parsed.get("ok") is True and parsed.get("state") == "installed", json.dumps(parsed))
    check("first-install-mkdir3-create1", h.counts["mkdir"] == 3 and h.counts["create"] == 1 and h.counts["write"] >= 1, json.dumps(h.counts))
    check("first-install-program-bytes", bytes(h.data.get(PROG, b"")) == CODE.encode("utf-8"))
    check("first-install-identity-is-pinned-fd", parsed.get("rootIdentity") == expected_identity, json.dumps(parsed.get("rootIdentity")))

    # 2: known identity + unchanged tree -> verified, zero creation.
    parsed, h = run_bootstrap(bootstrap, FakeOS(chain_dirs=True, program=CODE.encode("utf-8")), identity=expected_identity)
    check("verified-reinstall-accepted", parsed.get("ok") is True and parsed.get("state") == "verified", json.dumps(parsed))
    check("verified-reinstall-zero-writes", h.counts["mkdir"] == 0 and h.counts["create"] == 0 and h.counts["write"] == 0, json.dumps(h.counts))

    zero_write = lambda h: h.counts["mkdir"] == 0 and h.counts["create"] == 0 and h.counts["write"] == 0

    # 3 (M1): same device, different inode in the bound identity -> refused before any mkdir/write.
    swapped = dict(expected_identity, inode="999")
    parsed, h = run_bootstrap(bootstrap, FakeOS(chain_dirs=True), identity=swapped)
    check("m1-inode-swap-refused", parsed.get("error", {}).get("code") == "ROOT_IDENTITY_CHANGED", json.dumps(parsed))
    check("m1-inode-swap-zero-writes", zero_write(h), json.dumps(h.counts))

    # 4 (M1): different device in the bound identity -> refused with zero writes.
    parsed, h = run_bootstrap(bootstrap, FakeOS(chain_dirs=True), identity=dict(expected_identity, device="8"))
    check("m1-device-swap-refused", parsed.get("error", {}).get("code") == "ROOT_IDENTITY_CHANGED", json.dumps(parsed))
    check("m1-device-swap-zero-writes", zero_write(h), json.dumps(h.counts))

    # 5 (M1): root swapped between the path-level checks and the pinned open (fake open observes inode 101).
    parsed, h = run_bootstrap(bootstrap, FakeOS(chain_dirs=True, root_ino_override=101), identity=expected_identity)
    check("m1-swap-at-open-refused", parsed.get("error", {}).get("code") == "ROOT_IDENTITY_CHANGED", json.dumps(parsed))
    check("m1-swap-at-open-zero-writes", zero_write(h), json.dumps(h.counts))

    # 6 (M1): without a bound identity the first install BINDS the pinned fd facts (not a stale path stat).
    parsed, h = run_bootstrap(bootstrap, FakeOS(root_ino_override=101))
    check("m1-first-bind-uses-fd-inode", parsed.get("ok") is True and parsed.get("rootIdentity", {}).get("inode") == "101", json.dumps(parsed.get("rootIdentity")))

    # 7/8 (M2): missing security flags -> capability refusal before ANY filesystem call.
    for flag in ("O_NOFOLLOW", "O_DIRECTORY"):
        parsed, h = run_bootstrap(bootstrap, FakeOS(no_support=(flag,)))
        check("m2-missing-flag-%s-refused" % flag, parsed.get("error", {}).get("code") == "RUNTIME_CAPABILITY_UNAVAILABLE", json.dumps(parsed))
        check("m2-missing-flag-%s-zero-fs" % flag, h.counts["open"] == 0 and zero_write(h), json.dumps(h.counts))

    # 9/10 (M2): dir_fd NotImplementedError on open or on mkdir -> fail closed, program never created.
    parsed, h = run_bootstrap(bootstrap, FakeOS(support_dirfd_open=False))
    check("m2-dirfd-open-refused", parsed.get("error", {}).get("code") == "RUNTIME_CAPABILITY_UNAVAILABLE", json.dumps(parsed))
    check("m2-dirfd-open-zero-writes", zero_write(h), json.dumps(h.counts))
    parsed, h = run_bootstrap(bootstrap, FakeOS(support_dirfd_mkdir=False))
    check("m2-dirfd-mkdir-refused", parsed.get("error", {}).get("code") == "RUNTIME_CAPABILITY_UNAVAILABLE", json.dumps(parsed))
    check("m2-dirfd-mkdir-zero-create", h.counts["create"] == 0 and h.counts["mkdir"] == 0, json.dumps(h.counts))

    # 11: foreign payload is refused before any filesystem call.
    parsed, h = run_bootstrap(bootstrap, FakeOS(), code="print('other')\n", sha=SHA)
    check("bad-code-zero-fs", parsed.get("error", {}).get("code") == "RUNTIME_CODE_MISMATCH" and h.counts["open"] == 0 and zero_write(h), json.dumps(parsed))

    # 12: an existing tampered program is refused without rewriting or deleting it.
    parsed, h = run_bootstrap(bootstrap, FakeOS(chain_dirs=True, program=b"tampered"), identity=expected_identity)
    check("tampered-program-refused", parsed.get("error", {}).get("code") == "RUNTIME_PROGRAM_MISMATCH", json.dumps(parsed))
    check("tampered-program-zero-writes", h.counts["create"] == 0 and h.counts["write"] == 0, json.dumps(h.counts))

    # 13: root that is not a directory is refused before the pinned open.
    parsed, h = run_bootstrap(bootstrap, FakeOS(root_kind="file"))
    check("file-root-refused", parsed.get("error", {}).get("code") in ("ROOT_IDENTITY_CHANGED", "UNSAFE_ROOT") and h.counts["open"] == 0 and zero_write(h), json.dumps(parsed))

    failures = [name + ((": " + detail) if detail else "") for name, passed, detail in results if not passed]
    print(json.dumps({"ok": not failures, "scenarios": len(results), "failures": failures}))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
