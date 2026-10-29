"""P0 pure in-memory guard for cleanup-files.py chunked_manifest_trim.

Nothing here touches the real filesystem beyond reading the engine source:
the engine's `os` and `open` module globals are replaced with an in-memory
tree, so the trim runs against fake entries only. The scenarios prove:
  1. clean run      - every unlink/rmdir argument is exactly "./<leaf>" and
                      happens while the fake physical cwd equals the verified
                      direct parent; the empty directory is removed last;
  2. unknown names  - injected chunk/tmp names are never deleted or absorbed;
  3. tampered chunk - a chunk whose bytes no longer match its bound digest is
                      retained, never removed;
  4. link entry     - a symlinked summary refuses and survives untouched;
  5. parent failure - when entering the direct parent fails, zero deletions;
  6. swap after cd  - an identity swap after chdir blocks that unlink only.
"""
import hashlib, io, json, ntpath, os, posixpath, runpy, stat, sys, types

# Virtual paths model the remote POSIX filesystem: the pure path layer is
# posixpath-based on every host so Windows hosts cannot leak ntpath semantics
# into slash-keyed entries. Real engine/repo file access keeps host paths.


ROOT = "/srv/proj"
KEY = "k" * 64
FROZEN = ROOT + "/clean_dir/.operations/frozen"
KEYDIR = FROZEN + "/" + KEY
FP = "f" * 64


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
    def __init__(self):
        self.entries = {}
        self.ino = 100
        self.removed = []
        self.rmdired = []
        self.cwd = ROOT
        self.fail_chdir = set()
        self.swap = set()

    def add_dir(self, path):
        self.ino += 1
        self.entries[path] = ("d", St(stat.S_IFDIR | 0o755, self.ino), None)

    def add_file(self, path, data):
        self.ino += 1
        self.entries[path] = ("f", St(stat.S_IFREG | 0o644, self.ino, size=len(data),
                                      mtime_ns=1000000 + self.ino), data)

    def add_link(self, path, target):
        self.ino += 1
        self.entries[path] = ("l", St(stat.S_IFLNK | 0o777, self.ino), target)

    def resolve(self, path):
        path = path if path.startswith("/") else self.cwd + "/" + path
        return posixpath.normpath(path)


def build_engine(tree, engine_path):
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
        if full in tree.fail_chdir:
            raise PermissionError(full)
        tree.cwd = full

    def remove(path):
        full = tree.resolve(path)
        if full not in tree.entries:
            raise FileNotFoundError(full)
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
        "abspath": lambda path: posixpath.normpath(path if posixpath.isabs(path) else tree.cwd + "/" + path),
        "sep": "/",
    })
    fake_os = types.SimpleNamespace(
        name="posix", sep="/", path=types.SimpleNamespace(**pure),
        lstat=lstat, stat=lstat, listdir=listdir, chdir=chdir, getcwd=lambda: tree.cwd,
        unlink=remove, remove=remove, rmdir=rmdir,
        expanduser=lambda path: path if path != "~" else "/root")

    def fake_open(path, mode="r", *args, **kwargs):
        full = tree.resolve(str(path))
        entry = tree.entries.get(full)
        if entry is not None and entry[0] == "f" and "b" in str(mode):
            return io.BytesIO(entry[2])
        raise RuntimeError("FAKE_REAL_OPEN:" + full + ":" + str(mode))

    engine = runpy.run_path(engine_path)
    # runpy returns a copy of the module dict; the exec'd functions resolve
    # names through their real __globals__, so the fakes must be installed
    # there for the engine code to actually see them.
    real = engine["chunked_manifest_trim"].__globals__
    real["os"] = fake_os
    real["open"] = fake_open
    return engine


def fresh_tree(summary_body=None):
    tree = Tree()
    for directory in (ROOT, ROOT + "/clean_dir", ROOT + "/clean_dir/.operations", FROZEN, KEYDIR):
        tree.add_dir(directory)
    chunks = [b"[row-a]", b"[row-b]"]
    digests = [hashlib.sha256(blob).hexdigest() for blob in chunks]
    summary = {"schemaVersion": 1, "fingerprint": FP, "count": 13, "applied": 2, "chunkDigests": digests}
    body = json.dumps(summary if summary_body is None else summary_body).encode("utf-8")
    tree.add_file(KEYDIR + "/summary.json", body)
    tree.add_file(KEYDIR + "/chunk-000000.json", chunks[0])
    tree.add_file(KEYDIR + "/chunk-000001.json", chunks[1])
    return tree, {"fingerprint": FP, "count": 13, "chunkDigests": digests}


def discipline(tree):
    for path, cwd in tree.removed + tree.rmdired:
        assert path.startswith("./") and "/" not in path[2:], path
        assert cwd in (KEYDIR, FROZEN), cwd


def check(name, condition):
    if not condition:
        raise AssertionError("scenario failed: " + name)
    print("ok " + name)


engine_path = sys.argv[1]

tree, summary = fresh_tree()
report = build_engine(tree, engine_path)["chunked_manifest_trim"](ROOT, KEY, summary, 2)
check("clean", report["status"] == "trimmed" and report["directoryRemoved"] is True
      and sorted(report["removed"]) == ["chunk-000000.json", "chunk-000001.json", "summary.json"]
      and report["retained"] == [] and report["errors"] == [] and report["unknownNames"] == []
      and sorted(path for path, _ in tree.removed) == ["./chunk-000000.json", "./chunk-000001.json", "./summary.json"]
      and all(cwd == KEYDIR for _, cwd in tree.removed)
      and tree.rmdired == [("./" + KEY, FROZEN)]
      and KEYDIR not in tree.entries and FROZEN in tree.entries)
discipline(tree)

tree, summary = fresh_tree()
tree.add_file(KEYDIR + "/chunk-000002.json", b"extra")
tree.add_file(KEYDIR + "/summary.json.0123456789ab.tmp", b"tmp")
report = build_engine(tree, engine_path)["chunked_manifest_trim"](ROOT, KEY, summary, 2)
check("unknown-names", report["status"] == "retained" and report["directoryRemoved"] is False
      and sorted(report["unknownNames"]) == ["chunk-000002.json", "summary.json.0123456789ab.tmp"]
      and all(not path.endswith(("chunk-000002.json", "summary.json.0123456789ab.tmp")) for path, _ in tree.removed)
      and KEYDIR + "/chunk-000002.json" in tree.entries and KEYDIR + "/summary.json.0123456789ab.tmp" in tree.entries
      and tree.rmdired == [])
discipline(tree)

tree, summary = fresh_tree()
tree.add_file(KEYDIR + "/chunk-000001.json", b"TAMPERED")
report = build_engine(tree, engine_path)["chunked_manifest_trim"](ROOT, KEY, summary, 2)
check("tampered-chunk", report["status"] == "retained" and report["directoryRemoved"] is False
      and report["retained"] == [{"name": "chunk-000001.json", "reason": "digest"}]
      and "./chunk-000001.json" not in [path for path, _ in tree.removed]
      and KEYDIR + "/chunk-000001.json" in tree.entries and tree.rmdired == [])
discipline(tree)

tree, summary = fresh_tree()
del tree.entries[KEYDIR + "/summary.json"]
tree.add_link(KEYDIR + "/summary.json", "/etc/passwd")
report = build_engine(tree, engine_path)["chunked_manifest_trim"](ROOT, KEY, summary, 2)
check("link-entry", report["status"] == "retained" and report["directoryRemoved"] is False
      and report["errors"] == ["summary.json:LINK_OR_REPARSE_POINT"]
      and KEYDIR + "/summary.json" in tree.entries and tree.entries[KEYDIR + "/summary.json"][0] == "l"
      and "./summary.json" not in [path for path, _ in tree.removed] and tree.rmdired == [])
discipline(tree)

tree, summary = fresh_tree()
tree.fail_chdir = {KEYDIR}
report = build_engine(tree, engine_path)["chunked_manifest_trim"](ROOT, KEY, summary, 2)
check("parent-entry-failure", report["status"] == "retained" and report["removed"] == []
      and tree.removed == [] and tree.rmdired == [] and len(report["errors"]) == 3
      and all("PARENT_CD_FAILED" in error for error in report["errors"])
      and all(path in tree.entries for path in
              (KEYDIR + "/summary.json", KEYDIR + "/chunk-000000.json", KEYDIR + "/chunk-000001.json")))

tree, summary = fresh_tree()
tree.swap = {KEYDIR + "/chunk-000000.json"}
report = build_engine(tree, engine_path)["chunked_manifest_trim"](ROOT, KEY, summary, 2)
check("swap-after-cd", report["status"] == "retained" and report["directoryRemoved"] is False
      and report["retained"] == [{"name": "chunk-000000.json", "reason": "identity-after-cd"}]
      and "./chunk-000000.json" not in [path for path, _ in tree.removed]
      and KEYDIR + "/chunk-000000.json" in tree.entries
      and sorted(path for path, _ in tree.removed) == ["./chunk-000001.json", "./summary.json"])
discipline(tree)
