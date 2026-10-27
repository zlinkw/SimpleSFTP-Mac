# Controlled POSIX fixture for test/formalJobCleanupOwner.test.js.
# The pinned short installer is the REMOTE POSIX contract (python3 -B -c with
# O_NOFOLLOW/O_DIRECTORY/dir_fd); Windows native python lacks those flags, so
# the whole installer scenario runs here on a POSIX filesystem: native python3
# on Linux, `wsl.exe --distribution <distro> --exec python3` on Windows (the
# project's established WSL test convention). Only a fresh synthetic temp root
# is touched; the repo is read (engine bytes at argv[1]); nothing is deleted,
# no network, no production or research paths.
import hashlib, json, os, subprocess, sys, tempfile


def main():
    engine_path = sys.argv[1]
    req = json.loads(sys.stdin.buffer.read(4194304).rstrip(b"\x00").decode("utf-8"))
    bootstrap = req["bootstrapSource"]
    retained_text = req["retainedText"]
    sha = req["runtimeSha256"]
    program_rel = req["programRelativePath"]
    with open(engine_path, "rb") as stream:
        engine = stream.read().decode("utf-8")
    assert hashlib.sha256(engine.encode("utf-8")).hexdigest() == sha, "engine bytes must bind the pinned sha256"
    root = os.path.realpath(tempfile.mkdtemp(prefix="simple-cleanup-pinned-"))
    os.mkdir(os.path.join(root, "state"))
    retained = os.path.join(root, "state", "retained.txt")
    with open(retained, "wb") as stream:
        stream.write(retained_text.encode("utf-8"))
    script_dir = os.path.join(root, "installer-tmp")
    os.mkdir(script_dir)
    # Deliberately retained in the fixture root as an evidence artifact; the
    # fixture never performs optional cleanup.
    script = os.path.join(script_dir, "bootstrap-%d-%s.py" % (os.getpid(), os.urandom(6).hex()))
    with open(script, "w", encoding="utf-8") as stream:
        stream.write(bootstrap)
    payload = json.dumps({"action": "runtime-prepare", "root": root, "runtimeSha256": sha, "runtimeSource": engine})
    foreign_payload = json.dumps({"action": "runtime-prepare", "root": root, "runtimeSha256": "0" * 64, "runtimeSource": engine})
    inventory = json.dumps({"root": root, "action": "inventory", "target": {"type": "file", "relativePath": "state/retained.txt"}})

    def run(argv, stdin_text):
        return subprocess.run(argv, input=stdin_text.encode("utf-8"), stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=10)

    def decode(stream):
        return stream.decode("utf-8", "replace")

    # The SSH transport writes NUL-terminated stdin chunks; the installer must
    # tolerate the exact production framing.
    first = run([sys.executable, "-B", "-X", "utf8", script], payload + "\0")
    assert first.returncode == 0, decode(first.stderr) or decode(first.stdout)
    first_state = json.loads(first.stdout)["state"]
    again = run([sys.executable, "-B", "-X", "utf8", script], payload + "\0")
    assert again.returncode == 0, decode(again.stderr) or decode(again.stdout)
    again_state = json.loads(again.stdout)["state"]

    pinned = os.path.join(root, program_rel)

    def pinned_sha():
        with open(pinned, "rb") as stream:
            return hashlib.sha256(stream.read()).hexdigest()

    binds = pinned_sha() == sha

    # Same-framing checks as production transport: no NUL for the plain engine
    # stdin, NUL-terminated for the framed call.
    with open(pinned, "ab") as stream:
        stream.write(b"# mutated after pinning\n")
    tampered = run([sys.executable, "-B", "-X", "utf8", pinned], inventory)
    assert tampered.returncode == 0, decode(tampered.stderr)
    tamper_code = json.loads(tampered.stdout)["error"]["code"]

    with open(pinned, "wb") as stream:
        stream.write(engine.encode("utf-8"))
    via_pinned = run([sys.executable, "-B", "-X", "utf8", pinned], inventory + "\0")
    assert via_pinned.returncode == 0, decode(via_pinned.stderr)
    via_ok = json.loads(via_pinned.stdout)["ok"] is True

    with open(retained, "rb") as stream:
        retained_intact = stream.read().decode("utf-8") == retained_text

    foreign = run([sys.executable, "-B", "-X", "utf8", script], foreign_payload + "\0")
    assert foreign.returncode != 0, "invalid installer input must fail closed"
    foreign_code = json.loads(foreign.stdout)["error"]["code"]
    pinned_untouched = pinned_sha() == sha

    json.dump({"ok": True, "firstState": first_state, "againState": again_state, "pinnedBindsSha": binds,
               "tamperCode": tamper_code, "viaPinnedOk": via_ok, "retainedIntact": retained_intact,
               "foreignCode": foreign_code, "pinnedUntouchedAfterForeign": pinned_untouched,
               "bootstrapScriptRetained": os.path.isfile(script)}, sys.stdout)


main()
