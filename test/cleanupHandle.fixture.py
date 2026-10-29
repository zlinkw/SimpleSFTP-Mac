"""CPU-only Linux handle scan, plus deterministic /proc permission races."""
import ast
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types

if len(sys.argv) > 1 and sys.argv[1] == "--child":
    with open(sys.argv[2], "rb"):
        print("ready", flush=True)
        sys.stdin.readline()
    sys.exit(0)

tree = ast.parse(Path(sys.argv[1]).read_text(encoding="utf-8"))
names = {"GuardError", "deny", "below", "open_handles"}
nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names]
assert len(nodes) == len(names)
m = types.ModuleType("handle_probe")
exec(compile(ast.Module(body=nodes, type_ignores=[]), "handle_probe", "exec"), m.__dict__)
m.os = os
root = tempfile.mkdtemp(prefix="simple-handles-")
target = os.path.join(root, "metrics.csv")
Path(target).write_text("fixture", encoding="utf-8")

fake = types.SimpleNamespace(**{name: getattr(os, name) for name in ("path", "getpid", "getuid")})
fake.name = "posix"
fake.listdir = lambda path: ["3525"] if path == "/proc" else ["1"]
fake.stat = lambda _: types.SimpleNamespace(st_uid=os.getuid())
def denied(_):
    raise PermissionError("non-dumpable unrelated process")
fake.readlink = denied
m.os = fake
warnings = m.open_handles(target)
assert warnings == [{"code": "PROC_VISIBILITY_LIMIT", "pid": "3525"}], warnings
# An unrelated permission failure must not hide a later real matching handle.
fake.listdir = lambda path: ["3525", "3526"] if path == "/proc" else ["1"]
fake.readlink = lambda path: denied(path) if "/3525/" in path else target
try:
    m.open_handles(target)
    raise AssertionError("active target handle accepted")
except m.GuardError as exc:
    assert exc.code == "ACTIVE_HANDLE"
# Missing processes are a normal /proc race; lack of /proc remains an error.
fake.listdir = lambda path: ["3525"] if path == "/proc" else ["1"]
def gone(_):
    raise ProcessLookupError()
fake.readlink = gone
assert m.open_handles(target) == []
m.os = os
child = subprocess.Popen([sys.executable, __file__, "--child", target], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
try:
    assert child.stdout.readline().strip() == "ready"
    for value in (target, root):
        try:
            m.open_handles(value)
            raise AssertionError("real active file handle accepted")
        except m.GuardError as exc:
            assert exc.code == "ACTIVE_HANDLE"
finally:
    child.communicate("\n", timeout=2)
    assert child.returncode == 0
assert isinstance(m.open_handles(target), list)
print(json.dumps({"ok": True, "realLinuxHandles": True, "permissionRace": True}))
