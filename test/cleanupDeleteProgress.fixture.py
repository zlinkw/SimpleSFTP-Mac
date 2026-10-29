"""v1.9 FakeOS migration of the managed-progress counting contract.

Progress must count the frozen approved inventory without ever reading file
contents and without following children created later. No real deletion
approval exists in this round, so the counting runs against the shared fake
tree; the fake open refuses binary content reads, proving the weight-free
claim. The counting primitives under test (inspect/managed_delete_progress/
delete_file) are the surviving legacy observation helpers, unchanged.
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fastdelete_harness as H

ROOT = "/srv/proj"
tree = H.Tree(ROOT)
tree.seed_base()
tree.add_dir(ROOT + "/output")
tree.add_dir(ROOT + "/output/job")
tree.add_file(ROOT + "/output/job/one.bin", b"123")
tree.add_file(ROOT + "/output/job/two.bin", b"12345")
engine = H.build_engine(tree, sys.argv[1], {"refuse_reads": True})
engine["root_guard"](ROOT)

target = {"relativePath": "output/job", "destination": "clean_dir/output/job", "type": "directory",
          "authorizationMode": "confirmed_paths"}
target = {**target, **engine["inspect"](ROOT, target)}
progress = engine["managed_delete_progress"](ROOT, target)
assert progress == {"removedEntries": 0, "totalEntries": 3, "removedBytes": 0, "totalBytes": 8}, progress
row = next(row for row in target["inventory"] if row["path"] == "one.bin")
engine["delete_file"](ROOT, ROOT + "/output/job/one.bin", row, metadata_only=True)
progress = engine["managed_delete_progress"](ROOT, target)
assert progress == {"removedEntries": 1, "totalEntries": 3, "removedBytes": 3, "totalBytes": 8}, progress
assert tree.entries[ROOT + "/output/job/two.bin"][2] == b"12345"
assert tree.reads == []  # counting never opened a single content byte
print(json.dumps({"ok": True, "actualRemainingFiles": True}))
