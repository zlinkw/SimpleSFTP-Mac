"""v1.9 FakeOS migration of the confirmed hardlink contract.

The fast chain binds deletion to the confirmed entry's dev/inode; directory
aliases (hardlinks) elsewhere keep their name and bytes, and an entry replaced
between inspect and delete is refused with a proven zero-mutation fact. The
real-filesystem hardlink e2e stays a real-fixture phase item: no real deletion
approval exists in this round, so every mutation here runs on the shared
in-memory fake tree (test/fastdelete_harness.py).
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fastdelete_harness as H

ROOT = "/srv/proj"
engine_path = sys.argv[1]
tree = H.Tree(ROOT)
tree.seed_base()
tree.add_dir(ROOT + "/src")
tree.add_dir(ROOT + "/outputs")
tree.add_dir(ROOT + "/outputs/job-a")
tree.add_file(ROOT + "/src/keep.py", b"preserve this source")
tree.add_alias(ROOT + "/outputs/job-a/source.py", ROOT + "/src/keep.py")
tree.add_alias(ROOT + "/outputs/job-a/source-copy.py", ROOT + "/src/keep.py")
tree.add_file(ROOT + "/outputs/job-a/best.pth", b"internal checkpoint")
tree.add_alias(ROOT + "/outputs/job-a/last.pth", ROOT + "/outputs/job-a/best.pth")
engine = H.build_engine(tree, engine_path)
refusal = H.make_refusal(engine)
root, identity = engine["root_guard"](ROOT)


def inspect_row(rel, expected_type):
    result = engine["batch_inspect"](root, identity, {"authorizationMode": "confirmed_paths",
                                                      "operationId": "fixture-hardlinks",
                                                      "targets": [{"relativePath": rel, "type": expected_type}]})
    assert result["ok"] and len(result["targets"]) == 1 and not result["targets"][0].get("missing")
    return result["targets"][0]


def entry_of(row):
    value = {key: row[key] for key in ("relativePath", "type", "absolutePath", "device", "inode") if key in row}
    if row.get("isolationName"):
        value["isolationName"] = row["isolationName"]
    return value


# 1. Frozen directory batch deletion never touches an alias outside the tree.
row = inspect_row("outputs/job-a", "directory")
receipt = engine["delete_fast"](root, identity, {"rootIdentity": identity, "operationId": "fixture-hardlinks",
                                                 "authorizationMode": "confirmed_paths", "entries": [entry_of(row)]})
assert receipt["ok"]
aliases_preserved = (tree.entries.get(ROOT + "/src/keep.py", (None, None, None))[2] == b"preserve this source"
                     and ROOT + "/outputs/job-a" not in tree.entries
                     and ROOT + "/outputs/job-a/source.py" not in tree.entries
                     and ROOT + "/outputs/job-a/best.pth" not in tree.entries)

# 2. A file entry replaced between inspection and deletion is refused before
#    any mutation: proven zero-mutation fact, nothing removed.
tree.add_dir(ROOT + "/outputs/job-b")
tree.add_file(ROOT + "/outputs/job-b/weight.pth", b"v1")
row = inspect_row("outputs/job-b/weight.pth", "file")
removed_before = len(tree.removed)
del tree.entries[ROOT + "/outputs/job-b/weight.pth"]
tree.add_file(ROOT + "/outputs/job-b/weight.pth", b"v2 replaced after confirmation")
refusal(lambda: engine["delete_fast"](root, identity, {"rootIdentity": identity, "operationId": "fixture-hardlinks",
                                                       "authorizationMode": "confirmed_paths",
                                                       "entries": [entry_of(row)]}), "ENTRY_IDENTITY_CHANGED")
changed_content_rejected = (engine["FAST_MUTATION_FACTS"]["started"] is False
                            and len(tree.removed) == removed_before
                            and tree.entries[ROOT + "/outputs/job-b/weight.pth"][2] == b"v2 replaced after confirmation")

print(json.dumps({"ok": True, "aliasesPreserved": aliases_preserved, "changedContentRejected": changed_content_rejected}))
