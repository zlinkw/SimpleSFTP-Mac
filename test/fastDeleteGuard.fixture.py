"""P0 pure in-memory guard for the v1.9 fast confirmed-path deletion chain.

Nothing here touches the real filesystem beyond reading the engine source:
the engine's `os`/`open` module globals are replaced with an in-memory tree,
so delete-fast, fast_tree_remove, batch_inspect and batch_verify run against
fake entries only. Faithful emulations replace only the syscalls the fake tree
cannot model (rename via no_replace, completion-control writes); everything
else (path_guard, parent_cd, fast_tree_remove, identity checks) is the real
engine code. Scenarios prove:
  1. dir-isolate        - a selected directory is renamed non-overwriting to
                          its deterministic isolation name, then only that new
                          name is removed; every unlink/rmdir argument is
                          exactly "./<leaf>" under the verified cwd chain;
                          unselected neighbours survive;
  2. original-recreated - a result recreated at the original path after the
                          isolation rename is preserved and reported;
  3. identity-refused   - a swapped entry refuses in the pre-mutation pass
                          with zero filesystem changes;
  4. isolation-taken    - a pre-existing isolation name refuses; the original
                          path is never deleted directly;
  5. link-in-tree       - a symlinked descendant refuses the walk and stands;
  6. clean-dir-guard    - an archived-area descendant under a live directory
                          refuses the walk;
  7. dev-crossing       - a foreign-device child refuses as mount escape;
  8. files-grouped      - scattered files share one verified parent-cd per
                          direct parent; neighbours outside the selection stand;
  9. files-swap         - one swapped file refuses the whole batch before any
                          unlink;
 10. archived-registered- a registered isolated artifact deletes without any
                          rename and records the completion control;
 11. archived-unknown   - an unregistered clean_dir subtree refuses;
 12. deep-tree          - an over-deep tree refuses with TREE_TOO_DEEP;
 13. batch-inspect      - entry-only metadata rows (device/inode/isolation
                          name), never descendant lists;
 14. batch-verify       - presence query distinguishes gone / present /
                          replaced.
"""
import io, json, ntpath, posixpath, runpy, stat, sys, types

# Virtual paths model the remote POSIX filesystem: the pure path layer is
# posixpath-based on every host so Windows hosts cannot leak ntpath semantics
# into slash-keyed entries. Real engine/repo file access keeps host paths.

ROOT = "/srv/proj"
JOB = "job-" + "a" * 48
JOB_REL = "clean_dir/" + JOB + "/out"
OP = "cleanup-" + "b" * 32


def engine_control_hash(rel):
    import hashlib
    return hashlib.sha256(("isolation:" + posixpath.normcase(rel)).encode("utf-8")).hexdigest()


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
        self.renamed = []
        self.controls = []
        self.cwd = ROOT
        self.swap = set()
        self.recreate_after_rename = False

    def add_dir(self, path, dev=7):
        self.ino += 1
        self.entries[path] = ("d", St(stat.S_IFDIR | 0o755, self.ino, dev=dev), None)

    def add_file(self, path, data, dev=7):
        self.ino += 1
        self.entries[path] = ("f", St(stat.S_IFREG | 0o644, self.ino, size=len(data), dev=dev,
                                      mtime_ns=1000000 + self.ino), data)

    def add_link(self, path, target):
        self.ino += 1
        self.entries[path] = ("l", St(stat.S_IFLNK | 0o777, self.ino), target)

    def resolve(self, path):
        path = path if str(path).startswith("/") else self.cwd + "/" + str(path)
        return posixpath.normpath(path)

    def identity(self, path):
        entry = self.entries[self.resolve(path)]
        return {"device": str(entry[1].st_dev), "inode": str(entry[1].st_ino)}


def base_tree():
    tree = Tree()
    for directory in ("/", "/srv", ROOT, ROOT + "/out", ROOT + "/logs"):
        tree.add_dir(directory)
    return tree


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
        "expanduser": lambda path: path if path != "~" else "/root",
        "abspath": lambda path: posixpath.normpath(path if posixpath.isabs(path) else tree.cwd + "/" + path),
        "sep": "/",
    })
    fake_os = types.SimpleNamespace(
        name="posix", sep="/", path=types.SimpleNamespace(**pure),
        lstat=lstat, stat=lstat, listdir=listdir, chdir=chdir, getcwd=lambda: tree.cwd,
        unlink=remove, remove=remove, rmdir=rmdir, environ={}, getuid=lambda: 0,
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


def scenario_engine(extra=None):
    tree = base_tree()
    if extra:
        extra(tree)
    return tree, build_engine(tree, engine_path)


def call_delete_fast(engine, tree, entries):
    root, identity = engine["root_guard"](ROOT)
    return engine["delete_fast"](root, identity, {"rootIdentity": identity, "operationId": OP,
                                                  "authorizationMode": "confirmed_paths", "entries": entries})


def entry_for(tree, rel, expected_type, **overrides):
    value = {"relativePath": rel, "type": expected_type}
    value.update(tree.identity(ROOT + "/" + rel))
    value.update(overrides)
    return value


def discipline(tree):
    for path, cwd in tree.removed + tree.rmdired:
        assert path.startswith("./") and "/" not in path[2:], path
        assert cwd.startswith(ROOT), cwd


def refusal(engine, call, code):
    try:
        call()
    except engine["GuardError"] as error:
        assert error.code == code, "expected " + code + " got " + error.code
        return error
    raise AssertionError("expected refusal " + code)


def check(name, condition):
    if not condition:
        raise AssertionError("scenario failed: " + name)
    print("ok " + name)


engine_path = sys.argv[1]

# 1. whole-tree directory: deterministic isolate name, ./<leaf> discipline.
def seed_run(tree):
    tree.add_dir(ROOT + "/out/run1")
    tree.add_file(ROOT + "/out/run1/a.log", b"aa")
    tree.add_file(ROOT + "/out/run1/b.log", b"bbb")
    tree.add_dir(ROOT + "/out/run1/sub")
    tree.add_file(ROOT + "/out/run1/sub/deep.txt", b"deep")
    tree.add_file(ROOT + "/out/sib.log", b"keep")

tree, engine = scenario_engine(seed_run)
iso = engine["isolation_name"](OP, "out/run1", "run1")
result = call_delete_fast(engine, tree, [entry_for(tree, "out/run1", "directory", isolationName=iso)])
receipt = result["receipt"]["receipts"][0]
check("dir-isolate", result["receipt"]["metrics"]["renames"] == 1
      and receipt["isolationRelativePath"] == "out/" + iso and receipt["originalPathRecreated"] is False
      and ROOT + "/out/run1" not in tree.entries and ROOT + "/out/" + iso not in tree.entries
      and ROOT + "/out/sib.log" in tree.entries
      and result["receipt"]["metrics"]["unlinkedFiles"] == 3 and result["receipt"]["metrics"]["treeDirsRemoved"] == 2
      and tree.renamed == [("./run1", "./" + iso, ROOT + "/out")]
      and sorted(path for path, _ in tree.removed) == ["./a.log", "./b.log", "./deep.txt"]
      and any(path == "./deep.txt" and cwd == ROOT + "/out/" + iso + "/sub" for path, cwd in tree.removed)
      and tree.rmdired == [("./sub", ROOT + "/out/" + iso), ("./" + iso, ROOT + "/out")])
discipline(tree)

# 2. original path recreated after the rename is preserved, never re-moved.
tree, engine = scenario_engine(seed_run)
iso = engine["isolation_name"](OP, "out/run1", "run1")
tree.recreate_after_rename = True
result = call_delete_fast(engine, tree, [entry_for(tree, "out/run1", "directory", isolationName=iso)])
check("original-recreated", result["receipt"]["receipts"][0]["originalPathRecreated"] is True
      and ROOT + "/out/run1/new-result.bin" in tree.entries and ROOT + "/out/" + iso not in tree.entries)
discipline(tree)

# 3. swapped entry: refusal in the pre-mutation pass, zero filesystem changes.
tree, engine = scenario_engine(seed_run)
bad = entry_for(tree, "out/run1", "directory")
bad["inode"] = str(int(bad["inode"]) + 555)
refusal(engine, lambda: call_delete_fast(engine, tree, [bad]), "ENTRY_IDENTITY_CHANGED")
check("identity-refused-zero-mutation", tree.removed == [] and tree.rmdired == [] and tree.renamed == []
      and ROOT + "/out/run1" in tree.entries)

# 4. isolation name already taken: refuse, original stands, never delete original directly.
def seed_taken(tree):
    seed_run(tree)
    tree.add_file(ROOT + "/out/" + iso, b"occupied")

tree, engine = scenario_engine(seed_taken)
refusal(engine, lambda: call_delete_fast(engine, tree, [entry_for(tree, "out/run1", "directory", isolationName=iso)]),
        "ISOLATION_NAME_TAKEN")
check("isolation-name-taken", tree.removed == [] and tree.rmdired == [] and tree.renamed == []
      and ROOT + "/out/run1" in tree.entries and ROOT + "/out/" + iso in tree.entries)

# 5. symlinked descendant refuses the walk and stands.
def seed_link(tree):
    tree.add_dir(ROOT + "/out/run2")
    tree.add_file(ROOT + "/out/run2/keep.log", b"x")
    tree.add_link(ROOT + "/out/run2/link", "/etc/passwd")

tree, engine = scenario_engine(seed_link)
iso2 = engine["isolation_name"](OP, "out/run2", "run2")
refusal(engine, lambda: call_delete_fast(engine, tree, [entry_for(tree, "out/run2", "directory")]),
        "LINK_OR_REPARSE_POINT")
check("link-in-tree-refused", ROOT + "/out/" + iso2 + "/link" in tree.entries and "./link" not in [p for p, _ in tree.removed]
      and ROOT + "/out/run2" not in tree.entries and len(tree.renamed) == 1)

# 6. archived-area descendant under a live directory refuses the walk.
def seed_clean(tree):
    tree.add_dir(ROOT + "/out/run3")
    tree.add_file(ROOT + "/out/run3/ok.log", b"x")
    tree.add_dir(ROOT + "/out/run3/clean_dir")
    tree.add_file(ROOT + "/out/run3/clean_dir/old.log", b"y")

tree, engine = scenario_engine(seed_clean)
iso3 = engine["isolation_name"](OP, "out/run3", "run3")
refusal(engine, lambda: call_delete_fast(engine, tree, [entry_for(tree, "out/run3", "directory")]),
        "PROTECTED_DESCENDANT")
check("clean-dir-guard-refused", ROOT + "/out/" + iso3 + "/clean_dir/old.log" in tree.entries
      and len(tree.renamed) == 1 and "./old.log" not in [p for p, _ in tree.removed])

# 7. foreign-device child refuses as mount escape.
def seed_dev(tree):
    tree.add_dir(ROOT + "/out/run4")
    tree.add_file(ROOT + "/out/run4/foreign.bin", b"z", dev=8)

tree, engine = scenario_engine(seed_dev)
iso4 = engine["isolation_name"](OP, "out/run4", "run4")
refusal(engine, lambda: call_delete_fast(engine, tree, [entry_for(tree, "out/run4", "directory")]), "MOUNT_ESCAPE")
check("dev-crossing-refused", ROOT + "/out/" + iso4 + "/foreign.bin" in tree.entries and len(tree.renamed) == 1
      and "./foreign.bin" not in [p for p, _ in tree.removed])

# 8. scattered files: one verified parent-cd per direct parent group.
def seed_files(tree):
    tree.add_file(ROOT + "/out/f1.log", b"1")
    tree.add_file(ROOT + "/out/f2.log", b"2")
    tree.add_file(ROOT + "/logs/g1.log", b"3")
    tree.add_file(ROOT + "/out/keep-me.log", b"keep")

tree, engine = scenario_engine(seed_files)
result = call_delete_fast(engine, tree, [entry_for(tree, rel, "file") for rel in
                                         ("out/f1.log", "logs/g1.log", "out/f2.log")])
metrics = result["receipt"]["metrics"]
check("files-grouped-two-parents", metrics["unlinkedFiles"] == 3 and metrics["groups"] == 2
      and sorted(path for path, _ in tree.removed) == ["./f1.log", "./f2.log", "./g1.log"]
      and all(cwd in (ROOT + "/out", ROOT + "/logs") for _, cwd in tree.removed)
      and ROOT + "/out/keep-me.log" in tree.entries and metrics["renames"] == 0
      and {r["parent"]: r["removedFiles"] for r in result["receipt"]["receipts"] if "parent" in r}
          == {"out": 2, "logs": 1})
discipline(tree)

# 9. one swapped file refuses the whole batch before any unlink.
tree, engine = scenario_engine(seed_files)
rows = [entry_for(tree, rel, "file") for rel in ("out/f1.log", "logs/g1.log", "out/f2.log")]
rows[1]["device"] = "999"
refusal(engine, lambda: call_delete_fast(engine, tree, rows), "ENTRY_IDENTITY_CHANGED")
check("files-swap-zero-mutation", tree.removed == [] and ROOT + "/out/f1.log" in tree.entries
      and ROOT + "/logs/g1.log" in tree.entries)

# 10. registered archived artifact: delete without rename, control recorded.
def seed_archived(tree):
    tree.add_dir(ROOT + "/clean_dir")
    tree.add_dir(ROOT + "/clean_dir/.operations")
    tree.add_dir(ROOT + "/clean_dir/.operations/isolation")
    tree.add_dir(ROOT + "/clean_dir/" + JOB)
    tree.add_dir(ROOT + "/clean_dir/" + JOB + "/out")
    tree.add_file(ROOT + "/clean_dir/" + JOB + "/out/old.bin", b"old")
    control = "clean_dir/.operations/isolation/" + engine_control_hash(JOB_REL) + ".json"
    tree.add_file(ROOT + "/" + control, json.dumps({"schemaVersion": 1, "destination": JOB_REL, "state": "isolated",
                                                    "operationId": OP}).encode())


tree, engine = scenario_engine(seed_archived)
result = call_delete_fast(engine, tree, [{"relativePath": JOB_REL, "type": "directory",
                                          **tree.identity(ROOT + "/" + JOB_REL), "size": 0}])
check("archived-registered-no-rename", tree.renamed == [] and result["receipt"]["metrics"]["renames"] == 0
      and ROOT + "/" + JOB_REL not in tree.entries and "./old.bin" in [p for p, _ in tree.removed]
      and tree.controls and tree.controls[-1]["state"] == "deleted" and tree.controls[-1]["destination"] == JOB_REL
      and result["receipt"]["receipts"][0]["mode"] == "registered-isolation")
discipline(tree)

# 11. unregistered clean_dir subtree refuses before any mutation.
def seed_unregistered(tree):
    seed_archived(tree)
    tree.add_dir(ROOT + "/clean_dir/" + JOB + "/ghost")
    tree.add_file(ROOT + "/clean_dir/" + JOB + "/ghost/loot.bin", b"loot")

tree, engine = scenario_engine(seed_unregistered)
rel = "clean_dir/" + JOB + "/ghost"
refusal(engine, lambda: call_delete_fast(engine, tree, [{"relativePath": rel, "type": "directory",
                                                         **tree.identity(ROOT + "/" + rel)}]),
        "NOT_REGISTERED_ISOLATION")
check("archived-unregistered-refused", tree.removed == [] and ROOT + "/clean_dir/" + JOB + "/ghost/loot.bin" in tree.entries)

# 12. over-deep tree refuses with TREE_TOO_DEEP.
def seed_deep(tree):
    tree.add_dir(ROOT + "/out/deep")
    cursor = ROOT + "/out/deep"
    for _ in range(300):
        cursor = cursor + "/n"
        tree.add_dir(cursor)

tree, engine = scenario_engine(seed_deep)
refusal(engine, lambda: call_delete_fast(engine, tree, [entry_for(tree, "out/deep", "directory")]), "TREE_TOO_DEEP")
check("deep-tree-refused", len(tree.renamed) == 1)

# 13. batch-inspect stays entry-only: device/inode/isolation name, never lists.
tree, engine = scenario_engine(seed_run)
root, identity = engine["root_guard"](ROOT)
result = engine["batch_inspect"](root, identity, {"authorizationMode": "confirmed_paths", "operationId": OP,
                                                  "targets": [{"relativePath": "out/run1", "type": "directory"},
                                                              {"relativePath": "out/sib.log", "type": "file"},
                                                              {"relativePath": "out/none.log", "type": "file"}]})
rows = {row["relativePath"]: row for row in result["targets"]}
check("batch-inspect-entry-only", result["metrics"]["entryReads"] == 3 and len(result["targets"]) == 3
      and rows["out/run1"]["isolationName"] == engine["isolation_name"](OP, "out/run1", "run1")
      and "inventory" not in rows["out/run1"] and rows["out/run1"]["device"] == tree.identity(ROOT + "/out/run1")["device"]
      and rows["out/sib.log"]["type"] == "file" and rows["out/none.log"].get("missing") is True)

# 14. batch-verify distinguishes gone / present / replaced.
tree, engine = scenario_engine(seed_run)
root, identity = engine["root_guard"](ROOT)
gone = tree.identity(ROOT + "/out/sib.log")
del tree.entries[ROOT + "/out/sib.log"]
swapped = tree.identity(ROOT + "/out/run1")
del tree.entries[ROOT + "/out/run1"]
tree.add_dir(ROOT + "/out/run1")
result = engine["batch_verify"](root, identity, {"authorizationMode": "confirmed_paths",
                                                 "entries": [{"relativePath": "out/sib.log", "type": "file", **gone},
                                                             {"relativePath": "out/run1", "type": "directory", **swapped},
                                                             {"relativePath": "logs", "type": "directory"}]})
status = {row["relativePath"]: row["status"] for row in result["targets"]}
check("batch-verify-statuses", status == {"out/sib.log": "gone", "out/run1": "replaced", "logs": "present"})

# 15. capability probe: an empty target list is a read-only ABI handshake,
# so a paired integration can detect the fast chain without guessing versions.
tree, engine = scenario_engine()
root, identity = engine["root_guard"](ROOT)
probe = engine["batch_inspect"](root, identity, {"authorizationMode": "confirmed_paths", "operationId": OP, "targets": []})
check("capability-probe", probe["capabilities"] == {"confirmedPathFastDelete": 1, "batchEntryInspect": 1}
      and probe["targets"] == [] and probe["metrics"]["entryReads"] == 0 and tree.removed == [])

# 16. mutation facts: a pre-mutation refusal proves started=False, the batch
# resets the fact, a completed mutation sets it.
def seed_pair(tree):
    tree.add_file(ROOT + "/out/p1.log", b"1")
    tree.add_file(ROOT + "/out/p2.log", b"2")

tree, engine = scenario_engine(seed_pair)
refusal(engine, lambda: call_delete_fast(engine, tree, [entry_for(tree, "out/p1.log", "file", inode="999999")]),
        "ENTRY_IDENTITY_CHANGED")
refused_zero = engine["FAST_MUTATION_FACTS"]["started"] is False and tree.removed == []
call_delete_fast(engine, tree, [entry_for(tree, "out/p1.log", "file")])
mutated_true = engine["FAST_MUTATION_FACTS"]["started"] is True
late = entry_for(tree, "out/p2.log", "file")
late["device"] = "999"
refusal(engine, lambda: call_delete_fast(engine, tree, [late]), "ENTRY_IDENTITY_CHANGED")
check("mutation-facts-reset-and-false", refused_zero and mutated_true
      and engine["FAST_MUTATION_FACTS"]["started"] is False and ROOT + "/out/p2.log" in tree.entries)

# 17. partial mutation: the file-group recheck catches a swapped leaf AFTER an
# earlier unlink of the same batch; the fact must report the partial change so
# the API never reruns the batch blindly.
tree, engine = scenario_engine(seed_pair)
tree.swap.add(ROOT + "/out/p2.log")
rows = [entry_for(tree, rel, "file") for rel in ("out/p1.log", "out/p2.log")]
refusal(engine, lambda: call_delete_fast(engine, tree, rows), "ENTRY_IDENTITY_CHANGED")
check("mutation-facts-partial", engine["FAST_MUTATION_FACTS"]["started"] is True
      and ROOT + "/out/p1.log" not in tree.entries and ROOT + "/out/p2.log" in tree.entries)

# 18. isolate-then-refuse: the rename itself is a mutation; a walk refusal
# afterwards must still report started=True (the tree stands under its iso name).
tree, engine = scenario_engine(seed_deep)
refusal(engine, lambda: call_delete_fast(engine, tree, [entry_for(tree, "out/deep", "directory")]), "TREE_TOO_DEEP")
check("mutation-facts-after-rename", engine["FAST_MUTATION_FACTS"]["started"] is True and len(tree.renamed) == 1)

# 19. host-independent virtual semantics: the ntpath control records exactly
# what host os.path leakage would produce on a Windows host (the v1.11 red),
# while the installed fake layer must stay slash-based on every host. This is
# a deterministic cross-platform model check, not a claimed real-Windows run.
probe_tree, probe_engine = scenario_engine(seed_pair)
fake = probe_engine["delete_fast"].__globals__["os"]
check("virtual-paths-stay-posix-ntpath-control",
      ntpath.normpath(ROOT) == ntpath.sep + "srv" + ntpath.sep + "proj" and ntpath.sep == "\\"
      and fake.name == "posix" and fake.sep == "/"
      and fake.path.normpath(ROOT) == ROOT
      and fake.path.normcase(ROOT + "/Out") == ROOT + "/Out"
      and fake.path.join("out", "p1.log") == "out/p1.log"
      and fake.path.abspath("out/p1.log") == ROOT + "/out/p1.log"
      and fake.path.realpath(ROOT + "/out/../out") == ROOT + "/out")
