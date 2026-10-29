"""v1.9 FakeOS migration: confirmed managed deletion is retired fail-closed.

The managed tmux deletion window for confirmed paths no longer exists: the
engine main() gate must reject the retired destructive routes with
UPDATE_REQUIRED (and confirmed non-delete actions with
INVALID_AUTHORIZATION_MODE) before any mutation, tmux call, or control write.
Read-only managed OBSERVATION is not a deletion route and stays live, so it
is deliberately not exercised here. The real-tmux managed lifecycle e2e is
deferred to the real-fixture phase; no real deletion approval exists in this
round, so this fixture proves only the fail-closed retirement and that the
retirement errors carry no receipt/journal payload.
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fastdelete_harness as H

ROOT = "/srv/proj"
tree = H.Tree(ROOT)
tree.seed_base()
tree.add_dir(ROOT + "/outputs")
tree.add_dir(ROOT + "/outputs/remove")
tree.add_file(ROOT + "/outputs/remove/result.bin", b"payload")
tree.add_dir(ROOT + "/clean_dir")
engine = H.build_engine(tree, sys.argv[1])
refusal = H.make_refusal(engine)
engine["root_guard"](ROOT)

target = {"relativePath": "outputs/remove", "destination": "clean_dir/outputs/remove", "type": "directory",
          "authorizationMode": "confirmed_paths"}
errors = [
    refusal(lambda: engine["main"]({"root": ROOT, "action": "delete", "target": dict(target)}), "UPDATE_REQUIRED"),
    refusal(lambda: engine["main"]({"root": ROOT, "action": "managed-start", "cleanupAction": "delete",
                                    "tmuxSessionPrefix": "research", "target": dict(target)}), "UPDATE_REQUIRED"),
    refusal(lambda: engine["main"]({"root": ROOT, "action": "move", "target": dict(target)}),
            "INVALID_AUTHORIZATION_MODE"),
]
retired = [error.code for error in errors] == ["UPDATE_REQUIRED", "UPDATE_REQUIRED", "INVALID_AUTHORIZATION_MODE"]

# Fail-closed means untouched: no window opened, nothing renamed or removed,
# and the retirement errors carry no receipt/journal payload.
untouched = tree.removed == [] and tree.renamed == [] and tree.controls == [] \
    and ROOT + "/outputs/remove/result.bin" in tree.entries
no_receipt_payload = all(not hasattr(error, "receipt") and not hasattr(error, "journal")
                         and not hasattr(error, "payload") for error in errors)

print(json.dumps({"ok": True, "managedDeleteRetired": bool(retired and untouched and no_receipt_payload),
                  "receiptsRequired": False}))
