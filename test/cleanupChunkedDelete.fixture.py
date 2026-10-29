"""v1.9 FakeOS migration of the interrupted-archive contract.

The old frozen-chunk journal is retired: the fast chain handles archives of
any size as one confirmed batch. What the five-stage protocol still proves,
with zero real deletion (no real deletion approval exists in this round):
an interrupted isolate-then-delete reports honest mutation facts; the stale
frozen selection is refused against reality (MISSING_TARGET, zero further
mutation) instead of blindly replaying; completion happens only through a
fresh confirmation of the actual isolation tree; a rebuilt same-name
directory is new data that replay never absorbs or touches. Tree state
persists through the state file between stages; every stage runs a fresh
engine under the shared fake OS. The tree is 2000 entries because the
contract under test is interruption/resume honesty, not volume: the v1.9
fast chain is size-agnostic.
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fastdelete_harness as H

ROOT = "/srv/proj"
REL = "work_dirs/run"
OP = "cleanup-interrupted-op"
FILE_COUNT = 2000
ABORT_AFTER_UNLINKS = 800

engine_path, stage, state_path = sys.argv[1], sys.argv[2], sys.argv[3]


def new_tree():
    tree = H.Tree(ROOT)
    tree.seed_base()
    tree.add_dir(ROOT + "/work_dirs")
    tree.add_dir(ROOT + "/" + REL)
    tree.add_dir(ROOT + "/" + REL + "/sub")
    for index in range(FILE_COUNT):
        tree.add_file(ROOT + "/%s/f%05d.log" % (REL, index), b"x")
    tree.add_file(ROOT + "/%s/sub/deep.bin" % REL, b"deep")
    return tree


def save(state, tree):
    payload = dict(state)
    payload["tree"] = tree.to_dict()
    with open(state_path, "w", encoding="utf-8") as stream:
        stream.write(json.dumps(payload))


def load():
    with open(state_path, "r", encoding="utf-8") as stream:
        payload = json.loads(stream.read())
    tree_payload = payload.pop("tree")
    return payload, H.Tree.from_dict(tree_payload)


def engine_for(tree, options=None):
    return H.build_engine(tree, engine_path, options)


def inspect_row(engine, root, identity, rel):
    result = engine["batch_inspect"](root, identity, {"authorizationMode": "confirmed_paths",
                                                      "operationId": OP, "targets": [{"relativePath": rel, "type": "directory"}]})
    assert result["ok"] and len(result["targets"]) == 1 and not result["targets"][0].get("missing")
    return result["targets"][0]


def entry_of(row):
    value = {key: row[key] for key in ("relativePath", "type", "absolutePath", "device", "inode") if key in row}
    if row.get("isolationName"):
        value["isolationName"] = row["isolationName"]
    return value


if stage == "build":
    tree = new_tree()
    engine = engine_for(tree)
    root, identity = engine["root_guard"](ROOT)
    row = inspect_row(engine, root, identity, REL)
    save({"entries": [entry_of(row)], "isoRel": "work_dirs/" + row["isolationName"]}, tree)
    print("ok")
    sys.exit(0)

state, tree = load()
engine = engine_for(tree, {"unlink_limit": ABORT_AFTER_UNLINKS} if stage == "abort" else None)
refusal = H.make_refusal(engine)
root, identity = engine["root_guard"](ROOT)
frozen = state["entries"]
iso_rel = state["isoRel"]


def delete(entries):
    return engine["delete_fast"](root, identity, {"rootIdentity": identity, "operationId": OP,
                                                  "authorizationMode": "confirmed_paths", "entries": entries})


def iso_children():
    prefix = ROOT + "/" + iso_rel + "/"
    return sum(1 for path in tree.entries if path.startswith(prefix))


if stage == "abort":
    # Power loss inside the tree walk: the fake unlink starts failing with
    # EIO after ABORT_AFTER_UNLINKS files. The rename already happened, so the
    # mutation fact must report the partial change.
    try:
        delete(frozen)
        raise AssertionError("interrupted deletion reported success")
    except OSError as error:
        assert error.errno == 5, error
    assert engine["FAST_MUTATION_FACTS"]["started"] is True
    assert tree.renamed == [("./run", "./" + frozen[0]["isolationName"], ROOT + "/work_dirs")], tree.renamed
    assert ROOT + "/" + REL not in tree.entries
    assert 0 < len(tree.removed) < FILE_COUNT + 1, len(tree.removed)
    assert ROOT + "/" + iso_rel in tree.entries and iso_children() > 0
    save(state, tree)
    print("ok")
    sys.exit(0)

if stage == "refuse":
    # Blind replay of the stale frozen selection: reality says the original
    # entry is gone; nothing may mutate and unconfirmed leftovers are never
    # absorbed into the old selection.
    new_file = ROOT + "/" + iso_rel + "/late-new.json"
    tree.add_file(new_file, b"created after interruption")
    children_before = iso_children()
    error = refusal(lambda: delete(frozen), "MISSING_TARGET")
    assert error.code == "MISSING_TARGET"
    assert engine["FAST_MUTATION_FACTS"]["started"] is False
    assert tree.removed == [] and tree.renamed == []
    assert iso_children() == children_before and tree.entries[new_file][2] == b"created after interruption"
    assert ROOT + "/" + iso_rel in tree.entries
    save(state, tree)
    print("ok")
    sys.exit(0)

if stage == "complete":
    # Completion arrives only through a fresh confirmation of the isolation
    # tree as it exists now; the second isolate-then-delete clears it exactly.
    row = inspect_row(engine, root, identity, iso_rel)
    second = row["isolationName"]
    delete([entry_of(row)])
    assert ROOT + "/" + iso_rel not in tree.entries
    assert "work_dirs/" + second not in tree.entries or not any(
        path.startswith(ROOT + "/work_dirs/" + second) for path in tree.entries)
    assert ROOT + "/" + REL not in tree.entries
    save(state, tree)
    print("ok")
    sys.exit(0)

if stage == "rebuild":
    # A same-name directory rebuilt afterwards is new data: active verify
    # reports the frozen identity as replaced and demands nothing.
    tree.add_dir(ROOT + "/" + REL)
    tree.add_file(ROOT + "/" + REL + "/new-run.log", b"brand new result")
    verify = engine["batch_verify"](root, identity, {"authorizationMode": "confirmed_paths", "entries": [
        frozen[0], {"relativePath": iso_rel, "type": "directory",
                    "device": frozen[0]["device"], "inode": frozen[0]["inode"]}]})
    statuses = [row["status"] for row in verify["targets"]]
    assert statuses == ["replaced", "gone"], statuses
    assert tree.entries[ROOT + "/" + REL + "/new-run.log"][2] == b"brand new result"
    print("ok")
    sys.exit(0)

raise AssertionError("unknown stage " + stage)
