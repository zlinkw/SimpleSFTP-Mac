import os
import sys
import time


def install(mode):
    real_stat = os.stat
    real_fstat = os.fstat
    state = {"stat": 0, "fstat": 0}

    class Shifted:
        def __init__(self, value, delta):
            self.value = value
            self.delta = delta

        def __getattr__(self, name):
            if name in ("st_mtime_ns", "st_ctime_ns"):
                return getattr(self.value, name) + self.delta
            return getattr(self.value, name)

    def stat(path, *args, **kwargs):
        value = real_stat(path, *args, **kwargs)
        state["stat"] += 1
        if mode == "settle-stat" and state["stat"] == 1:
            return Shifted(value, 1)
        if mode == "changing-stat":
            return Shifted(value, state["stat"])
        return value

    def fstat(fd):
        value = real_fstat(fd)
        state["fstat"] += 1
        if mode == "race-read" and state["fstat"] == 1:
            return Shifted(value, 1)
        return value

    os.stat = stat
    os.lstat = stat
    os.fstat = fstat


class ProbeInput:
    def __init__(self, payload):
        self.buffer = self
        self.payload = payload

    def read(self):
        return self.payload


if __name__ == "__main__":
    source = sys.stdin.read()
    mode = sys.argv[1]
    payload = os.environ.get("SIMPLE_SFTP_HASH_STDIN", "").replace("\n", "\0").encode("utf-8")
    sys.argv = [sys.argv[0], *sys.argv[2:]]
    sys.stdin = ProbeInput(payload)
    install(mode)
    sleeps = {"n": 0}
    real_sleep = time.sleep

    def counted_sleep(seconds):
        sleeps["n"] += 1
        return real_sleep(seconds)

    time.sleep = counted_sleep
    try:
        exec(compile(source, "<hash-script>", "exec"), {"__name__": "__main__"})
    except SystemExit as error:
        if error.code not in (None, 0):
            print("rejected")
    except Exception as error:
        print(f"rejected {type(error).__name__}: {error}")
    finally:
        print(f"sleeps={sleeps['n']}", file=sys.stderr)
