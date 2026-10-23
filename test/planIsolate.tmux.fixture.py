"""C3 real-tmux contract (1/2): a managed isolation finalizes and releases
exactly its own bound window after a persisted completion identity; replaying
the same intent completes from the receipt without opening a new window.
Confined to a fresh disposable temp root and its own TMUX_TMPDIR socket."""
import hashlib, json, os, pathlib, subprocess, sys, tempfile, time

engine_path = pathlib.Path(sys.argv[1]).resolve()
source = engine_path.read_text(encoding="utf-8")
root = pathlib.Path(tempfile.mkdtemp(prefix="se-isolate-window-"))
engine = root / "engine.py"
engine.write_text(source, encoding="utf-8")
os.environ["TMUX_TMPDIR"] = str(root)
sys.path.insert(0, str(pathlib.Path(__file__).parent / "_helpers"))
from closeFixtureTmuxWindows import close_fixture_tmux_windows
def fixture_tmux(args):
    return subprocess.run(["tmux", *args], capture_output=True, text=True, timeout=2)
BATCH = "job-" + "b" * 48

def run(request, timeout=6):
    proc = subprocess.run([sys.executable, "-B", str(engine)], input=json.dumps(request),
                          capture_output=True, text=True, timeout=timeout)
    assert proc.returncode == 0, (proc.stdout, proc.stderr)
    value = json.loads(proc.stdout)
    assert value.get("ok"), value
    return value

prepared = run({"root": str(root), "action": "runtime-prepare",
                     "runtimeSha256": hashlib.sha256(source.encode("utf-8")).hexdigest(), "runtimeSource": source})
pinned = root / "clean_dir" / ".operations" / "managed" / ("runtime-" + prepared["runtimeSha256"] + ".py")

def run_pinned(request, timeout=6):
    proc = subprocess.run([sys.executable, "-B", str(pinned)], input=json.dumps(request),
                          capture_output=True, text=True, timeout=timeout)
    assert proc.returncode == 0, (proc.stdout, proc.stderr)
    value = json.loads(proc.stdout)
    assert value.get("ok"), value
    return value

def panes():
    out = subprocess.run(["tmux", "list-panes", "-a", "-F",
                          "#{window_name}\t#{pane_dead}\t#{pane_dead_status}\t#{@sftp_cleanup}"],
                         capture_output=True, text=True, timeout=2, check=True).stdout
    return [line.split("\t") for line in out.splitlines() if line.strip()]

def isolation_states():
    return [json.loads(p.read_text(encoding="utf-8"))
            for p in (root / "clean_dir" / ".operations" / "isolation").glob("*.json")]

def wait_state(request, wanted, deadline_seconds=6):
    deadline = time.monotonic() + deadline_seconds
    last = None
    while time.monotonic() < deadline:
        last = run({**request, "action": "managed-observe"})
        if last["state"] == wanted:
            return last
        time.sleep(.05)
    raise AssertionError(("timeout", wanted, last))

def wait_released(deadline_seconds=4):
    # The completion receipt may briefly precede the reaped pane; the frozen
    # contract treats that instant as finalizePending, never as a failure.
    deadline = time.monotonic() + deadline_seconds
    while time.monotonic() < deadline:
        rows = panes()
        if not [r for r in rows if r[1] == "0" and len(r) > 3 and r[3]] \
                and not [r for r in rows if r[0].startswith("cleanup-")]:
            return
        time.sleep(.05)
    raise AssertionError(panes())

try:
    # managed isolation: the window writes its receipt and closes itself.
    (root / "work_dirs/job-a").mkdir(parents=True)
    (root / "work_dirs/job-a/weight.bin").write_bytes(b"x" * 4096)
    target = {"relativePath": "work_dirs/job-a", "destination": "clean_dir/" + BATCH + "/work_dirs/job-a",
              "type": "directory", "archiveBatch": BATCH, "activityEvidenceMode": "managed_tmux"}
    inspected = run({"root": str(root), "action": "inspect", "isolate": True, "target": dict(target)})
    start = {"root": str(root), "rootIdentity": inspected["rootIdentity"], "operationId": "iso-job-a",
             "cleanupAction": "isolate",
             "target": {**target, **inspected["target"], "destination": target["destination"]},
             "tmuxSessionPrefix": "iso"}
    started = run_pinned({**start, "action": "managed-start"})
    assert started["state"] == "requested", started
    done = wait_state(start, "completed")
    assert done.get("verifiedBy") == "completion_receipt", done
    wait_released()
    assert not (root / "work_dirs/job-a").exists()
    assert (root / "clean_dir" / BATCH / "work_dirs/job-a/weight.bin").read_bytes() == b"x" * 4096
    # A replay of the same confirmed intent completes from the receipt only.
    replay = run({**start, "action": "managed-start"})
    assert replay["state"] == "completed" and replay.get("verifiedBy") == "completion_receipt", replay
    assert isolation_states()[0]["state"] == "isolated"
    print(json.dumps({"ok": True, "serverSelfClose": True}))
finally:
    close_fixture_tmux_windows(fixture_tmux, private_root=root)
