"""Bounded, read-only proof that the staged-transfer protocol has no writers.

No creation, deletion, signalling, or inference from file timestamps. Locks are
held during a complete same-user /proc census; unavailable evidence fails closed.
"""
import fcntl
import base64
import hashlib
import json
import os
import posixpath
import stat
import sys
import zlib

MAX_PIDS = 8192
MAX_COMMAND = 262144
MAX_FDS = 1024
MAX_FD_CHECKS = 4096
TRANSFER_NAMES = {"tar", "ssh", "scp", "sftp", "sftp-server", "rsync", "gzip", "pigz", "zstd", "fpart", "fpsync"}
RECEIVER_LOADER = "import base64,zlib,sys; code=zlib.decompress(base64.b64decode(sys.argv[1])); sys.argv=sys.argv[1:]; exec(compile(code,'simple_sftp_staged_receive','exec'))"


class ActiveTransfer(RuntimeError):
    def __init__(self, pid, name, state, scope):
        super().__init__("REMOTE_TRANSFER_STILL_ACTIVE")
        # Never return command lines, embedded manifests, keys or credentials.
        self.blocker = {"pid": pid, "name": name[:32], "state": state, "scope": scope}


def process_identity(directory):
    value = read_bounded(directory + "/stat", 8192)
    fields = value[value.rfind(b")") + 2:].split()
    if len(fields) < 20 or fields[0] not in (b"R", b"S", b"D", b"Z", b"T", b"t", b"X", b"x", b"K", b"W", b"P", b"I"):
        raise RuntimeError("PROCESS_CENSUS_UNAVAILABLE")
    return fields[0].decode("ascii"), int(fields[19])


def ssh_forward_only(args):
    """Prove OpenSSH cannot execute a remote command; ambiguous options block."""
    no_command, index = False, 1
    switches = "1246AaCfgKkNnqsTtVvXxYy"
    valued = "BbcDEeFIiJLlmpQRSWw"
    while index < len(args):
        arg = args[index]
        if arg == "--":
            index += 1
            break
        if not arg.startswith("-") or arg == "-":
            break
        flags, offset = arg[1:], 0
        while offset < len(flags):
            flag = flags[offset]
            if flag in switches:
                no_command = no_command or flag == "N"
                offset += 1
                continue
            if flag in valued or flag == "o":
                value = flags[offset + 1:]
                if not value:
                    index += 1
                    if index >= len(args):
                        return False
                    value = args[index]
                if flag == "S" or (flag == "o" and value.lower().replace(" ", "").startswith(("controlmaster", "controlpath"))):
                    return False  # A multiplex master can serve other commands.
                offset = len(flags)
                continue
            return False
        index += 1
    return no_command and len(args) - index == 1


def inflate_bounded(encoded, window, limit):
    compressed = base64.b64decode(encoded, validate=True)
    decompressor = zlib.decompressobj(window)
    value = decompressor.decompress(compressed, limit + 1)
    if len(value) > limit or not decompressor.eof or decompressor.unused_data:
        raise ValueError("invalid bounded payload")
    return value


def receiver_root(args, receiver_hash):
    # Only the exact packaged Python program is safe to scope by its manifest.
    # Shell/SSH wrappers, changed code and malformed payloads remain ambiguous.
    if len(args) != 5 or not python_name(posixpath.basename(args[0])) or args[1:3] != ["-c", RECEIVER_LOADER]:
        return None
    try:
        code = inflate_bounded(args[3], zlib.MAX_WBITS, 131072)
        if not receiver_hash or hashlib.sha256(code).hexdigest() != receiver_hash:
            return None
        request = json.loads(inflate_bounded(args[4], -zlib.MAX_WBITS, 65536))
        root = request["root"]
        if not isinstance(root, str) or not root.startswith("/") or root == "/" or "\0" in root or posixpath.normpath(root) != root:
            return None
        # The writer canonicalizes the path itself; reject aliased roots here.
        if os.path.realpath(root) != root:
            return None
        return root
    except (ValueError, KeyError, TypeError, zlib.error):
        return None


def roots_overlap(left, right):
    return left == right or left.startswith(right + "/") or right.startswith(left + "/")


def python_name(name):
    return name == "python" or (name.startswith("python3") and all(char in ".0123456789" for char in name[7:]))


def read_bounded(path, limit):
    with open(path, "rb") as stream:
        value = stream.read(limit + 1)
    if len(value) > limit:
        raise RuntimeError("PROCESS_CENSUS_LIMIT")
    return value


def descriptor_identity(directory, entry):
    descriptor = directory + "/fd/" + entry
    link = os.readlink(descriptor)
    if len(link) > 4096:
        raise RuntimeError("PROCESS_DESCRIPTOR_LIMIT")
    value = read_bounded(directory + "/fdinfo/" + entry, 16384)
    fields = {}
    for line in value.splitlines():
        key, separator, content = line.partition(b":")
        if separator and key in (b"flags", b"ino", b"mnt_id"):
            if key in fields:
                raise RuntimeError("PROCESS_DESCRIPTOR_UNAVAILABLE")
            fields[key] = content.strip()
    try:
        flags = int(fields[b"flags"], 8)
        inode = int(fields[b"ino"])
        mount = int(fields[b"mnt_id"])
    except (KeyError, ValueError):
        raise RuntimeError("PROCESS_DESCRIPTOR_UNAVAILABLE")
    if flags < 0 or flags & os.O_ACCMODE not in (os.O_RDONLY, os.O_WRONLY, os.O_RDWR) or inode < 0 or mount < 0:
        raise RuntimeError("PROCESS_DESCRIPTOR_UNAVAILABLE")
    info = os.stat(descriptor)
    if info.st_ino != inode:
        raise RuntimeError("PROCESS_DESCRIPTOR_CHANGED")
    return (link, flags, inode, mount, info.st_mode, info.st_nlink)


def sftp_file_scope(directory, args, root, budget):
    """An independent SFTP session is not a tar/staged-protocol participant.

    Check the kernel executable and current handles instead of declaring that
    every persistent SFTP subsystem is an abandoned writer. This is a bounded
    observation, not proof that an external client can never issue a new write.
    Actual target writers and unavailable/changing evidence remain guarded.
    """
    if not args or posixpath.basename(args[0]) != "sftp-server" or posixpath.basename(os.readlink(directory + "/exe")) != "sftp-server":
        return None
    entries = os.listdir(directory + "/fd")
    if len(entries) > MAX_FDS or len(entries) > budget[0]:
        raise RuntimeError("PROCESS_DESCRIPTOR_LIMIT")
    if any(not entry.isdigit() for entry in entries):
        raise RuntimeError("PROCESS_DESCRIPTOR_UNAVAILABLE")
    budget[0] -= len(entries)
    for entry in entries:
        before = descriptor_identity(directory, entry)
        after = descriptor_identity(directory, entry)
        if before != after:
            raise RuntimeError("PROCESS_DESCRIPTOR_CHANGED")
        link, flags, _, _, mode, links = after
        if not stat.S_ISREG(mode) or flags & os.O_ACCMODE == os.O_RDONLY:
            continue
        if links == 0 and link.endswith(" (deleted)"):
            link = link[:-10]
        if not link.startswith("/") or posixpath.normpath(link) != link:
            raise RuntimeError("PROCESS_DESCRIPTOR_UNAVAILABLE")
        if roots_overlap(link, root):
            return "target-root"
        if links > 1:
            raise RuntimeError("PROCESS_DESCRIPTOR_UNAVAILABLE")  # Alias may also be in the target tree.
    if set(os.listdir(directory + "/fd")) != set(entries):
        raise RuntimeError("PROCESS_DESCRIPTOR_CHANGED")
    return "unrelated"


def ancestors():
    excluded, pid = set(), os.getpid()
    for _ in range(64):
        if pid <= 0 or pid in excluded:
            return excluded
        excluded.add(pid)
        value = read_bounded("/proc/%d/stat" % pid, 8192)
        pid = int(value[value.rfind(b")") + 2:].split()[1])
    raise RuntimeError("PROCESS_ANCESTRY_LIMIT")


def protected_system_sftp(args):
    # This does not prove an idle FD table. It only identifies an independent
    # system SFTP service, which the explicit staged-tar protocol never starts.
    if not args or not args[0].startswith("/") or posixpath.basename(args[0]) != "sftp-server":
        return False
    info = os.stat(os.path.realpath(args[0]))
    return stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o111 != 0 and info.st_mode & 0o022 == 0


def process_census(root, receiver_hash="", protocol="", observations=None):
    # hidepid=4 can conceal a same-user receiver, so this is not full evidence.
    mounts = read_bounded("/proc/self/mountinfo", 1048576)
    if b"hidepid=4" in mounts or b"hidepid=ptraceable" in mounts:
        raise RuntimeError("PROCESS_CENSUS_UNAVAILABLE")
    excluded, uid = ancestors(), os.getuid()
    entries = [entry for entry in os.listdir("/proc") if entry.isdigit()]
    if len(entries) > MAX_PIDS:
        raise RuntimeError("PROCESS_CENSUS_LIMIT")
    inspected, fd_budget = 0, [MAX_FD_CHECKS]
    for entry in entries:
        pid = int(entry)
        if pid in excluded:
            continue
        directory = "/proc/" + entry
        try:
            if os.stat(directory).st_uid != uid:
                # A nondumpable same-user process can have a root-owned /proc
                # directory. Consult real/effective UID before excluding it.
                status = read_bounded(directory + "/status", 16384)
                uid_line = next((line for line in status.splitlines() if line.startswith(b"Uid:")), None)
                if uid_line is None:
                    raise RuntimeError("PROCESS_CENSUS_UNAVAILABLE")
                if uid not in [int(value) for value in uid_line.split()[1:3]]:
                    continue
            before = process_identity(directory)
            command = read_bounded(directory + "/cmdline", MAX_COMMAND)
            name = read_bounded(directory + "/comm", 256).strip().decode("utf-8", "replace")
            after = process_identity(directory)
        except FileNotFoundError:
            continue  # The process exited during the census.
        inspected += 1
        if before[1] != after[1]:
            raise RuntimeError("PROCESS_IDENTITY_CHANGED")
        state = after[0]
        if state in ("Z", "X", "x"):
            continue  # Dead tasks cannot execute or hold a writer descriptor.
        args = command.rstrip(b"\0").decode("utf-8", "replace").split("\0")
        executable = posixpath.basename(args[0]) if args else ""
        # Markers count only in executing interpreters, not grep/log viewers.
        interpreter = name in ("bash", "sh", "dash") or executable in ("bash", "sh", "dash") or python_name(name) or python_name(executable)
        marked = interpreter and "-c" in args and any(marker in command for marker in (
            b"simple_sftp_staged_receive", b"SIMPLE_COMPRESSION_WIRE", b"tar --null", b"fpsync"))
        if name not in TRANSFER_NAMES and executable not in TRANSFER_NAMES and not marked:
            continue
        if executable == "ssh" and ssh_forward_only(args):
            continue
        if name == "sftp-server" and not marked and state == "S":
            # D/T and unknown executables cannot be treated as an idle session.
            try:
                scope = sftp_file_scope(directory, args, root, fd_budget)
            except PermissionError:
                # OpenSSH can disable ptrace access even for the same UID.
                # Do not turn an unobserved external session into an old tar
                # writer. Other protocols and ambiguous programs fail closed.
                if protocol != "staged-tar-v1" or len(receiver_hash) != 64 or not protected_system_sftp(args):
                    raise
                if read_bounded(directory + "/cmdline", MAX_COMMAND) != command:
                    raise RuntimeError("PROCESS_IDENTITY_CHANGED")
                scope = "external-session-uninspectable"
            final_identity = process_identity(directory)
            if final_identity[1] != before[1]:
                raise RuntimeError("PROCESS_IDENTITY_CHANGED")
            if scope == "unrelated" and final_identity[0] == "S":
                continue
            if scope == "external-session-uninspectable" and final_identity[0] == "S":
                if observations is not None and len(observations) < 32:
                    observations.append({"pid": pid, "name": name, "scope": scope})
                continue
            if scope == "target-root":
                raise ActiveTransfer(pid, name, final_identity[0], scope)
        scoped_root = receiver_root(args, receiver_hash)
        if scoped_root and not roots_overlap(scoped_root, root):
            continue
        raise ActiveTransfer(pid, name, state, "target-root" if scoped_root else "unscoped")
    return inspected


def verify_idle(root, receiver_hash="", protocol=""):
    if not os.path.isabs(root) or root == "/" or os.path.realpath(root) != root or not os.path.isdir(root):
        raise RuntimeError("UNSAFE_TRANSFER_ROOT")
    descriptors = []
    try:
        for index in range(32):
            lock = os.path.join(root, ".simple-sftp-stage-%02x.lock" % index)
            try:
                descriptor = os.open(lock, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
            except FileNotFoundError:
                continue
            descriptors.append(descriptor)
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
                raise RuntimeError("UNSAFE_TRANSFER_SLOT")
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError("REMOTE_TRANSFER_SLOT_BUSY")
        observations = []
        count = process_census(root, receiver_hash, protocol, observations)
        return {"idle": True, "root": root, "protocol": protocol, "inspectedProcesses": count,
                "inspectedLocks": len(descriptors), "unobservedExternalSessions": observations}
    finally:
        for descriptor in descriptors:
            os.close(descriptor)


def main():
    try:
        result = verify_idle(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "", sys.argv[3] if len(sys.argv) > 3 else "")
    except Exception as error:
        result = {"idle": False, "reason": str(error)[:160]}
        if isinstance(error, ActiveTransfer):
            result["blocker"] = error.blocker
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
