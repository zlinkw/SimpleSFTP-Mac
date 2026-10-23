"""Close exact windows only after proving the newly created fixture socket."""
import json
import pathlib
import re
import tempfile


def close_fixture_tmux_windows(run, private_root=None, socket_name=None):
    if private_root is None and (not socket_name or socket_name == "default"):
        raise AssertionError("fixture socket identity missing")
    root = pathlib.Path(private_root).resolve(strict=True) if private_root else None
    evidence = root or pathlib.Path(tempfile.mkdtemp(prefix="tmux-window-teardown-"))
    result = run(["list-windows", "-a", "-F", "#{socket_path}\t#{window_id}\t#{pane_id}"])
    record = {"queryExitCode": result.returncode, "windows": [], "closed": []}
    def save():
        (evidence / "tmux-window-teardown.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    save()
    if result.returncode:
        if re.search(r"no server running|No such file|Connection refused", result.stderr or ""):
            return []  # already exited naturally; nothing is mutated
        raise AssertionError("fixture window query failed: " + str(result.stderr))
    rows = sorted(set(result.stdout.splitlines()))
    for row in rows:
        socket, window, pane = row.split("\t")
        actual = pathlib.Path(socket).resolve()
        if root is not None:
            assert actual.is_relative_to(root), "refusing non-fixture socket"
        if socket_name is not None:
            assert actual.name == socket_name, "fixture socket changed"
        assert re.fullmatch(r"@\d+", window) and re.fullmatch(r"%\d+", pane), row
        record["windows"].append({"socket": socket, "window": window, "pane": pane})
    save()
    for row in record["windows"]:
        # Recheck IDs on the exact socket immediately before closing this window.
        check = run(["display-message", "-p", "-t", row["window"], "#{socket_path}\t#{window_id}\t#{pane_id}"])
        expected = "\t".join([row["socket"], row["window"], row["pane"]])
        assert check.returncode == 0 and check.stdout.strip() == expected, "fixture window identity changed"
        closed = run(["kill-window", "-t", row["window"]])
        assert closed.returncode == 0, closed.stderr
        record["closed"].append(row["window"])
        save()
    return record["closed"]
