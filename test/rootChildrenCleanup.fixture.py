"""v1.9 FakeOS migration of the project-root-children contract.

Presence and preview keep running through the live main() inspect/inventory
routes (unchanged by v1.9), so path/symlink/mount/protected guards are still
exercised end-to-end. Execution moved to the entry-bound fast chain, so the
delete scenarios use batch_inspect + delete_fast directly: content edits on
the SAME entry proceed (entry-identity binding replaces the old frozen-manifest
PREVIEW_CHANGED gate), while a replaced entry refuses with the proven
zero-mutation fact. The physical-parent checks (PARENT_CD_FAILED on refusing
or stuck chdir, root/outside refusals) are re-enacted against the fake tree.
No real deletion approval exists in this round; every mutation is in-memory.
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fastdelete_harness as H

ROOT = "/srv/proj"
tree = H.Tree(ROOT)
tree.seed_base()
tree.add_dir(ROOT + "/.git")
tree.add_file(ROOT + "/.git/config", b"protected main repository")
tree.add_dir(ROOT + "/clean_dir")
tree.add_dir(ROOT + "/clean_dir/fixture-only")
tree.add_dir("/srv/base")
tree.add_file("/srv/base/outside.txt", b"untouched")
tree.add_file(ROOT + "/runtime_manifest.json", b'{"fixture":true}')
tree.add_dir(ROOT + "/root-folder")
tree.add_dir(ROOT + "/root-folder/sub")
tree.add_file(ROOT + "/root-folder/sub/value.txt", b"fixture only")
tree.add_link(ROOT + "/runtime_manifest_link", ROOT + "/runtime_manifest.json")
engine = H.build_engine(tree, sys.argv[1])
env = engine["main"].__globals__


def target(name, kind="file"):
    return {"relativePath": name, "destination": "clean_dir/" + name, "type": kind,
            "authorizationMode": "confirmed_paths"}


def denied(call, code):
    try:
        call()
    except engine["GuardError"] as error:
        assert error.code == code, (error.code, code)
        return error
    raise AssertionError("unsafe target accepted: " + code)


# Live presence + metadata preview through main() (routes unchanged by v1.9).
for name, kind in (("runtime_manifest.json", "file"), ("root-folder", "directory")):
    t = target(name, kind)
    assert not engine["main"]({"root": ROOT, "action": "inventory", "target": t,
                               "presenceOnly": True, "allowMissing": True})["target"]["missing"]
    value = engine["main"]({"root": ROOT, "action": "inspect", "target": t})
    assert value["target"]["parent"] == ROOT
    assert value["target"]["fingerprintMode"] == "metadata"
assert engine["main"]({"root": ROOT, "action": "inventory", "target": target("missing.json"),
                       "presenceOnly": True, "allowMissing": True})["target"]["missing"]
denied(lambda: engine["main"]({"root": ROOT, "action": "inspect", "target": target("runtime_manifest.json", "directory")}),
       "TYPE_CHANGED")
for rel in [".", "..", "", "../outside.txt", "/absolute", "root-folder/*"]:
    denied(lambda rel=rel: engine["main"]({"root": ROOT, "action": "inspect", "target": target(rel)}), "UNSAFE_PATH")
for rel in [".git", ".git/config", "clean_dir"]:
    denied(lambda rel=rel: engine["main"]({"root": ROOT, "action": "inspect", "target": target(rel, "directory")}),
           "PROTECTED_PATH")
denied(lambda: engine["main"]({"root": ROOT, "action": "inventory", "target": target("runtime_manifest_link"),
                               "presenceOnly": True, "allowMissing": True}), "LINK_OR_REPARSE_POINT")
original_mounts = env["mount_points"]
env["mount_points"] = lambda: {ROOT + "/root-folder"}
denied(lambda: engine["main"]({"root": ROOT, "action": "inventory", "target": target("root-folder", "directory"),
                               "presenceOnly": True, "allowMissing": True}), "MOUNT_ESCAPE")
env["mount_points"] = original_mounts

# The real parent guard still rejects the project root itself and outside targets.
for full in [ROOT, "/srv/base/outside.txt"]:
    denied(lambda full=full: engine["parent_cd"](ROOT, full), "PARENT_CD_FAILED")

root, identity = engine["root_guard"](ROOT)


def fast(rel, expected_type, operation="fixture-root-child"):
    insp = engine["batch_inspect"](root, identity, {"authorizationMode": "confirmed_paths",
                                                    "operationId": operation,
                                                    "targets": [{"relativePath": rel, "type": expected_type}]})
    row = insp["targets"][0]
    entry = {key: row[key] for key in ("relativePath", "type", "absolutePath", "device", "inode") if key in row}
    if row.get("isolationName"):
        entry["isolationName"] = row["isolationName"]
    return entry


def execute(entries, operation="fixture-root-child"):
    return engine["delete_fast"](root, identity, {"rootIdentity": identity, "operationId": operation,
                                                  "authorizationMode": "confirmed_paths", "entries": entries})


# Identity replacement after preview refuses with a proven zero-mutation fact
# (successor of the frozen-manifest PREVIEW_CHANGED binding).
entry = fast("runtime_manifest.json", "file")
del tree.entries[ROOT + "/runtime_manifest.json"]
tree.add_file(ROOT + "/runtime_manifest.json", b'{"changed":"after preview"}')
denied(lambda: execute([entry]), "ENTRY_IDENTITY_CHANGED")
assert tree.removed == [] and engine["FAST_MUTATION_FACTS"]["started"] is False

# Physical-parent refusals on the fake tree: refusing chdir, then a silent
# no-op chdir whose getcwd mismatch must be detected.
entry = fast("runtime_manifest.json", "file")
tree.fail_chdir = True
denied(lambda: execute([entry]), "PARENT_CD_FAILED")
tree.fail_chdir = False
assert tree.removed == []
tree.stuck_cwd = ROOT + "/clean_dir/fixture-only"
denied(lambda: execute([entry]), "PARENT_CD_FAILED")
tree.stuck_cwd = None
assert tree.removed == []

# Approved root children delete through ./<leaf> primitives; a same-entry
# content edit inside the confirmed file no longer resurrects old metadata
# gates (entry-identity binding). A directory isolates, then walks ./leaves.
tree.entries[ROOT + "/runtime_manifest.json"] = ("f", tree.entries[ROOT + "/runtime_manifest.json"][1],
                                                 b'{"changed":"after preview"}')
assert execute([entry])["ok"]
folder_entry = fast("root-folder", "directory")
assert execute([folder_entry], operation="fixture-root-child")["ok"]
assert ROOT + "/runtime_manifest.json" not in tree.entries and ROOT + "/root-folder" not in tree.entries
assert all(name.startswith("./") and "/" not in name[2:] for name, _ in tree.removed + tree.rmdired)
assert ("./runtime_manifest.json", ROOT) in tree.removed
assert tree.entries[ROOT + "/.git/config"][2] == b"protected main repository"
assert tree.entries["/srv/base/outside.txt"][2] == b"untouched"

print(json.dumps({"ok": True, "rootChildren": True, "physicalParentChecked": True,
                  "guardsRetained": True, "mockedDeletion": True}))
