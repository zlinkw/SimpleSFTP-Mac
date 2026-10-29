"""v1.9 FakeOS migration of the confirmed exact-path guard contract.

Guards retained on the legal fast entry (delete-fast/batch-inspect): canonical
parent refusal, declared-type mismatch, symlink entries, and the retirement
gate on the legacy confirmed routes (UPDATE_REQUIRED / INVALID_AUTHORIZATION_
MODE) checked via main(). Stale task/owner metadata gates must never be
consulted: they are installed to raise, and the deletion still completes,
proving the fast chain ignores them while a same-inode content edit stays
inside the confirmed entry scope by design (v1.9 entry-identity binding; the
replacement refusal case lives in confirmedHardlinkDelete). No real deletion
approval exists in this round, so all mutations run on the fake tree.
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fastdelete_harness as H

ROOT = "/srv/proj"
engine_path = sys.argv[1]
tree = H.Tree(ROOT)
tree.seed_base()
tree.add_dir(ROOT + "/output")
tree.add_file(ROOT + "/output/job.txt", b"fixture only")
tree.add_link(ROOT + "/output/link", ROOT + "/output/job.txt")
tree.add_dir(ROOT + "/clean_dir")
engine = H.build_engine(tree, engine_path)
refusal = H.make_refusal(engine)


def stale(*args, **kwargs):
    raise engine["GuardError"]("STALE_METADATA_GATE")


for name in ("tracked_dirty", "open_handles", "managed_active"):
    engine["delete_fast"].__globals__[name] = stale

root, identity = engine["root_guard"](ROOT)


def fast(entries):
    return engine["delete_fast"](root, identity, {"rootIdentity": identity, "operationId": "confirmed-fixture",
                                                  "authorizationMode": "confirmed_paths", "entries": entries})


def entry(rel, expected_type):
    return {"relativePath": rel, "type": expected_type, **tree.identity(ROOT + "/" + rel)}


unsafe = {"relativePath": "../outside", "type": "file", "device": "7", "inode": "1"}
guards = True
guards &= refusal(lambda: fast([unsafe]), "UNSAFE_PATH").code == "UNSAFE_PATH"
guards &= refusal(lambda: fast([entry("output/job.txt", "directory")]), "TYPE_CHANGED").code == "TYPE_CHANGED"
guards &= refusal(lambda: fast([entry("output/link", "file")]), "LINK_OR_REPARSE_POINT").code == "LINK_OR_REPARSE_POINT"
guards &= tree.removed == []

# Legacy confirmed routes are retired fail-closed, never a silent fallback.
guards &= refusal(lambda: engine["main"]({"root": ROOT, "action": "delete",
                                          "target": {"relativePath": "output/job.txt", "type": "file",
                                                     "authorizationMode": "confirmed_paths"}}),
                  "UPDATE_REQUIRED").code == "UPDATE_REQUIRED"
guards &= refusal(lambda: engine["main"]({"root": ROOT, "action": "move",
                                          "target": {"relativePath": "output/job.txt", "type": "file",
                                                     "authorizationMode": "confirmed_paths",
                                                     "destination": "clean_dir/output/job.txt"}}),
                  "INVALID_AUTHORIZATION_MODE").code == "INVALID_AUTHORIZATION_MODE"
guards &= refusal(lambda: engine["main"]({"root": ROOT, "action": "managed-start", "cleanupAction": "delete",
                                          "target": {"relativePath": "output/job.txt", "type": "file",
                                                     "authorizationMode": "confirmed_paths",
                                                     "destination": "clean_dir/output/job.txt"}}),
                  "UPDATE_REQUIRED").code == "UPDATE_REQUIRED"
guards &= tree.removed == [] and tree.renamed == [] and tree.controls == []

# A same-inode content edit inside the confirmed file does not resurrect the
# stale metadata gates: deletion completes through the entry-bound fast chain.
insp = engine["batch_inspect"](root, identity, {"authorizationMode": "confirmed_paths",
                                                "operationId": "confirmed-fixture",
                                                "targets": [{"relativePath": "output/job.txt", "type": "file"}]})
row = insp["targets"][0]
tree.entries[ROOT + "/output/job.txt"] = ("f", tree.entries[ROOT + "/output/job.txt"][1], b"changed after preview")
receipt = fast([{key: row[key] for key in ("relativePath", "type", "absolutePath", "device", "inode") if key in row}])
exact_path_deleted = receipt["ok"] and ROOT + "/output/job.txt" not in tree.entries and tree.reads == []

print(json.dumps({"ok": True, "exactPathDeleted": bool(exact_path_deleted), "guardsRetained": bool(guards)}))
