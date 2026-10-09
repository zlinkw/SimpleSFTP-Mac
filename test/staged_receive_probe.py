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
with patch.object(receiver.os, "open", fs.open), patch.object(receiver.os, "mkdir", fs.mkdir), patch.object(receiver.os, "close", fs.close), patch.object(receiver.os, "dup", fs.dup), patch.object(receiver.os, "stat", fs.stat), patch.object(receiver.os, "fstat", fs.fstat), patch.object(receiver.os, "fdopen", fs.fdopen), patch.object(receiver.os, "replace", fs.replace), patch.object(receiver.os, "fsync", lambda *a: None), patch.object(receiver.os.path, "realpath", lambda p: p), patch.object(receiver.fcntl, "flock", lambda *a: None):
    files = {"results/first.csv": b"new first", "results/second.csv": b"new second"}
    fs.mkdir("results", dir_fd=fs.open("/project", os.O_DIRECTORY))
    # The setup descriptor is independent from each receiver's descriptor lifetime.
    fs.close(next(iter(fs.fds)))
    fs.put("/project/results/first.csv", b"old first")
    fs.put("/project/results/second.csv", b"old second")
    identity = "a" * 64
    wrong = dict(files, **{"results/second.csv": b"bad data"})
    try:
        receiver.receive("/project", identity, entries(files), io.BytesIO(archive(wrong)))
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
        receiver.receive("/project", identity, entries(files), io.BytesIO(archive(files)))
    progress = [json.loads(line[16:]) for line in telemetry.getvalue().splitlines() if line.startswith("SIMPLE_PROGRESS ")]
    unpacked = [row for row in progress if row["phase"] == "unpacking"][-1]
    published = [row for row in progress if row["phase"] == "publishing"][-1]
    assert unpacked["processedBytes"] == sum(map(len, files.values()))
    assert unpacked["processedFiles"] == published["processedFiles"] == len(files)
    assert fs.nodes["/project/results/first.csv"]["data"] == b"new first"
    assert fs.nodes["/project/results/second.csv"]["data"] == b"new second"
    assert not fs.fds
    for i in range(100):
        receiver.receive("/project", hashlib.sha256(str(i).encode()).hexdigest(), entries(files), io.BytesIO(archive(files)))
    slots = [name for name, item in fs.nodes.items() if name.startswith("/project/.simple-sftp-stage-") and item["mode"] == stat.S_IFDIR]
    assert len(slots) <= 32
    assert not any(name.endswith(".part") or name.endswith(".writing") for name in fs.nodes)
    assert not fs.fds
    long = {"results/" + "subdir/" * 40 + "long.csv": b"utf8 and long filename"}
    receiver.receive("/project", "b" * 64, entries(long), io.BytesIO(archive(long)))
    assert fs.nodes["/project/" + next(iter(long))]["data"] == next(iter(long.values()))
    assert not fs.fds
    # A damaged slot must not block every unrelated request.
    chosen = "/project/.simple-sftp-stage-00"
    if chosen not in fs.nodes:
        fs.nodes[chosen] = {"mode": stat.S_IFDIR, "data": b"", "links": 1}
    fs.put(chosen + "/manifest.json", b"broken")
    receiver.receive("/project", "0" * 64, entries(files), io.BytesIO(archive(files)))
    assert fs.nodes[chosen + "/manifest.json"]["data"] == b"broken"
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
    if len(sys.argv) > 1 and sys.argv[1] == "resume-slot":
        # An earlier slot is occupied when the checkpoint starts, then becomes reusable.
        # Resuming must find this identity's existing slot before accepting that empty slot.
        preferred = "/project/.simple-sftp-stage-0c"
        if preferred not in fs.nodes:
            fs.mkdir(preferred)
        fs.put(preferred + "/manifest.json", json.dumps({"identity": "other", "status": "chunked"}).encode())
        resume = dict(request, identity="0000000c" + "d" * 56, entries=entries({"resume.bin": data}))
        assert receiver.chunk_state(resume)["offset"] == 0
        receiver.chunk_state(dict(resume, offset=0), block(0))
        fs.put(preferred + "/manifest.json", json.dumps({"identity": "other", "status": "committed"}).encode())
        assert receiver.chunk_state(resume)["offset"] == 8, "checkpoint moved into an unrelated reusable slot"
        receiver.chunk_state(dict(resume, offset=8), block(8))
        assert receiver.chunk_state(dict(resume, offset=16), block(16))["completed"]
        assert fs.nodes["/project/resume.bin"]["data"] == data
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
print("staged receiver verified")
