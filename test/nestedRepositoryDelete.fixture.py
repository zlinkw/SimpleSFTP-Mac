"""v1.9 FakeOS migration of the nested-repository deletion contract.

A double-confirmed whole subtree may carry nested .git metadata out with it
(the repository marker inside the confirmed scope is an ordinary file), while
the project's own .git outside the confirmed entry is never touched. Path
guards (direct .git nomination, unsafe paths), the retirement of the legacy
confirmed delete route, and clean_dir descendant protection all stay armed:
an interrupted isolation refuses to consume the protected child and reports
honest mutation facts. No real deletion approval exists in this round; every
mutation runs on the shared fake tree.
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fastdelete_harness as H

ROOT = "/srv/proj"
tree = H.Tree(ROOT)
tree.seed_base()
tree.add_dir(ROOT + "/.git")
tree.add_file(ROOT + "/.git/config", b"main repository must survive")
tree.add_dir(ROOT + "/repos")
tree.add_dir(ROOT + "/repos/cpsc")
tree.add_dir(ROOT + "/repos/cpsc/.git")
tree.add_file(ROOT + "/repos/cpsc/.git/config", b"nested repository metadata")
tree.add_file(ROOT + "/repos/cpsc/train.py", b"nested source")
tree.add_dir(ROOT + "/repos/cpsc/work_dirs")
tree.add_file(ROOT + "/repos/cpsc/work_dirs/latest.bin", b"nested result")
tree.add_dir(ROOT + "/jobs")
tree.add_dir(ROOT + "/jobs/run")
tree.add_file(ROOT + "/jobs/run/result.bin", b"job result")
tree.add_dir(ROOT + "/jobs/run/clean_dir")
tree.add_file(ROOT + "/jobs/run/clean_dir/keep.txt", b"protected archive child")
tree.add_dir(ROOT + "/clean_dir")
engine = H.build_engine(tree, sys.argv[1])


def refusal(call, code):
    try:
        call()
    except engine["GuardError"] as error:
        assert error.code == code, (error.code, code)
        return error
    raise AssertionError("expected GuardError " + code)


root, identity = engine["root_guard"](ROOT)


def fast(rel, expected_type, operation="fixture-subtree"):
    insp = engine["batch_inspect"](root, identity, {"authorizationMode": "confirmed_paths",
                                                    "operationId": operation,
                                                    "targets": [{"relativePath": rel, "type": expected_type}]})
    row = insp["targets"][0]
    entry = {key: row[key] for key in ("relativePath", "type", "absolutePath", "device", "inode") if key in row}
    if row.get("isolationName"):
        entry["isolationName"] = row["isolationName"]
    return entry


def execute(entries, operation="fixture-subtree"):
    return engine["delete_fast"](root, identity, {"rootIdentity": identity, "operationId": operation,
                                                  "authorizationMode": "confirmed_paths", "entries": entries})


guards = True
# Directly nominating the main repository or unsafe paths stays refused.
guards &= refusal(lambda: fast(".git", "directory"), "PROTECTED_PATH").code == "PROTECTED_PATH"
unsafe = {"relativePath": "../outside", "type": "directory", "device": "7", "inode": "1"}
guards &= refusal(lambda: execute([unsafe]), "UNSAFE_PATH").code == "UNSAFE_PATH"
# The legacy confirmed delete route is retired, never a silent fallback.
guards &= refusal(lambda: engine["main"]({"root": ROOT, "action": "delete",
                                          "target": {"relativePath": "repos/cpsc", "type": "directory",
                                                     "authorizationMode": "confirmed_paths"}}),
                  "UPDATE_REQUIRED").code == "UPDATE_REQUIRED"

# The confirmed whole subtree (nested .git included) leaves through the fast
# chain; the main repository outside the entry keeps its bytes.
entry = fast("repos/cpsc", "directory")
assert execute([entry])["ok"]
nested_git_removed = not any(path.startswith(ROOT + "/repos/cpsc") for path in tree.entries)
main_git_protected = tree.entries[ROOT + "/.git/config"][2] == b"main repository must survive"

# A clean_dir descendant inside another confirmed tree is never consumed:
# isolation may have started, but the protected child and its bytes survive
# and the mutation fact honestly reports the partial isolation.
entry = fast("jobs/run", "directory", operation="fixture-protected")
removed_before = len(tree.removed)
refusal(lambda: execute([entry], operation="fixture-protected"), "PROTECTED_DESCENDANT")
guards &= engine["FAST_MUTATION_FACTS"]["started"] is True
survivors = [path for path in tree.entries
             if path.startswith(ROOT + "/jobs/") and path.endswith("/clean_dir/keep.txt")]
guards &= len(survivors) == 1 and tree.entries[survivors[0]][2] == b"protected archive child"
guards &= ROOT + "/jobs/run" not in tree.entries  # isolated but NOT deleted
guards &= len(tree.removed) == removed_before  # walk refused before consuming anything

print(json.dumps({"ok": True, "nestedGitRemoved": bool(nested_git_removed),
                  "mainGitProtected": bool(main_git_protected), "guardsRetained": bool(guards),
                  "mockedDeletion": True}))
