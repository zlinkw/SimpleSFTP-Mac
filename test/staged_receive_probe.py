"""Exercise the POSIX receiver against a descriptor-based in-memory filesystem on all hosts."""
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import posixpath
import stat
import sys
import tarfile
from types import SimpleNamespace
from unittest.mock import patch

if os.name == "nt":
    sys.modules["fcntl"] = SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=lambda *a: None)
for key, value in {"O_DIRECTORY": 65536, "O_NOFOLLOW": 131072}.items():
    if not hasattr(os, key):
        setattr(os, key, value)
source = pathlib.Path(__file__).resolve().parents[1] / "staged-tar-receive.py"
spec = importlib.util.spec_from_file_location("staged_receiver", source)
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)

class Filesystem:
    def __init__(self):
        self.nodes = {"/project": {"mode": stat.S_IFDIR, "data": b"", "links": 1}}
        self.fds = {}
        self.next_fd = 100
    def full(self, leaf, parent=None):
        return posixpath.normpath(posixpath.join(self.fds[parent], leaf)) if parent is not None else leaf
    def mkdir(self, leaf, mode=0o700, dir_fd=None):
        name = self.full(leaf, dir_fd)
        if name in self.nodes:
            raise FileExistsError(name)
        self.nodes[name] = {"mode": stat.S_IFDIR, "data": b"", "links": 1}
    def open(self, leaf, flags, mode=0o600, dir_fd=None):
        name = self.full(leaf, dir_fd)
        if name not in self.nodes:
            if flags & os.O_CREAT:
                self.nodes[name] = {"mode": stat.S_IFREG, "data": b"", "links": 1}
            else:
                raise FileNotFoundError(name)
        item = self.nodes[name]
        if flags & os.O_DIRECTORY and item["mode"] != stat.S_IFDIR or flags & os.O_NOFOLLOW and item["mode"] == stat.S_IFLNK:
            raise OSError("unsafe directory")
        self.next_fd += 1
        self.fds[self.next_fd] = name
        return self.next_fd
    def close(self, fd):
        self.fds.pop(fd)
    def dup(self, fd):
        self.next_fd += 1
        self.fds[self.next_fd] = self.fds[fd]
        return self.next_fd
    def stat(self, leaf, dir_fd=None, **kw):
        name = self.full(leaf, dir_fd)
        if name not in self.nodes:
            raise FileNotFoundError(name)
        item = self.nodes[name]
        return SimpleNamespace(st_mode=item["mode"], st_nlink=item["links"], st_size=len(item["data"]), st_dev=1, st_ino=hash(name), st_mtime_ns=1, st_ctime_ns=1)
    def fstat(self, fd):
        return self.stat(self.fds[fd])
    def fdopen(self, fd, mode):
        outer = self
        name = self.fds[fd]
        class Handle(io.BytesIO):
            def fileno(self):
                return fd
            def close(self):
                if not self.closed:
                    if "w" in mode or "+" in mode:
                        outer.nodes[name]["data"] = self.getvalue()
                    outer.close(fd)
                super().close()
        return Handle(self.nodes[name]["data"])
    def replace(self, source, dest, src_dir_fd=None, dst_dir_fd=None):
        self.nodes[self.full(dest, dst_dir_fd)] = self.nodes.pop(self.full(source, src_dir_fd))
    def put(self, name, data):
        self.nodes[name] = {"mode": stat.S_IFREG, "data": data, "links": 1}
    def listdir(self, path=".", dir_fd=None):
        parent = self.full(path, dir_fd) if dir_fd is not None else path
        prefix = parent.rstrip("/") + "/"
        return sorted(name[len(prefix):] for name in self.nodes if name.startswith(prefix) and "/" not in name[len(prefix):])

def archive(files):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.GNU_FORMAT) as output:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            output.addfile(info, io.BytesIO(data))
    return buffer.getvalue()

def entries(files):
    return [{"path": name, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)} for name, data in files.items()]

fs = Filesystem()
with patch.object(receiver.os, "open", fs.open), patch.object(receiver.os, "mkdir", fs.mkdir), patch.object(receiver.os, "close", fs.close), patch.object(receiver.os, "dup", fs.dup), patch.object(receiver.os, "stat", fs.stat), patch.object(receiver.os, "fstat", fs.fstat), patch.object(receiver.os, "fdopen", fs.fdopen), patch.object(receiver.os, "replace", fs.replace), patch.object(receiver.os, "listdir", fs.listdir), patch.object(receiver.os, "fsync", lambda *a: None), patch.object(receiver.os.path, "realpath", lambda p: p), patch.object(receiver.fcntl, "flock", lambda *a: None):
    files = {"results/first.csv": b"new first", "results/second.csv": b"new second"}
    fs.mkdir("results", dir_fd=fs.open("/project", os.O_DIRECTORY))
    # The setup descriptor is independent from each receiver's descriptor lifetime.
    fs.close(next(iter(fs.fds)))
    fs.put("/project/results/first.csv", b"old first")
    fs.put("/project/results/second.csv", b"old second")
    identity = "a" * 64
    wrong = dict(files, **{"results/second.csv": b"bad data"})
    try:
        receiver.receive("/project", {"identity": identity, "entries": entries(files)}, io.BytesIO(archive(wrong)))
    except ValueError:
        pass
    else:
        raise AssertionError("bad hash accepted")
    assert fs.nodes["/project/results/first.csv"]["data"] == b"old first"
    assert fs.nodes["/project/results/second.csv"]["data"] == b"old second"
    assert not fs.fds
    telemetry = io.StringIO()
    receiver._progress.clear()
    with patch.object(receiver.sys, "stderr", telemetry):
        receiver.receive("/project", {"identity": identity, "entries": entries(files)}, io.BytesIO(archive(files)))
    progress = [json.loads(line[16:]) for line in telemetry.getvalue().splitlines() if line.startswith("SIMPLE_PROGRESS ")]
    unpacked = [row for row in progress if row["phase"] == "unpacking"][-1]
    published = [row for row in progress if row["phase"] == "publishing"][-1]
    assert unpacked["processedBytes"] == sum(map(len, files.values()))
    assert unpacked["processedFiles"] == published["processedFiles"] == len(files)
    assert fs.nodes["/project/results/first.csv"]["data"] == b"new first"
    assert fs.nodes["/project/results/second.csv"]["data"] == b"new second"
    assert not fs.fds
    for i in range(100):
        receiver.receive("/project", {"identity": hashlib.sha256(str(i).encode()).hexdigest(), "entries": entries(files)}, io.BytesIO(archive(files)))
    staging = "/project/simple_cluster/.simple-sftp-staging"
    import re as probe_re
    slot_shape = probe_re.compile(staging + r"/d-[0-9a-f]{24}/[01]$")
    slots = [name for name, item in fs.nodes.items() if slot_shape.fullmatch(name) and item["mode"] == stat.S_IFDIR]
    # Each identity owns one directory with at most two slot generations.
    owners = {name.rsplit("/", 2)[1] for name in slots}
    assert {"d-" + hashlib.sha256(str(i).encode()).hexdigest()[:24] for i in range(100)} <= owners
    for did in owners:
        assert sum(1 for name in slots if "/" + did + "/" in name) <= 2
    # Slot directories and locks must stay inside the reserved staging subtree, never at the project root.
    assert not any(name.startswith("/project/.simple-sftp-stage-") or (name.startswith("/project/") and name.endswith(".lock") and "/" not in name[len("/project/"):]) for name in fs.nodes)
    assert all(name.startswith(staging) for name in fs.nodes if name.endswith(".lock"))
    # Locks are created on demand only inside an identity directory next to a probed slot.
    assert all(probe_re.compile(staging + r"/d-[0-9a-f]{24}/[01]\.lock$").fullmatch(name) for name in fs.nodes if name.endswith(".lock"))
    assert not any(name.endswith(".part") or name.endswith(".writing") for name in fs.nodes)
    assert not fs.fds
    long = {"results/" + "subdir/" * 40 + "long.csv": b"utf8 and long filename"}
    receiver.receive("/project", {"identity": "b" * 64, "entries": entries(long)}, io.BytesIO(archive(long)))
    assert fs.nodes["/project/" + next(iter(long))]["data"] == next(iter(long.values()))
    assert not fs.fds
    # A corrupt checkpoint in one identity slot stays protected; the identity rotates to its other slot
    # and unrelated identities are never blocked by it.
    chosen = staging + "/d-" + "0" * 24 + "/0"
    if chosen not in fs.nodes:
        fs.nodes[chosen] = {"mode": stat.S_IFDIR, "data": b"", "links": 1}
    fs.put(chosen + "/manifest.json", b"broken")
    receiver.receive("/project", {"identity": "0" * 64, "entries": entries(files)}, io.BytesIO(archive(files)))
    assert fs.nodes[chosen + "/manifest.json"]["data"] == b"broken"
    assert json.loads(fs.nodes[staging + "/d-" + "0" * 24 + "/1/manifest.json"]["data"])["status"] == "committed"
    assert not fs.fds
    # Small block size exercises the real resumable algorithm without a giant fixture.
    receiver._progress.clear()
    receiver.LARGE_CHUNK = 8
    data = b"12345678abcdefghLAST"
    fs.put("/project/large.bin", b"old complete file")
    fs.put("/project/source.bin", data)
    request = {"root": "/project", "identity": "c" * 64, "entries": entries({"large.bin": data})}
    assert receiver.chunk_state(request)["offset"] == 0
    def block(offset, body=data):
        fragment = body[offset:offset + 8]
        return io.BytesIO(json.dumps({"offset": offset, "size": len(fragment), "sha256": hashlib.sha256(fragment).hexdigest()}).encode() + b"\n" + fragment)
    receiver.chunk_state(dict(request, offset=0), block(0))
    assert receiver.chunk_state(request)["offset"] == 8
    assert fs.nodes["/project/large.bin"]["data"] == b"old complete file"
    bad = block(8).getvalue()[:-1] + b"X"
    try:
        receiver.chunk_state(dict(request, offset=8), io.BytesIO(bad))
    except ValueError:
        pass
    else:
        raise AssertionError("bad block accepted")
    assert receiver.chunk_state(request)["offset"] == 8
    receiver.chunk_state(dict(request, offset=8), block(8))
    assert receiver.chunk_state(request)["offset"] == 16
    result = receiver.chunk_state(dict(request, offset=16), block(16))
    assert result["completed"] and result["offset"] == len(data)
    assert receiver._progress["unpacking"]["files"] == 1, "chunk count must not masquerade as file count"
    assert fs.nodes["/project/large.bin"]["data"] == data
    source_request = dict(request, entries=entries({"source.bin": data}), offset=8)
    produced = io.BytesIO()
    receiver.source_chunk(source_request, produced)
    assert produced.getvalue().split(b"\n", 1)[1] == data[8:16]
    assert not fs.fds
    if len(sys.argv) > 1 and sys.argv[1] == "generation-rotation":
        # Same logical source (identity) three generations: rotation stays inside its own single slot,
        # so the identity can never exceed "current + one previous" and never touches other identities.
        rotate = dict(request, identity="1" * 24 + "a" * 40, entries=entries({"large.bin": data + b"-gen"}))
        for generation in range(3):
            receiver.chunk_state(rotate)
            for offset in range(0, len(data) + 4, 8):
                receiver.chunk_state(dict(rotate, offset=offset), block(offset, data + b"-gen"))
            assert fs.nodes["/project/large.bin"]["data"] == data + b"-gen"
        slots = [name for name in fs.nodes if (name.endswith("/0") or name.endswith("/1")) and "/d-" + "1" * 24 + "/" in name]
        assert len(slots) == 1, "a single identity must rotate inside its own slot, not grow generations"
        assert not any(name.endswith(".part") or name.endswith(".writing") for name in fs.nodes)
        assert not fs.fds
    if len(sys.argv) > 1 and sys.argv[1] == "continuous-chunks":
        continuous = dict(request, identity="e" * 64, entries=entries({"continuous.bin": data}))
        receiver.chunk_state(continuous)
        held = {}
        close = fs.close
        def unlock_close(fd):
            if held.get(fs.fds[fd]) == fd:
                held.pop(fs.fds[fd])
            close(fd)
        def lock(fd, flags):
            name = fs.fds[fd]
            if name in held:
                raise BlockingIOError("slot already held")
            held[name] = fd
        class Frames(io.BytesIO):
            checked_rival = False
            def readline(self, length):
                if self.tell() and not self.checked_rival:
                    self.checked_rival = True
                    # A second receiver must not allocate another slot for this live identity.
                    try:
                        receiver.chunk_state(continuous)
                    except ValueError as error:
                        assert "TRANSFER_STAGE_BUSY" in str(error)
                    else:
                        raise AssertionError("live checkpoint owner was bypassed")
                return super().readline(length)
        payload = Frames(b"".join(block(offset).getvalue() for offset in range(0, len(data), 8)))
        with patch.object(receiver.fcntl, "flock", lock), patch.object(receiver.os, "close", unlock_close):
            result = receiver.chunk_state(dict(continuous, offset=0, multiple=True), payload)
        assert result["completed"] and result["offset"] == len(data), "continuous receive released its slot between frames"
        assert payload.checked_rival and not held
        assert fs.nodes["/project/continuous.bin"]["data"] == data
        assert not fs.fds
    if len(sys.argv) > 1 and sys.argv[1] == "continuous-interruption":
        interrupted = dict(request, identity="f" * 64, entries=entries({"interrupted.bin": data}))
        fs.put("/project/interrupted.bin", b"old complete file")
        receiver.chunk_state(interrupted)
        for damaged in (block(8).getvalue()[:-1], block(8).getvalue()[:-1] + b"X"):
            payload = io.BytesIO(block(0).getvalue() + damaged)
            # The second attempt resumes after the first verified block.
            offset = receiver.chunk_state(interrupted)["offset"]
            if offset:
                payload = io.BytesIO(damaged)
            try:
                receiver.chunk_state(dict(interrupted, offset=offset, multiple=True), payload)
            except ValueError:
                pass
            else:
                raise AssertionError("truncated or corrupt continuous stream accepted")
            assert fs.nodes["/project/interrupted.bin"]["data"] == b"old complete file"
            assert receiver.chunk_state(interrupted)["offset"] == 8
            assert not fs.fds
        result = receiver.chunk_state(dict(interrupted, offset=8, multiple=True),
            io.BytesIO(block(8).getvalue() + block(16).getvalue()))
        assert result["completed"] and fs.nodes["/project/interrupted.bin"]["data"] == data
        assert not fs.fds
    if len(sys.argv) > 1 and sys.argv[1] == "foreign-admission":
        # Three sources share one identity directory (same 24-hex prefix). A third distinct source must
        # be refused (TRANSFER_STAGE_PENDING) and the two held generations must stay byte-identical:
        # no silent truncate, no takeover, no data destruction. Only confirmed managed cleanup frees them.
        did = "d-" + "f" * 24
        first = dict(request, identity="f" * 24 + "1" * 40, entries=entries({"large.bin": data}))
        second = dict(request, identity="f" * 24 + "2" * 40, entries=entries({"large.bin": data}))
        third = dict(request, identity="f" * 24 + "3" * 40, entries=entries({"large.bin": data}))
        for source_identity in (first, second):
            receiver.chunk_state(source_identity)
            for offset in range(0, len(data), 8):
                receiver.chunk_state(dict(source_identity, offset=offset), block(offset))
        held_journal_0 = fs.nodes[staging + "/" + did + "/0/manifest.json"]["data"]
        held_payload = b"never touch these bytes"
        fs.put(staging + "/" + did + "/1/9.part", held_payload)
        fs.nodes[staging + "/" + did + "/1/manifest.json"]["data"] = json.dumps(
            {"identity": "f" * 24 + "2" * 40, "status": "failed", "updatedAt": 5}).encode()
        held_journal_1 = fs.nodes[staging + "/" + did + "/1/manifest.json"]["data"]
        try:
            receiver.chunk_state(third)
        except ValueError as error:
            assert "TRANSFER_STAGE_PENDING" in str(error)
        else:
            raise AssertionError("a third distinct source overwrote held generations")
        assert fs.nodes[staging + "/" + did + "/0/manifest.json"]["data"] == held_journal_0
        assert fs.nodes[staging + "/" + did + "/1/manifest.json"]["data"] == held_journal_1
        assert fs.nodes[staging + "/" + did + "/1/9.part"]["data"] == held_payload
        # The read-only inventory NEVER proposes retained or unattributable slots: journals owned
        # by other logical keys are held, and stale stays empty. Nothing is created or mutated.
        snapshot = {name: dict(item) for name, item in fs.nodes.items()}
        report = receiver.stale_report("/project", "f" * 24 + "3" * 40)
        assert report["stale"] == []
        assert len(report["held"]) == 2
        assert {name: fs.nodes[name] for name in fs.nodes} == {name: snapshot[name] for name in snapshot}
        assert set(fs.nodes) == set(snapshot)
        # Admission for the third source also fails CLOSED: slots it cannot attribute to its own
        # logical key are never offered for deletion, even with both slots terminal.
        report = receiver.stale_report("/project", "f" * 24 + "3" * 40, "f" * 24 + "3" * 40)
        assert report["stale"] == []
        assert set(fs.nodes) == set(snapshot)
        assert fs.nodes[staging + "/" + did + "/1/9.part"]["data"] == held_payload
        assert not fs.fds
    if len(sys.argv) > 1 and sys.argv[1] == "same-key-admission":
        # ONE logical key, three stable generations. gen1/gen2 fill the two-generation window; the
        # incoming gen3 gets exactly ONE leaving candidate (the OLDEST terminal slot) via the
        # admission preview, and only lands after the confirmed executor removed that subtree.
        key = "a7" * 32
        gen1, gen2, gen3 = "11" * 32, "22" * 32, "33" * 32
        did = "d-" + key[:24]
        fs.nodes[staging + "/" + did] = {"mode": stat.S_IFDIR, "data": b"", "links": 1}
        fs.nodes[staging + "/" + did + "/0"] = {"mode": stat.S_IFDIR, "data": b"", "links": 1}
        fs.nodes[staging + "/" + did + "/1"] = {"mode": stat.S_IFDIR, "data": b"", "links": 1}
        fs.put(staging + "/" + did + "/0/manifest.json", json.dumps(
            {"identity": key, "generation": gen1, "status": "committed", "updatedAt": 1}).encode())
        fs.put(staging + "/" + did + "/1/manifest.json", json.dumps(
            {"identity": key, "generation": gen2, "status": "failed", "updatedAt": 2}).encode())
        keep0 = fs.nodes[staging + "/" + did + "/0/manifest.json"]["data"]
        # Inventory never lists the retained window, and creates or mutates nothing.
        snapshot = {name: bytes(item["data"]) for name, item in fs.nodes.items()}
        report = receiver.stale_report("/project", key)
        assert report["stale"] == []
        # Incoming gen3 admits exactly the OLDEST terminal slot; the newest stays held.
        report = receiver.stale_report("/project", key, gen3)
        assert [row["path"] for row in report["stale"]] == ["simple_cluster/.simple-sftp-staging/" + did + "/0"]
        assert [row["generation"] for row in report["stale"]] == [gen1]
        assert [row["path"] for row in report["held"]] == ["simple_cluster/.simple-sftp-staging/" + did + "/1"]
        # Read-only: the preview created nothing and changed nothing.
        assert {name: bytes(item["data"]) for name, item in fs.nodes.items()} == snapshot
        assert set(fs.nodes) == set(snapshot)
        # Same-run retry: re-admitting gen2 RESUMES its own slot 1 instead of adding a generation —
        # the older generation's bytes stay untouched and the window never exceeds two slots.
        retry = dict(request, identity=key, generation=gen2, entries=entries({"large.bin": data}))
        assert receiver.chunk_state(retry)["offset"] == 0
        resumed = json.loads(fs.nodes[staging + "/" + did + "/1/manifest.json"]["data"])
        assert resumed["identity"] == key and resumed["generation"] == gen2
        assert fs.nodes[staging + "/" + did + "/0/manifest.json"]["data"] == keep0
        slots = [name for name in fs.nodes if (name.endswith("/0") or name.endswith("/1")) and "/" + did + "/" in name]
        assert len(slots) == 2, "a retry must never grow a third generation slot"
        # A third generation still cannot land while both slots are occupied by the retained window.
        incoming = dict(request, identity=key, generation=gen3, entries=entries({"large.bin": data + b"-gen3"}))
        try:
            receiver.chunk_state(incoming)
        except ValueError as error:
            assert "TRANSFER_STAGE_PENDING" in str(error)
        else:
            raise AssertionError("a third generation landed over the retained window")
        assert fs.nodes[staging + "/" + did + "/0/manifest.json"]["data"] == keep0
        # After the confirmed managed executor removed the leaving subtree, absence is verified by
        # the next admission and gen3 lands in the freed slot.
        for name in [name for name in list(fs.nodes) if "/" + did + "/0" in name]:
            del fs.nodes[name]
        receiver.chunk_state(incoming)
        gen3_body = data + b"-gen3"
        for offset in range(0, len(gen3_body), 8):
            receiver.chunk_state(dict(incoming, offset=offset), block(offset, gen3_body))
        assert fs.nodes["/project/large.bin"]["data"] == gen3_body
        landed = json.loads(fs.nodes[staging + "/" + did + "/0/manifest.json"]["data"])
        assert landed["identity"] == key and landed["generation"] == gen3 and landed["status"] == "committed"
        assert not any(name.endswith(".writing") for name in fs.nodes)
        assert not fs.fds
print("staged receiver verified")
