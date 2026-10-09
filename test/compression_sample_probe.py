"""Virtual files exercise the production sampler without creating temporary files."""
import importlib.util
import os
import pathlib
import random
from types import SimpleNamespace
from unittest.mock import patch

source = pathlib.Path(__file__).resolve().parents[1] / "compression-sample.py"
spec = importlib.util.spec_from_file_location("compression_probe", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
data = b"epoch,loss,seed\n" * 100000
descriptor = {}
reads = []
st = SimpleNamespace(st_dev=1, st_ino=2, st_size=len(data), st_mtime_ns=3, st_ctime_ns=4, st_mode=0o100644)
def open_virtual(*args):
    descriptor[len(descriptor) + 1] = 0
    return len(descriptor)
def seek(fd, offset, whence):
    descriptor[fd] = offset
def read(fd, size):
    reads.append(size)
    offset = descriptor[fd]
    descriptor[fd] += size
    return data[offset:offset + size]
root = os.path.abspath("virtual-project")
with patch.object(module.os.path, "isdir", return_value=True), patch.object(module.os.path, "islink", return_value=False), patch.object(module.os, "lstat", return_value=st), patch.object(module.os, "fstat", return_value=st), patch.object(module.os, "open", side_effect=open_virtual), patch.object(module.os, "lseek", side_effect=seek), patch.object(module.os, "read", side_effect=read), patch.object(module.os, "close", side_effect=lambda fd: descriptor.pop(fd)):
    result = module.sample_files(root, [f"file{i}.csv" for i in range(8)])
    assert result["sampleBytes"] <= 256 * 1024
    assert sum(reads) <= 256 * 1024
    assert result["gzip"]["bytes"] < result["sampleBytes"] // 10
    assert not descriptor
    data = random.Random(1).randbytes(len(data))
    reads.clear()
    result = module.sample_files(root, ["weights.bin"])
    assert result["gzip"]["bytes"] >= result["sampleBytes"] * .98
    assert not descriptor
    for unsafe in ("../outside", "file:stream", "/absolute", "nested//file"):
        try:
            module.sample_files(root, [unsafe])
        except ValueError:
            pass
        else:
            raise AssertionError(unsafe)
print("bounded sample verified")
