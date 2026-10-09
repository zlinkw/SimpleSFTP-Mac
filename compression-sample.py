"""Bounded read-only content sampling. No sample bytes, archives or sidecars are written."""
import json
import os
import shutil
import signal
import stat
import subprocess
import sys
import time
import zlib
try:
    import resource
except ImportError:
    resource = None

MAX_BYTES = 256 * 1024
MAX_FILES = 8

def sample_files(root, paths, allow_zstd=False):
    started = time.monotonic()
    root = os.path.realpath(root)
    if not os.path.isdir(root) or len(paths) > MAX_FILES:
        raise ValueError("unsafe sample root or count")
    chunks = []
    sampled = 0
    for relative in paths:
        parts = relative.split("/")
        if len(relative) > 4096 or any(p in ("", ".", "..") or ":" in p for p in parts) or "\x00" in relative:
            raise ValueError("unsafe sample path")
        cursor = root
        for part in parts:
            cursor = os.path.join(cursor, part)
            if os.path.islink(cursor):
                raise ValueError("sample symlink")
        if os.path.commonpath((root, os.path.realpath(cursor))) != root:
            raise ValueError("sample outside root")
        before = os.lstat(cursor)
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
        fd = os.open(cursor, flags)
        try:
            current = os.fstat(fd)
            if not stat.S_ISREG(current.st_mode) or (before.st_dev, before.st_ino) != (current.st_dev, current.st_ino):
                raise ValueError("sample identity changed")
            budget = min(MAX_BYTES - sampled, MAX_BYTES // max(1, len(paths)))
            windows = [(0, min(current.st_size, budget))] if current.st_size <= budget else [(0, budget // 2), (current.st_size - budget // 2, budget // 2)]
            for position, length in windows:
                os.lseek(fd, position, os.SEEK_SET)
                block = os.read(fd, min(length, MAX_BYTES - sampled))
                sampled += len(block)
                chunks.append(block)
            after = os.fstat(fd)
            if (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns, current.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError("sample changed during read")
        finally:
            os.close(fd)
        if time.monotonic() - started > 2:
            break
    data = b"".join(chunks)
    result = {"sampleBytes": len(data)}
    wall = time.monotonic()
    cpu = time.process_time()
    compressor = zlib.compressobj(6, zlib.DEFLATED, 31)
    packed = compressor.compress(data) + compressor.flush()
    result["gzip"] = {"bytes": len(packed), "cpuMs": (time.process_time() - cpu) * 1000, "wallMs": (time.monotonic() - wall) * 1000}
    if allow_zstd and shutil.which("zstd"):
        wall = time.monotonic()
        usage = resource.getrusage(resource.RUSAGE_CHILDREN) if resource else None
        # A single bounded input, one worker, one-second ceiling; no output files.
        try:
            child = subprocess.run(["zstd", "-T1", "-6", "-c", "-q"], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1, check=True)
            elapsed = (time.monotonic() - wall) * 1000
            after_usage = resource.getrusage(resource.RUSAGE_CHILDREN) if resource else None
            cpu_ms = ((after_usage.ru_utime + after_usage.ru_stime) - (usage.ru_utime + usage.ru_stime)) * 1000 if usage else elapsed
            result["zstd"] = {"bytes": len(child.stdout), "cpuMs": cpu_ms, "wallMs": elapsed, "cpuEstimated": usage is None}
        except (OSError, subprocess.SubprocessError):
            pass
    result["sampleMs"] = (time.monotonic() - started) * 1000
    return result

if __name__ == "__main__":
    if hasattr(signal, "setitimer"):
        signal.signal(signal.SIGALRM, lambda *args: sys.exit(74))
        signal.setitimer(signal.ITIMER_REAL, 3)
    request = json.loads(sys.argv[1])
    print(json.dumps(sample_files(request["root"], request["paths"], request.get("zstd") is True), separators=(",", ":")))
