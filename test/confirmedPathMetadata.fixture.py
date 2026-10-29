"""v1.9 FakeOS migration of the metadata-only weight contract.

The confirmed fast chain reads entry metadata only: the fake open raises if
the engine ever opens file contents in binary mode, so weightBytesRead stays
provably zero even for a declared 64-GiB weight file. An entry replaced
between inspection and deletion (identity change) is refused with the
zero-mutation fact; re-inspecting the current identity then deletes cleanly.
Real-fs weight e2e remains a real-fixture phase item (no real deletion
approval exists in this round).
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fastdelete_harness as H

ROOT = "/srv/proj"
engine_path = sys.argv[1]
tree = H.Tree(ROOT)
tree.seed_base()
tree.add_dir(ROOT + "/output")
tree.add_dir(ROOT + "/output/job")
tree.add_file(ROOT + "/output/job/weights.pth", b"header")
tree.entries[ROOT + "/output/job/weights.pth"][1].st_size = 64 * 1024 * 1024 * 1024  # sparse giant
engine = H.build_engine(tree, engine_path, {"refuse_reads": True})
refusal = H.make_refusal(engine)
root, identity = engine["root_guard"](ROOT)


def inspect_row(rel, expected_type):
    result = engine["batch_inspect"](root, identity, {"authorizationMode": "confirmed_paths",
                                                      "operationId": "fixture-metadata",
                                                      "targets": [{"relativePath": rel, "type": expected_type}]})
    assert result["ok"] and result["metrics"]["entryReads"] == 1
    row = result["targets"][0]
    assert not row.get("missing") and "sha256" not in row and "contentFingerprint" not in row, \
        "fast-chain rows must stay metadata-only with no content digest"
    return row


def entry_of(row):
    value = {key: row[key] for key in ("relativePath", "type", "absolutePath", "device", "inode") if key in row}
    if row.get("isolationName"):
        value["isolationName"] = row["isolationName"]
    return value


inspect_row("output/job/weights.pth", "file")

# Entry replaced after inspection: identity refusal with zero mutation.
row = inspect_row("output/job/weights.pth", "file")
del tree.entries[ROOT + "/output/job/weights.pth"]
tree.add_file(ROOT + "/output/job/weights.pth", b"weights v2")
refusal(lambda: engine["delete_fast"](root, identity, {"rootIdentity": identity, "operationId": "fixture-metadata",
                                                       "authorizationMode": "confirmed_paths",
                                                       "entries": [entry_of(row)]}), "ENTRY_IDENTITY_CHANGED")
metadata_change_rejected = engine["FAST_MUTATION_FACTS"]["started"] is False and tree.removed == []

# Current identity confirms clean: directory deletion streams the giant file
# away through ./<leaf> unlinks without a single content read.
row = inspect_row("output/job", "directory")
receipt = engine["delete_fast"](root, identity, {"rootIdentity": identity, "operationId": "fixture-metadata",
                                                 "authorizationMode": "confirmed_paths", "entries": [entry_of(row)]})
assert receipt["ok"] and ROOT + "/output/job" not in tree.entries

print(json.dumps({"ok": True, "weightBytesRead": len(tree.reads), "metadataChangeRejected": metadata_change_rejected}))
