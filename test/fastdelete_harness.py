"""Shared fake-OS harness for the v1.9 fast-chain FakeOS fixtures.

Behaviour-cloned from the green fastDeleteGuard.fixture.py inline harness and
parameterised so the migrated confirmed*/chunked fixtures exercise the fast
chain WITHOUT any real filesystem mutation: no real deletion approval exists
in this phase, therefore every destructive scenario here runs against this
in-memory tree only. fastDeleteGuard.fixture.py keeps its own inline copy;
both copies share the posixpath virtual semantics enforced here (the v1.11
win32 red proved the old host os.path pull leaked ntpath into slash keys).

Options for build_engine:
  refuse_reads  - opening a regular file in binary read mode raises
                  (proves the fast chain performs zero content reads)
  unlink_limit  - after N successful unlinks the fake raises OSError(5),
                  emulating an interruption mid-walk
"""
import io, json, posixpath, runpy, stat, sys, types

# The fake tree models a REMOTE POSIX filesystem: every virtual path operation
# must be slash-based regardless of the host running the fixture (the engine
# under test always receives these paths from the POSIX transport). Pulling the
# pure functions from the host os.path leaked Windows semantics on win32
# (normpath('/srv/proj') -> '\\srv\\proj' while entries stay slashed), so the
# virtual layer imports posixpath explicitly. Real repo/engine paths below keep
# host semantics via runpy/open; nothing here touches the real filesystem.


class St:
    def __init__(self, mode, ino, dev=7, size=0, mtime_ns=1000, nlink=1):
        self.st_mode = mode
        self.st_ino = ino
        self.st_dev = dev
        self.st_size = size
        self.st_mtime_ns = mtime_ns
        self.st_ctime_ns = mtime_ns + 1
        self.st_nlink = nlink
        self.st_uid = 0
        self.st_gid = 0
        self.st_atime_ns = mtime_ns
        self.st_mtime = mtime_ns / 1e9
        self.st_ctime = mtime_ns / 1e9


class Tree:
    def __init__(self, root="/srv/proj"):
        self.root = root
        self.entries = {}
        self.ino = 100
        self.removed = []
        self.rmdired = []
        self.renamed = []
        self.controls = []
        self.reads = []
        self.cwd = root
        self.swap = set()
        self.recreate_after_rename = False
        self.fail_chdir = False
        self.stuck_cwd = None

    def add_dir(self, path, dev=7):
        self.ino += 1
        self.entries[path] = ("d", St(stat.S_IFDIR | 0o755, self.ino, dev=dev), None)

    def seed_base(self):
        """Ancestor chain the engine's root_guard walks when it climbs to the mount."""
        for directory in ("/", "/srv", self.root):
            self.add_dir(directory)

    def add_file(self, path, data, dev=7):
        self.ino += 1
        self.entries[path] = ("f", St(stat.S_IFREG | 0o644, self.ino, size=len(data), dev=dev,
                                      mtime_ns=1000000 + self.ino), data)

    def add_alias(self, path, source):
        """A second directory name for the same inode (hardlink semantics)."""
        entry = self.entries[source]
        self.entries[path] = ("f", entry[1], entry[2])

    def add_link(self, path, target):
        self.ino += 1
        self.entries[path] = ("l", St(stat.S_IFLNK | 0o777, self.ino), target)

    def resolve(self, path):
        path = path if str(path).startswith("/") else self.cwd + "/" + str(path)
        return posixpath.normpath(path)

    def identity(self, path):
        entry = self.entries[self.resolve(path)]
        return {"device": str(entry[1].st_dev), "inode": str(entry[1].st_ino)}

    def to_dict(self):
        return {"root": self.root, "cwd": self.cwd, "ino": self.ino,
                "entries": {path: [kind, [st.st_mode, st.st_ino, st.st_dev, st.st_size, st.st_mtime_ns],
                                   data.decode("latin-1") if isinstance(data, bytes) else data]
                            for path, (kind, st, data) in self.entries.items()}}

    @classmethod
    def from_dict(cls, payload):
        tree = cls(payload["root"])
        for path, spec in payload["entries"].items():
            kind, st, data = spec
            tree.entries[path] = (kind, St(st[0], st[1], dev=st[2], size=st[3], mtime_ns=st[4]),
                                  data.encode("latin-1") if kind == "f" and data is not None else None)
        tree.ino = payload["ino"]
        tree.cwd = payload["cwd"]
        return tree


def build_engine(tree, engine_path, options=None):
    options = options or {}

    def lstat(path):
        full = tree.resolve(path)
        entry = tree.entries.get(full)
        if entry is None:
            raise FileNotFoundError(full)
        kind, st, _ = entry
        if str(path).startswith("./") and full in tree.swap:
            return St(stat.S_IFREG | 0o644, st.st_ino + 99999, st.st_dev, st.st_size, st.st_mtime_ns, st.st_nlink)
        return st

    def listdir(path):
        full = tree.resolve(path)
        entry = tree.entries.get(full)
        if entry is None or entry[0] != "d":
            raise NotADirectoryError(full)
        prefix = full + "/"
        return sorted(name[len(prefix):] for name in tree.entries
                      if name.startswith(prefix) and "/" not in name[len(prefix):])

    def chdir(path):
        full = tree.resolve(path)
        entry = tree.entries.get(full)
        if entry is None:
            raise FileNotFoundError(full)
        if entry[0] != "d":
            raise NotADirectoryError(full)
        if tree.fail_chdir:
            raise PermissionError("fixture denied parent entry")
        if tree.stuck_cwd is not None:
            return  # Silent no-op: the caller's after-the-fact getcwd check must catch this.
        tree.cwd = full

    def remove(path):
        full = tree.resolve(path)
        if full not in tree.entries:
            raise FileNotFoundError(full)
        if options.get("unlink_limit") is not None and len(tree.removed) >= options["unlink_limit"]:
            raise OSError(5, "Input/output error")
        tree.removed.append((str(path), tree.cwd))
        del tree.entries[full]

    def rmdir(path):
        full = tree.resolve(path)
        entry = tree.entries.get(full)
        if entry is None:
            raise FileNotFoundError(full)
        if entry[0] != "d":
            raise NotADirectoryError(full)
        if listdir(full):
            raise OSError(39, "Directory not empty")
        tree.rmdired.append((str(path), tree.cwd))
        del tree.entries[full]

    def entry_kind(path, kind):
        entry = tree.entries.get(tree.resolve(path))
        return entry is not None and entry[0] == kind

    pure = {name: getattr(posixpath, name) for name in
            ("normcase", "normpath", "join", "split", "dirname", "basename", "isabs", "relpath", "commonpath")}
    pure.update({
        "lexists": lambda path: tree.resolve(path) in tree.entries,
        "exists": lambda path: tree.resolve(path) in tree.entries,
        "isdir": lambda path: entry_kind(path, "d"),
        "isfile": lambda path: entry_kind(path, "f"),
        "islink": lambda path: entry_kind(path, "l"),
        "ismount": lambda path: False,
        "realpath": lambda path: posixpath.normpath(path),
        "expanduser": lambda path: path if path != "~" else "/root",
        "abspath": lambda path: posixpath.normpath(path if posixpath.isabs(path) else tree.cwd + "/" + path),
        "getsize": lambda path: lstat(path).st_size,
        "sep": "/",
    })

    class FakeDirEntry:
        def __init__(self, full):
            self.full = full
            self.name = posixpath.basename(full)

        @property
        def path(self):
            return self.full

        def is_dir(self, follow_symlinks=False):
            entry = tree.entries.get(self.full)
            return entry is not None and entry[0] == "d"

        def is_file(self, follow_symlinks=False):
            entry = tree.entries.get(self.full)
            return entry is not None and entry[0] == "f"

    class ScanContext:
        def __init__(self, entries):
            self.entries = entries

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def __iter__(self):
            return iter(self.entries)

    def scandir(path):
        full = tree.resolve(path)
        return ScanContext([FakeDirEntry(full + "/" + name) for name in listdir(full)])

    def walk(top, topdown=True, onerror=None, followlinks=False):
        def visit(dirpath):
            dirs, files = [], []
            for name in listdir(dirpath):
                (dirs if entry_kind(dirpath + "/" + name, "d") else files).append(name)
            yield dirpath, dirs, files
            for child in dirs:
                yield from visit(posixpath.join(dirpath, child))
        yield from visit(top)
    fake_os = types.SimpleNamespace(
        name="posix", sep="/", path=types.SimpleNamespace(**pure),
        lstat=lstat, stat=lstat, listdir=listdir, scandir=scandir, walk=walk, chdir=chdir,
        getcwd=lambda: tree.stuck_cwd or tree.cwd, unlink=remove, remove=remove, rmdir=rmdir, environ={},
        getuid=lambda: 0, fsencode=lambda value: str(value).encode("utf-8"),
        expanduser=lambda path: path if path != "~" else "/root")

    def fake_open(path, mode="r", *args, **kwargs):
        full = tree.resolve(str(path))
        entry = tree.entries.get(full)
        if entry is not None and entry[0] == "f" and "b" in str(mode):
            if options.get("refuse_reads"):
                raise AssertionError("ENGINE_READ_CONTENT:" + full)
            tree.reads.append(full)
            return io.BytesIO(entry[2])
        raise RuntimeError("FAKE_REAL_OPEN:" + full + ":" + str(mode))

    engine = runpy.run_path(engine_path)
    # runpy returns a copy of the module dict; the exec'd functions resolve
    # names through their real __globals__, so the fakes must be installed
    # there for the engine code to actually see them.
    real = engine["delete_fast"].__globals__
    real["os"] = fake_os
    real["open"] = fake_open

    def fake_no_replace(source, destination):
        # Faithful same-filesystem rename emulation: refuses an existing
        # destination (never overwrites) and moves the entry plus every
        # descendant, keeping inode/dev identity exactly like rename(2).
        src, dst = tree.resolve(source), tree.resolve(destination)
        if dst in tree.entries:
            engine["deny"]("MOVE_FAILED", dst)
        tree.renamed.append((str(source), str(destination), tree.cwd))
        moved = {key: value for key, value in tree.entries.items() if key == src or key.startswith(src + "/")}
        for key, value in moved.items():
            del tree.entries[key]
            tree.entries[dst + key[len(src):]] = value
        if tree.recreate_after_rename:
            tree.add_dir(src)
            tree.add_file(src + "/new-result.bin", b"fresh")

    real["no_replace"] = fake_no_replace

    def fake_write_control(root, control_rel, record):
        tree.controls.append(dict(record))

    real["write_control_json"] = fake_write_control
    return engine


def make_refusal(engine):
    def refusal(call, code):
        try:
            call()
        except engine["GuardError"] as error:
            assert error.code == code, "expected " + code + " got " + error.code
            return error
        raise AssertionError("expected GuardError " + code)
    return refusal
