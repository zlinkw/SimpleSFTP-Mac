"""v1.10 engine contract for batch-observe (FakeOS, zero writes).

One request = one observation round: current filesystem facts per keyed entry,
ONE shared managed-window sweep, isolation probes only for explicitly given
paths, poisoned paths answer only for themselves, and the walk never touches
any mutation primitive (they are booby-trapped to raise). Prints one JSON
verdict line; any assertion failure exits non-zero.
"""
import base64, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fastdelete_harness as H

ROOT = "/srv/proj"
JOB = "clean_dir/job-" + "a" * 48
IDENTITY = {"path": ROOT, "device": "7", "machine": "host", "user": "0"}
engine_path = sys.argv[1]


def pane(window, target, dead="0", root=ROOT, extra=None):
    payload = {"root": root, "operationId": "op-x"}
    if target is not None:
        payload["relativePath"] = target
    if extra:
        payload.update(extra)
    return (window, "%" + window[1:], dead, base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).decode("ascii"))


def build(panes=None, tmux_error=None):
    tree = H.Tree(ROOT)
    tree.seed_base()
    tree.add_dir(ROOT + "/out")
    tree.add_file(ROOT + "/out/keep.log", b"x")
    tree.add_file(ROOT + "/out/other.bin", b"yy")
    tree.add_dir(ROOT + "/out/iso_left")           # isolation residue of out/gone-dir
    tree.add_link(ROOT + "/out/linky", ROOT + "/out/keep.log")
    tree.add_dir(ROOT + "/clean_dir")
    tree.add_dir(ROOT + "/" + JOB)
    tree.add_dir(ROOT + "/" + JOB + "/out1")
    engine = H.build_engine(tree, engine_path)
    real = engine["delete_fast"].__globals__
    calls = {"n": 0}

    def fake_tmux(args):
        calls["n"] += 1
        if tmux_error:
            raise RuntimeError("tmux unavailable")
        assert args[0] == "list-panes", args
        return "\n".join("\t".join(row) for row in (panes or []))

    real["managed_tmux"] = fake_tmux

    def boom(*args, **kwargs):
        raise AssertionError("batch-observe must never mutate (" + str(args[:1]) + ")")

    for name in ("unlink", "remove", "rmdir", "chdir"):
        setattr(real["os"], name, boom)
    real["open"] = boom
    return tree, engine, calls, real


def rows_of(result):
    return {row["key"]: row for row in result["observations"]}


def request(entries, **extra):
    return dict({"observationId": "round-1", "rootIdentity": IDENTITY, "entries": entries}, **extra)


verdict = {}

# 1. current facts, shared single sweep, archived visibility, explicit iso only, zero writes.
tree, engine, calls, real = build()
before = json.dumps(tree.to_dict(), sort_keys=True)
ino = str(tree.entries[ROOT + "/out/keep.log"][1].st_ino)
result = engine["batch_observe"](ROOT, IDENTITY, request([
    {"key": "keep", "relativePath": "out/keep.log", "type": "file", "device": "7", "inode": ino},
    {"key": "gone", "relativePath": "out/gone.log", "type": "file"},
    {"key": "left", "relativePath": "out/gone-dir", "type": "directory", "isolationRelativePath": "out/iso_left"},
    {"key": "arch", "relativePath": JOB + "/out1", "type": "directory"},
]))
assert result["ok"] and result["observationId"] == "round-1" and result["rootIdentity"] == IDENTITY
assert result["capabilities"]["batchCleanupObservation"] == 1
rows = rows_of(result)
keep, gone, left, arch = rows["keep"], rows["gone"], rows["left"], rows["arch"]
assert keep["status"] == "present" and keep["target"]["missing"] is False
assert keep["target"]["device"] == "7" and keep["target"]["inode"] == ino and keep["target"]["type"] == "file"
assert gone["status"] == "gone" and gone["target"] == {"missing": True, "type": "file", "absolutePath": ROOT + "/out/gone.log"}
assert left["status"] == "gone" and left["isolationStatus"] == "present" and left["isolationChecked"] is True
assert arch["status"] == "present", "archived job paths must stay observable"
assert "isolationStatus" not in keep and "isolationChecked" not in keep, "no mapping means no guess"
assert all(row["executorsChecked"] is True and row["executors"] == [] for row in rows.values())
assert calls["n"] == 1 and result["metrics"]["executorQueries"] == 1, "one sweep per request, not per entry"
assert json.dumps(tree.to_dict(), sort_keys=True) == before and not (tree.removed or tree.renamed or tree.rmdired or tree.controls)
verdict["factsAndSingleSweep"] = True

# 2. executor window facts: live match, dead and foreign-root panes filtered, group twin counts.
panes = [pane("@1", "out/keep.log"), pane("@2", "out/keep.log", dead="1"),
         pane("@3", "out/keep.log", root="/elsewhere"), pane("@4", "out/gone-dir"), pane("@5", None)]
tree, engine, calls, real = build(panes)
result = engine["batch_observe"](ROOT, IDENTITY, request([
    {"key": "keep", "relativePath": "out/keep.log", "type": "file"},
    {"key": "left", "relativePath": "out/gone-dir", "type": "directory", "isolationRelativePath": "out/iso_left"},
    {"key": "other", "relativePath": "out/other.bin", "type": "file"},
]))
rows = rows_of(result)
assert rows["keep"]["executors"] == [{"windowId": "@1", "paneId": "%1"}] and rows["keep"]["executorsChecked"] is True
assert rows["keep"]["status"] == "present"  # an honest live executor never rewrites presence
assert rows["left"]["executors"] == [{"windowId": "@4", "paneId": "%4"}], "a window on the isolation twin is group evidence"
assert rows["other"]["executors"] == []
assert calls["n"] == 1
verdict["executorFacts"] = True

# 3. identity counter-evidence and type changes read as replaced; a link at the path
#    stays the existing guard refusal (never followed, never laundered into facts).
tree, engine, calls, real = build()
result = engine["batch_observe"](ROOT, IDENTITY, request([
    {"key": "drift", "relativePath": "out/keep.log", "type": "file", "device": "9", "inode": "999999"},
    {"key": "type", "relativePath": "out/keep.log", "type": "directory", "device": "7"},
    {"key": "link", "relativePath": "out/linky", "type": "file"},
]))
rows = rows_of(result)
assert rows["drift"]["status"] == "replaced" and rows["drift"]["target"]["missing"] is False
assert rows["type"]["status"] == "replaced"
assert rows["link"]["error"]["code"] == "LINK_OR_REPARSE_POINT" and "status" not in rows["link"]
assert rows["link"]["executorsChecked"] is False
verdict["identityCounterEvidence"] = True

# 4. no usable tmux -> executors unchecked, target facts still answered (never laundered).
tree, engine, calls, real = build(tmux_error=True)
result = engine["batch_observe"](ROOT, IDENTITY, request([{"key": "keep", "relativePath": "out/keep.log", "type": "file"}]))
row = rows_of(result)["keep"]
assert row["status"] == "present" and row["executors"] == [] and row["executorsChecked"] is False
tree, engine, calls, real = build()
real["os"].name = "nt"
result = engine["batch_observe"](ROOT, IDENTITY, request([{"key": "keep", "relativePath": "out/keep.log", "type": "file"}]))
row = rows_of(result)["keep"]
assert row["status"] == "present" and row["executorsChecked"] is False and calls["n"] == 0
verdict["uncheckedExecutors"] = True

# 5. an untrusted sweep refuses the whole round (never an empty executor list).
tree, engine, calls, real = build([("@9", "%9", "0", "not base64 json!!")])
refusal = H.make_refusal(engine)
refusal(lambda: engine["batch_observe"](ROOT, IDENTITY, request([{"key": "keep", "relativePath": "out/keep.log", "type": "file"}])),
        "CLEANUP_WINDOW_BINDING_UNVERIFIED")
verdict["unverifiedBinding"] = True

# 6. request-shape refusals happen before any filesystem work.
tree, engine, calls, real = build()
refusal = H.make_refusal(engine)
refusal(lambda: engine["batch_observe"](ROOT, IDENTITY, request([{"key": "k", "relativePath": "out/keep.log", "type": "file"}] * 5001)), "FAST_BATCH_INVALID")
refusal(lambda: engine["batch_observe"](ROOT, IDENTITY, request([])), "FAST_BATCH_INVALID")
refusal(lambda: engine["batch_observe"](ROOT, IDENTITY, {"entries": [{"key": "k", "relativePath": "out/keep.log", "type": "file"}]}), "INVALID_REQUEST")
refusal(lambda: engine["batch_observe"](ROOT, IDENTITY, request([{"key": "k", "relativePath": "out/keep.log", "type": "file"},
                                                                {"key": "k", "relativePath": "out/other.bin", "type": "file"}])), "INVALID_REQUEST")
refusal(lambda: engine["batch_observe"](ROOT, IDENTITY, request([{"key": "k", "relativePath": "out/keep.log", "type": "link"}])), "INVALID_REQUEST")
refusal(lambda: engine["batch_observe"](ROOT, IDENTITY, request([{"key": "k", "relativePath": 7, "type": "file"}])), "UNSAFE_PATH")
refusal(lambda: engine["batch_observe"](ROOT, IDENTITY, request([{"key": "k", "relativePath": "out/keep.log", "type": "file"}],
                                                                rootIdentity={**IDENTITY, "inode": "666"})), "ROOT_IDENTITY_CHANGED")
verdict["shapeRefusals"] = True

# 7. a poisoned path answers only for itself; siblings keep their fresh facts.
result = engine["batch_observe"](ROOT, IDENTITY, request([
    {"key": "bad", "relativePath": "/etc/passwd", "type": "file"},
    {"key": "badiso", "relativePath": "out/keep.log", "type": "file", "isolationRelativePath": "/etc/shadow"},
    {"key": "keep", "relativePath": "out/keep.log", "type": "file"},
]))
rows = rows_of(result)
assert rows["bad"].get("error", {}).get("code") and rows["bad"]["executorsChecked"] is False
assert rows["badiso"]["error"]["code"] and rows["badiso"]["isolationChecked"] is False
assert rows["keep"]["status"] == "present" and "error" not in rows["keep"]
assert json.dumps(tree.to_dict(), sort_keys=True) != "" and not tree.removed
verdict["rowIsolation"] = True

print(json.dumps(dict(verdict, ok=True)))
