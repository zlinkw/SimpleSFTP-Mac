"""Stream verified files into bounded reusable slots; publish only after the complete archive validates.

No unlink/rmtree commands: replace consumes staged files; failed slots remain owned and recoverable.
"""
import base64
import fcntl
import hashlib
import json
import os
import stat
import sys
import time
import zlib

BLOCK = 512
CHUNK = 65536
MAX_METADATA = 65536
MAX_JOURNAL = 1024 * 1024
LARGE_CHUNK = 8 * 1024 * 1024
MAX_LARGE_FILE = LARGE_CHUNK * 8192

_progress = {}

def report_progress(phase, byte_count=0, file_count=0, force=False):
    row = _progress.setdefault(phase, {"bytes": 0, "files": 0, "at": 0})
    row["bytes"] += byte_count
    row["files"] += file_count
    now = time.monotonic()
    if force or now - row["at"] >= 0.25:
        sys.stderr.write("SIMPLE_PROGRESS " + json.dumps({"phase": phase, "processedBytes": row["bytes"], "processedFiles": row["files"]}) + "\n")
        sys.stderr.flush()
        row["at"] = now

def ordinary(fd):
    value = os.fstat(fd)
    if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
        raise ValueError("unsafe linked staging file")

def open_file(parent_fd, leaf, flags):
    fd = os.open(leaf, flags | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=parent_fd)
    try:
        ordinary(fd)
        return fd
    except BaseException:
        os.close(fd)
        raise

def folder(parent_fd, leaf):
    try:
        os.mkdir(leaf, 0o700, dir_fd=parent_fd)
    except FileExistsError:
        pass
    return os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)

def read_journal(slot_fd):
    try:
        fd = open_file(slot_fd, "manifest.json", os.O_RDONLY)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as handle:
        content = handle.read(MAX_JOURNAL + 1)
    if len(content) > MAX_JOURNAL:
        raise ValueError("staging journal too large")
    return json.loads(content)

def journal(slot_fd, data):
    encoded = json.dumps(data, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_JOURNAL:
        raise ValueError("staging journal too large")
    fd = open_file(slot_fd, "manifest.writing", os.O_WRONLY | os.O_CREAT)
    with os.fdopen(fd, "wb") as handle:
        handle.truncate(0)
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        existing = os.stat("manifest.json", dir_fd=slot_fd, follow_symlinks=False)
        if not stat.S_ISREG(existing.st_mode) or existing.st_nlink != 1:
            raise ValueError("unsafe journal target")
    except FileNotFoundError:
        pass
    os.replace("manifest.writing", "manifest.json", src_dir_fd=slot_fd, dst_dir_fd=slot_fd)
    os.fsync(slot_fd)

def claim(root_fd, identity):
    start = int(identity[:8], 16) % 32
    # Find an existing checkpoint before recycling a slot that became free later.
    for matching_only, offset in ((matching, index) for matching in (True, False) for index in range(32)):
        leaf = ".simple-sftp-stage-" + format((start + offset) % 32, "02x")
        lock_fd = open_file(root_fd, leaf + ".lock", os.O_RDWR | os.O_CREAT)
        slot_fd = None
        accepted = False
        try:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                if matching_only:
                    try:
                        slot_fd = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
                        previous = read_journal(slot_fd)
                    except (ValueError, OSError):
                        previous = None
                    if previous and previous.get("identity") == identity:
                        raise ValueError("TRANSFER_STAGE_BUSY: checkpoint owner still active")
                continue
            try:
                slot_fd = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd) if matching_only else folder(root_fd, leaf)
                previous = read_journal(slot_fd)
            except (ValueError, OSError):
                # Corrupt/unowned slots stay protected; an unrelated idle slot can still progress.
                continue
            if matching_only and (not previous or previous.get("identity") != identity):
                continue
            if previous and previous.get("status") != "committed" and previous.get("identity") != identity:
                continue
            accepted = True
            return slot_fd, lock_fd, leaf
        finally:
            if not accepted:
                if slot_fd is not None:
                    os.close(slot_fd)
                os.close(lock_fd)
    raise ValueError("TRANSFER_STAGE_BUSY: all slots have live or unresolved owners")

def exactly(stream, size):
    result = bytearray()
    while len(result) < size:
        data = stream.read(min(CHUNK, size - len(result)))
        if not data:
            raise ValueError("incomplete tar stream")
        result.extend(data)
    return bytes(result)

def receive(root, identity, entries, stream):
    if os.path.realpath(root) != root or root in ("/", "") or not identity or len(identity) > 64:
        raise ValueError("PARENT_CD_FAILED: invalid root or identity")
    expected = {}
    for index, item in enumerate(entries):
        name = item["path"]
        if len(name) > 4096 or any(p in ("", ".", "..") or ":" in p for p in name.split("/")) or any(c in name for c in "\x00\r\n") or name in expected:
            raise ValueError("unsafe manifest path")
        digest = item["sha256"]
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError("missing manifest hash")
        expected[name] = dict(item, index=index)
    if not expected or len(expected) > 5000:
        raise ValueError("invalid manifest count")
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    slot_fd = lock_fd = None
    state = {"identity": identity, "status": "preparing", "entries": entries}
    try:
        slot_fd, lock_fd, leaf = claim(root_fd, identity)
        journal(slot_fd, state)
        seen = set()
        long_name = None
        pax = {}
        while True:
            header = exactly(stream, BLOCK)
            if not any(header):
                if any(exactly(stream, BLOCK)):
                    raise ValueError("bad tar terminator")
                trailing = 0
                while True:
                    data = stream.read(CHUNK)
                    if not data:
                        break
                    trailing += len(data)
                    if any(data) or trailing > 1024 * 1024:
                        raise ValueError("unexpected archive trailer")
                break
            checksum = int(header[148:156].strip(b"\0 ") or b"0", 8)
            if checksum != sum(header[:148]) + 256 + sum(header[156:]):
                raise ValueError("invalid tar checksum")
            size_field = header[124:136]
            size = int.from_bytes(bytes([size_field[0] & 0x7f]) + size_field[1:], "big") if size_field[0] == 0x80 else int(size_field.strip(b"\0 ") or b"0", 8)
            kind = header[156:157]
            if kind in (b"x", b"g", b"L"):
                if size < 0 or size > MAX_METADATA:
                    raise ValueError("tar metadata exceeds limit")
                content = exactly(stream, size)
                exactly(stream, (-size) % BLOCK)
                if kind == b"L":
                    long_name = content.rstrip(b"\0\n").decode("utf-8")
                else:
                    for line in content.decode("utf-8").splitlines():
                        record = line.split(" ", 1)[1]
                        key, value = record.split("=", 1)
                        pax[key] = value
                continue
            name = header[:100].split(b"\0", 1)[0].decode("utf-8")
            # GNU uses this area for sparse metadata; USTAR uses it for path prefixes.
            prefix = header[345:500].split(b"\0", 1)[0].decode("utf-8") if header[257:263] == b"ustar\0" else ""
            name = pax.get("path") or long_name or ((prefix + "/" if prefix else "") + name)
            size = int(pax.get("size", size))
            long_name = None
            pax = {}
            if name.startswith("./"):
                name = name[2:]
            item = expected.get(name)
            if kind not in (b"0", b"\0") or item is None or name in seen or size < 0:
                raise ValueError("unexpected or unsafe tar entry")
            if item.get("size") is not None and int(item["size"]) != size:
                raise ValueError("staged size mismatch")
            if size > int(item.get("size") if item.get("size") is not None else 128 * 1024 * 1024):
                raise ValueError("unknown-size entry exceeds limit")
            fd = open_file(slot_fd, str(item["index"]) + ".part", os.O_WRONLY | os.O_CREAT)
            digest = hashlib.sha256()
            with os.fdopen(fd, "wb") as output:
                output.truncate(0)
                remaining = size
                while remaining:
                    block = exactly(stream, min(CHUNK, remaining))
                    remaining -= len(block)
                    digest.update(block)
                    output.write(block)
                    report_progress("unpacking", len(block))
                output.flush()
                os.fsync(output.fileno())
            exactly(stream, (-size) % BLOCK)
            if digest.hexdigest() != item["sha256"]:
                raise ValueError("staged SHA256 mismatch")
            seen.add(name)
            report_progress("unpacking", file_count=1)
        if seen != set(expected):
            raise ValueError("incomplete archive manifest")
        state["status"] = "publishing"
        report_progress("unpacking", force=True)
        journal(slot_fd, state)
        for name, item in expected.items():
            parent_fd = os.dup(root_fd)
            try:
                parts = name.split("/")
                for part in parts[:-1]:
                    next_fd = folder(parent_fd, part)
                    os.close(parent_fd)
                    parent_fd = next_fd
                try:
                    target = os.stat(parts[-1], dir_fd=parent_fd, follow_symlinks=False)
                    if not stat.S_ISREG(target.st_mode) or target.st_nlink != 1:
                        raise ValueError("unsafe publication target")
                except FileNotFoundError:
                    pass
                os.replace(str(item["index"]) + ".part", parts[-1], src_dir_fd=slot_fd, dst_dir_fd=parent_fd)
                os.fsync(parent_fd)
                report_progress("publishing", file_count=1)
            finally:
                os.close(parent_fd)
        journal(slot_fd, {"identity": identity, "status": "committed", "count": len(expected)})
        report_progress("publishing", force=True)
        sys.stderr.write("SIMPLE_STAGE_COMMITTED " + leaf + "\n")
    except BaseException as exc:
        if slot_fd is not None:
            state.update(status="failed", error=str(exc)[:512])
            journal(slot_fd, state)
        raise
    finally:
        for fd in (slot_fd, lock_fd, root_fd):
            if fd is not None:
                os.close(fd)

def chunk_target(request):
    root, name = request["root"], request["entries"][0]["path"]
    if os.path.realpath(root) != root or root in ("/", "") or any(p in ("", ".", "..") or ":" in p or p.startswith(".simple-sftp-stage-") for p in name.split("/")) or any(c in name for c in "\x00\r\n"):
        raise ValueError("PARENT_CD_FAILED: unsafe chunk target")
    item = request["entries"][0]
    size = int(item["size"])
    if size < 0 or size > MAX_LARGE_FILE or len(item["sha256"]) != 64 or any(c not in "0123456789abcdef" for c in item["sha256"]):
        raise ValueError("invalid large file manifest")
    return root, name, size

def source_chunk(request, output):
    root, name, size = chunk_target(request)
    offset = int(request["offset"])
    length = min(LARGE_CHUNK, size - offset)
    if offset < 0 or offset >= size or offset % LARGE_CHUNK:
        raise ValueError("invalid chunk range")
    parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    descriptor = None
    try:
        for part in name.split("/")[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = next_fd
        descriptor = open_file(parent, name.split("/")[-1], os.O_RDONLY)
        before = os.fstat(descriptor)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if before.st_size != size:
            raise ValueError("source size changed")
        with os.fdopen(descriptor, "rb") as handle:
            descriptor = None
            handle.seek(offset)
            # A single bounded block allows hash-before-write, without a temporary archive.
            data = exactly(handle, length)
            report_progress("packing", len(data))
            if identity(os.fstat(handle.fileno())) != identity(before):
                raise ValueError("source changed while reading chunk")
            header = json.dumps({"offset": offset, "size": length, "sha256": hashlib.sha256(data).hexdigest()}, separators=(",", ":")).encode()
            output.write(header + b"\n")
            output.write(data)
            output.flush()
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent)

def chunk_state(request, stream=None):
    root, name, size = chunk_target(request)
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    slot_fd = lock_fd = None
    try:
        slot_fd, lock_fd, leaf = claim(root_fd, request["identity"])
        state = read_journal(slot_fd)
        if not state or state.get("identity") != request["identity"] or state.get("status") == "committed":
            state = {"identity": request["identity"], "status": "chunked", "entries": request["entries"], "blocks": []}
        if state.get("status") != "chunked" or state.get("entries") != request["entries"]:
            raise ValueError("chunk checkpoint ownership mismatch")
        blocks = state["blocks"]
        if not isinstance(blocks, list) or len(blocks) > 8192:
            raise ValueError("chunk checkpoint exceeds limit")
        offset = min(len(blocks) * LARGE_CHUNK, size)
        fd = open_file(slot_fd, "0.part", os.O_RDWR | os.O_CREAT)
        with os.fdopen(fd, "r+b") as handle:
            if stream is None:
                for index, digest in enumerate(blocks):
                    data = exactly(handle, min(LARGE_CHUNK, size - index * LARGE_CHUNK))
                    report_progress("verifying", len(data))
                    if hashlib.sha256(data).hexdigest() != digest:
                        raise ValueError("verified checkpoint block changed")
                if offset == size and blocks:
                    # Publication may have failed after validation. Reprocess only the last block.
                    blocks.pop()
                    offset = len(blocks) * LARGE_CHUNK
                handle.truncate(offset)
                journal(slot_fd, state)
                return {"offset": offset, "chunkBytes": LARGE_CHUNK}
            if int(request["offset"]) != offset or offset >= size:
                raise ValueError("stale or invalid chunk offset")
            journal(slot_fd, state)
            # One receive stream owns the slot and lock until EOF/publication.
            while offset < size:
                raw = stream.readline(513)
                if len(raw) > 512 or not raw.endswith(b"\n"):
                    raise ValueError("invalid chunk header")
                header = json.loads(raw)
                length = min(LARGE_CHUNK, size - offset)
                if header.get("offset") != offset or header.get("size") != length:
                    raise ValueError("chunk range mismatch")
                handle.seek(offset)
                handle.truncate(offset)
                digest = hashlib.sha256()
                remaining = length
                while remaining:
                    data = exactly(stream, min(CHUNK, remaining))
                    remaining -= len(data)
                    digest.update(data)
                    handle.write(data)
                    report_progress("unpacking", len(data))
                if (not request.get("multiple") or offset + length == size) and stream.read(1):
                    raise ValueError("unexpected chunk trailer")
                if digest.hexdigest() != header.get("sha256"):
                    raise ValueError("chunk SHA256 mismatch")
                handle.flush()
                os.fsync(handle.fileno())
                blocks.append(digest.hexdigest())
                journal(slot_fd, state)
                offset += length
                report_progress("unpacking", file_count=int(offset == size), force=True)
                if request.get("multiple"):
                    sys.stderr.write("SIMPLE_CHUNK_VERIFIED " + str(offset) + "\n")
                    sys.stderr.flush()
                elif offset < size:
                    return {"offset": offset, "completed": False}
            handle.seek(0)
            complete = hashlib.sha256()
            for data in iter(lambda: handle.read(CHUNK), b""):
                complete.update(data)
                report_progress("verifying", len(data))
            if complete.hexdigest() != request["entries"][0]["sha256"]:
                # Keep the last good target; this different source cannot be resumed as valid.
                state["blocks"] = []
                journal(slot_fd, state)
                raise ValueError("whole file SHA256 mismatch")
        parent = os.dup(root_fd)
        try:
            for part in name.split("/")[:-1]:
                next_fd = folder(parent, part)
                os.close(parent)
                parent = next_fd
            try:
                target = os.stat(name.split("/")[-1], dir_fd=parent, follow_symlinks=False)
                if not stat.S_ISREG(target.st_mode) or target.st_nlink != 1:
                    raise ValueError("unsafe publication target")
            except FileNotFoundError:
                pass
            os.replace("0.part", name.split("/")[-1], src_dir_fd=slot_fd, dst_dir_fd=parent)
            os.fsync(parent)
        finally:
            os.close(parent)
        journal(slot_fd, {"identity": request["identity"], "status": "committed", "count": 1})
        report_progress("verifying", file_count=1, force=True)
        return {"offset": offset, "completed": True}
    finally:
        for fd in (slot_fd, lock_fd, root_fd):
            if fd is not None:
                os.close(fd)

if __name__ == "__main__":
    encoded = sys.argv[1]
    if len(encoded) > 65536:
        raise ValueError("staging request too large")
    decoder = zlib.decompressobj(-15)
    data = decoder.decompress(base64.b64decode(encoded), MAX_METADATA + 1)
    if len(data) > MAX_METADATA or not decoder.eof:
        raise ValueError("staging manifest exceeds limit")
    request = json.loads(data)
    if request.get("mode") in ("readChunk", "readChunks"):
        if request["mode"] == "readChunks":
            for offset in range(int(request["offset"]), int(request["entries"][0]["size"]), LARGE_CHUNK):
                source_chunk(dict(request, offset=offset), sys.stdout.buffer)
        else:
            source_chunk(request, sys.stdout.buffer)
    elif request.get("mode") == "receiveChunks":
        print(json.dumps(chunk_state(dict(request, multiple=True), sys.stdin.buffer)))
    elif request.get("mode") in ("chunkStatus", "receiveChunk"):
        print(json.dumps(chunk_state(request, sys.stdin.buffer if request["mode"] == "receiveChunk" else None)))
    else:
        receive(request["root"], request["identity"], request["entries"], sys.stdin.buffer)
