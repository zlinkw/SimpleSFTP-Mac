"""Agent lifecycle in the user's assigned tmux window. Never signals PIDs."""
import contextlib
import hashlib
import json
import os
import pathlib
import re
import shlex
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import uuid

AGENT_ACTIVITY_MAX_BYTES = 16 * 1024 * 1024
AGENT_TERMINAL_TASK_STATES = frozenset(("completed", "failed", "cancelled", "canceled", "stopped", "unavailable"))


class AgentLifecycleError(RuntimeError):
    def __init__(self, code, detail=""):
        self.code = code
        super().__init__(code + (": " + str(detail) if detail else ""))


def lifecycle_json(path, max_bytes=65536):
    if not os.path.exists(path):
        return {}
    if os.path.islink(path) or not os.path.isfile(path) or os.stat(path).st_size > max_bytes:
        raise AgentLifecycleError("AGENT_OWNER_INVALID", path)
    with open(path, "rb") as stream:
        raw = stream.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise AgentLifecycleError("AGENT_OWNER_INVALID", path)
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise AgentLifecycleError("AGENT_OWNER_INVALID", path)
    return value


def lifecycle_save(path, value):
    # Owner files are plugin metadata. O_NOFOLLOW prevents replacement through links.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())


def lifecycle_canonical(raw, exists=True):
    p = pathlib.Path(str(raw))
    if not p.is_absolute() or ".." in p.parts or any(ch in str(p) for ch in "*?\n\r\0"):
        raise AgentLifecycleError("AGENT_PATH_INVALID", raw)
    for item in (p, *p.parents):
        if item.is_symlink():
            raise AgentLifecycleError("AGENT_PATH_LINK", raw)
    resolved = str(p.resolve(strict=exists))
    if resolved in ("/", os.path.expanduser("~")):
        raise AgentLifecycleError("AGENT_PATH_INVALID", raw)
    return resolved


def lifecycle_machine():
    def read(p):
        try:
            return pathlib.Path(p).read_text(encoding="utf-8").strip()
        except OSError:
            return ""
    values = [read("/etc/machine-id"), socket.gethostname(), os.readlink("/proc/self/ns/mnt"),
              os.readlink("/proc/self/ns/pid"), sorted(str(p) for p in pathlib.Path("/dev").glob("nvidia[0-9]*")),
              os.environ.get("CUDA_VISIBLE_DEVICES"), os.environ.get("NVIDIA_VISIBLE_DEVICES")]
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()


def lifecycle_contract(params):
    root = lifecycle_canonical(params["projectDir"])
    install = lifecycle_canonical(params["installDir"], exists=False)
    namespace = os.path.basename(root) + "." + hashlib.sha256(root.encode()).hexdigest()[:16]
    state = lifecycle_canonical(os.path.join(install, "state", "projects", namespace), exists=False)
    mode = params.get("mode")
    worker = str(params.get("workerId") or "")
    if mode != "worker_telemetry" or not worker:
        raise AgentLifecycleError("AGENT_IDENTITY_REQUIRED")
    host = str(params.get("host") or "")
    if host not in ("localhost", "127.0.0.1", "::1"):
        import ipaddress
        try:
            if not ipaddress.ip_address(host).is_loopback:
                raise ValueError()
        except ValueError:
            raise AgentLifecycleError("AGENT_BIND_INVALID", host)
    port = int(params["port"])
    if not 1 <= port <= 65535:
        raise AgentLifecycleError("AGENT_BIND_INVALID")
    return {"schemaVersion": 1, "workerId": worker, "mode": mode, "projectDir": root,
            "installDir": install, "stateDir": state, "condaEnv": str(params.get("condaEnv") or ""),
            "machine": lifecycle_machine(), "uid": os.getuid(), "host": host, "port": port,
            "tokenConfigured": bool(params.get("agentToken"))}


def lifecycle_check_owner(contract):
    owner = lifecycle_json(os.path.join(contract["stateDir"], "agent.owner.json"))
    if owner:
        fields = [key for key in contract if key != "condaEnv" and owner.get(key) != contract[key]]
        if fields:
            raise AgentLifecycleError("AGENT_STATE_OWNER_CONFLICT", ",".join(fields))
    elif os.path.isdir(contract["stateDir"]) and set(os.listdir(contract["stateDir"])) - {"agent.owner.lock"}:
        # Legacy state has no machine proof. Explicit migration is required; never adopt it.
        raise AgentLifecycleError("AGENT_LEGACY_STATE_UNVERIFIED", contract["stateDir"])
    return owner


def lifecycle_process(pid):
    try:
        base = pathlib.Path("/proc") / str(int(pid))
        stat = (base / "stat").read_text(encoding="utf-8").split(") ", 1)[1].split()
        if stat[0] == "Z":
            return {}
        return {"pid": int(pid), "start": stat[19], "exe": os.path.realpath(base / "exe"),
                "argv": (base / "cmdline").read_bytes().decode("utf-8").split("\0")[:-1],
                "uid": base.stat().st_uid}
    except (OSError, ValueError, IndexError):
        return {}


def lifecycle_active_tasks(state):
    """Diagnostic observations only; task activity never gates Agent lifecycle."""
    active = []
    for name, key in (("worker_task_snapshot.json", "tasks"), ("distributed_plan_queue.json", "jobs")):
        try:
            rows = lifecycle_json(os.path.join(state, name), AGENT_ACTIVITY_MAX_BYTES).get(key, [])
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                raise ValueError("invalid activity rows")
        except (OSError, ValueError, AgentLifecycleError):
            active.append("unverified-activity:" + name)
            continue
        for row in rows:
            if str(row.get("status") or "").strip().lower() not in AGENT_TERMINAL_TASK_STATES:
                active.append(str(row.get("commandId") or row.get("globalJobId") or "unknown"))
    return list(dict.fromkeys(active))


def lifecycle_tmux_config(params):
    prefix = re.sub(r"[^a-z0-9._-]+", "-", str(params.get("sessionPrefix") or "simple").strip().lower()).strip("-")[:32]
    if not prefix or not prefix[0].isalnum():
        prefix = "simple"
    worker = re.sub(r"[^a-z0-9._-]+", "-", str(params.get("workerId") or "worker").strip().lower()).strip("-") or "worker"
    default = prefix + "-worker-" + worker + "-agent"
    session = str(params.get("tmuxSession") or default)
    window = str(params.get("tmuxWindow") or "agent")
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,127}-agent", session) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}", window):
        raise AgentLifecycleError("AGENT_TMUX_TARGET_INVALID")
    return {"session": session, "window": window}


def lifecycle_tmux_run(args, allow_absent=False):
    env = dict(os.environ)
    env.pop("TMUX", None)
    # Even a read-only tmux client creates its default socket directory when it
    # is absent. Avoid invoking that client during a zero-write inspection.
    socket_root = os.path.join(env.get("TMUX_TMPDIR") or "/tmp", "tmux-" + str(os.getuid()))
    if allow_absent and not os.path.exists(os.path.join(socket_root, "default")):
        return ""
    try:
        result = subprocess.run(["tmux", *args], capture_output=True, text=True, encoding="utf-8", env=env, timeout=3)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise AgentLifecycleError("AGENT_TMUX_UNAVAILABLE", type(error).__name__)
    if result.returncode:
        if allow_absent and any(text in result.stderr.lower() for text in ("no server running", "no sessions", "can't find session", "no such file or directory")):
            return ""
        raise AgentLifecycleError("AGENT_TMUX_COMMAND_FAILED", result.stderr.strip()[:500])
    if len(result.stdout) > 65536:
        raise AgentLifecycleError("AGENT_TMUX_OUTPUT_LIMIT")
    return result.stdout.strip()


def lifecycle_tmux_window(params, legacy=False):
    target = lifecycle_tmux_config(params)
    raw = lifecycle_tmux_run(["list-windows", "-t", "=" + target["session"], "-F", "#{pid}\t#{session_name}\t#{window_id}\t#{window_name}"], allow_absent=True)
    if not raw:
        return {}
    rows = []
    for line in raw.splitlines():
        parts = line.split("\t")
        if len(parts) != 4 or parts[1] != target["session"] or not re.fullmatch(r"@[0-9]+", parts[2]):
            raise AgentLifecycleError("AGENT_TMUX_TARGET_INVALID")
        rows.append(dict(zip(("server", "session", "windowId", "windowName"), parts)))
    matches = [row for row in rows if row["windowName"] == target["window"]]
    if len(matches) == 1:
        return matches[0]
    if legacy and not matches and len(rows) == 1:
        # Historical dedicated Agent sessions used the shell's default name.
        return rows[0]
    if matches:
        raise AgentLifecycleError("AGENT_TMUX_WINDOW_AMBIGUOUS", target["session"])
    return {}


def lifecycle_close_tmux(params, expected):
    if not expected:
        return {}
    current = lifecycle_tmux_window(params, legacy=expected["windowName"] != lifecycle_tmux_config(params)["window"])
    if current != expected:
        raise AgentLifecycleError("AGENT_TMUX_WINDOW_CHANGED")
    # Close only the frozen window id, never the session/server or any PID.
    lifecycle_tmux_run(["kill-window", "-t", current["windowId"]])
    deadline = time.monotonic() + 5
    contract = lifecycle_contract(params)
    while time.monotonic() < deadline:
        if not lifecycle_health(contract, params.get("agentToken") or ""):
            return current
        time.sleep(.1)
    raise AgentLifecycleError("AGENT_TMUX_STOP_UNCONFIRMED", "assigned window closed, Agent still responds")


def lifecycle_legacy_proof(contract, params):
    """Observe legacy ownership without adopting it, signalling or writing."""
    state = contract["stateDir"]
    session = lifecycle_json(os.path.join(state, "agent.session.json"))
    if session.get("agentInstallDir") != contract["installDir"] or session.get("agentStateDir") != state:
        raise AgentLifecycleError("AGENT_LEGACY_IDENTITY_UNVERIFIED")
    availability = lifecycle_json(os.path.join(state, "worker_availability.json"))
    workers = availability.get("workers", [])
    if isinstance(workers, dict):
        if any(not isinstance(row, dict) or row.get("workerId") != key for key, row in workers.items()):
            raise AgentLifecycleError("AGENT_LEGACY_WORKER_CONFLICT")
        workers = list(workers.values())
    if not isinstance(workers, list) or any(not isinstance(row, dict) for row in workers):
        raise AgentLifecycleError("AGENT_LEGACY_WORKER_CONFLICT")
    if contract["mode"] == "worker_telemetry" and (len(workers) != 1 or workers[0].get("workerId") != contract["workerId"]):
        raise AgentLifecycleError("AGENT_LEGACY_WORKER_CONFLICT")
    if workers and int(workers[0].get("totalGpus") or 0) > 0:
        # A CPU fallback container must never claim the former GPU container's state.
        try:
            gpus = subprocess.run(["nvidia-smi", "--query-gpu=index,uuid", "--format=csv,noheader"], capture_output=True, text=True, timeout=3)
            gpu_rows = [line.strip().split(",") for line in gpus.stdout.splitlines() if line.strip()]
            indices = sorted(int(row[0].strip()) for row in gpu_rows)
            uuids = sorted(row[1].strip() for row in gpu_rows)
        except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
            raise AgentLifecycleError("AGENT_LEGACY_GPU_CONTAINER_CONFLICT")
        old_indices = sorted(int(row["index"]) for row in workers[0].get("gpus", []) if "index" in row)
        old_uuids = sorted(str(row.get("uuid") or "") for row in workers[0].get("gpus", []))
        if gpus.returncode or len(indices) != int(workers[0]["totalGpus"]) or old_indices != indices or old_uuids != uuids:
            raise AgentLifecycleError("AGENT_LEGACY_GPU_CONTAINER_CONFLICT")
    active = lifecycle_active_tasks(state)
    # Queue contents/cursors remain untouched. Unprocessed or unreadable activity
    # is diagnostic; ownership is proved independently of research task state.
    for queue in pathlib.Path(state).glob("worker_commands_*.jsonl"):
        if queue.is_symlink() or not queue.is_file():
            raise AgentLifecycleError("AGENT_LEGACY_QUEUE_UNVERIFIED")
        if queue.stat().st_size > 4 * 1024 * 1024:
            active.append("unverified-activity:" + queue.name)
            continue
        try:
            raw = queue.read_bytes()
            cursor = lifecycle_json(str(queue)[:-6] + ".cursor.json")
            count = int(cursor.get("queueSeq") or 0)
            stat = queue.stat()
            prefix = int(cursor.get("prefixLength") or 0)
            if count < 0 or count > len(raw.splitlines()) or count and (
                    int(cursor.get("device", -1)) != stat.st_dev or int(cursor.get("inode", -1)) != stat.st_ino
                    or len(raw) < int(cursor.get("size", -1)) or prefix < 0 or prefix > len(raw)
                    or hashlib.sha256(raw[:prefix]).hexdigest() != cursor.get("prefixSha256")):
                raise ValueError("unverified cursor")
            for line in raw.splitlines()[count:]:
                row = json.loads(line)
                active.append(str(row.get("commandId") or "unprocessed-command"))
        except (OSError, ValueError, AttributeError, AgentLifecycleError):
            active.append("unverified-activity:" + queue.name)
    health = lifecycle_health(contract, params.get("agentToken") or "")
    window = lifecycle_tmux_window(params, legacy=bool(health))
    if health:
        if not window:
            raise AgentLifecycleError("AGENT_TMUX_WINDOW_MISSING", lifecycle_tmux_config(params)["session"])
        for key, wanted_value in {"projectRoot": contract["projectDir"], "agentInstallDir": contract["installDir"], "agentStateDir": state,
                                  "runtimeVersion": session.get("agentVersion"), "startedAt": session.get("startedAt"),
                                  "mode": "worker_telemetry" if contract["mode"] == "worker_telemetry" else "realtime"}.items():
            if health.get(key) != wanted_value:
                raise AgentLifecycleError("AGENT_LEGACY_HEALTH_CONFLICT", key)
    # Closing the assigned window neither traverses nor modifies task history.
    # Arbitrary history filenames/counts must not become Agent lifecycle gates.
    # Bind the configured tmux window and stable service/root/container identity.
    # Mutable telemetry bytes are retained, not rewritten. Changing task
    # activity and newly written telemetry names are not confirmation bindings.
    state_stat = os.stat(state)
    if state_stat.st_uid != contract["uid"]:
        raise AgentLifecycleError("AGENT_LEGACY_IDENTITY_UNVERIFIED")
    proof = {"contract": contract, "session": session, "tmuxWindow": window,
             "stateIdentity": [state_stat.st_dev, state_stat.st_ino, state_stat.st_uid], "runtimeFiles": lifecycle_files(contract, {})}
    digest = hashlib.sha256(json.dumps(proof, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    stable = dict(proof, tmuxWindow={})
    stable_digest = hashlib.sha256(json.dumps(stable, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"digest": digest, "activeTasks": list(dict.fromkeys(active)), "activeTasksBlockRestart": False, "runningVersion": health.get("runtimeVersion"),
            "tmuxWindow": window, "contract": contract, "stableDigest": stable_digest}


def lifecycle_migrate(params):
    import fcntl
    contract = lifecycle_contract(params)
    proof = lifecycle_legacy_proof(contract, params)
    if not params.get("migrationDigest") or params["migrationDigest"] != proof["digest"]:
        raise AgentLifecycleError("AGENT_MIGRATION_CONFIRM_REQUIRED")
    if lifecycle_json(os.path.join(contract["stateDir"], "agent.owner.json")):
        raise AgentLifecycleError("AGENT_MIGRATION_ALREADY_CHANGED")
    lock_fd = os.open(os.path.join(contract["installDir"], "agent-control.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "a", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current = lifecycle_legacy_proof(contract, params)
        if current["digest"] != proof["digest"]:
            raise AgentLifecycleError("AGENT_MIGRATION_PREVIEW_CHANGED")
        closed = lifecycle_close_tmux(params, current["tmuxWindow"])
        if lifecycle_contract(params) != contract or lifecycle_legacy_proof(contract, params)["stableDigest"] != current["stableDigest"]:
            raise AgentLifecycleError("AGENT_MIGRATION_PREVIEW_CHANGED")
        owner = os.path.join(contract["stateDir"], "agent.owner.json")
        fd = os.open(owner, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(contract, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
    return {"ok": True, "status": "migrated", "closedTmuxWindow": closed, "contract": contract}


def lifecycle_health(contract, token=""):
    host = contract["host"]
    address = "[" + host + "]" if ":" in host else host
    url = "http://" + address + ":" + str(contract["port"]) + "/api/health"
    try:
        # Ignore login shell proxy variables for the configured loopback endpoint.
        request = urllib.request.Request(url, headers={"X-Simple-Agent-Token": token} if token else {})
        response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=1)
        data = response.read(65537)
        if len(data) > 65536:
            raise AgentLifecycleError("AGENT_HEALTH_INVALID")
        return json.loads(data)
    except (OSError, ValueError):
        return {}


def lifecycle_verify_running(contract, health, process):
    instance = health.get("agentIdentity") or {}
    differences = [key for key in contract if key != "condaEnv" and instance.get(key) != contract[key]]
    if health.get("agentLifecycleProtocol") != 1 or health.get("schemaVersion") != 1:
        differences.append("capabilities")
    if process.get("nonce") and instance.get("nonce") != process["nonce"]:
        differences.append("instance")
    if differences:
        raise AgentLifecycleError("AGENT_PROCESS_UNVERIFIED", ",".join(differences))
    return instance


def lifecycle_python(contract):
    # The auxiliary service uses its transport's stdlib Python. Never resolve,
    # activate, import-test or change a research environment during preparation.
    return sys.executable


def lifecycle_files(contract, params):
    hashes = params.get("files") or {}
    runtime = os.path.join(contract["installDir"], "simple_cluster", "runtime")
    result = {}
    for name in ("cluster_agent.py", "cluster_scheduler.py"):
        p = lifecycle_canonical(os.path.join(runtime, name), exists=False)
        if not os.path.isfile(p):
            result[name] = ""
            continue
        if os.stat(p).st_size > 8 * 1024 * 1024:
            raise AgentLifecycleError("AGENT_RUNTIME_INVALID", name)
        with open(p, "rb") as stream:
            digest_state = hashlib.sha256()
            for chunk in iter(lambda: stream.read(65536), b""):
                digest_state.update(chunk)
            digest = digest_state.hexdigest()
        result[name] = digest
        if hashes.get(name) and hashes[name] != digest:
            raise AgentLifecycleError("AGENT_RUNTIME_HASH_MISMATCH", name)
    return result


def lifecycle_service_guard(args, version):
    import fcntl
    # Held for the entire Agent process, before its first task/cache/state mutation.
    params = {"projectDir": args.project_dir, "installDir": os.environ.get("SIMPLE_EXPERIMENT_AGENT_INSTALL_DIR") or os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
              "mode": args.mode, "workerId": args.worker_id, "host": args.host, "port": args.port,
              "condaEnv": os.environ.get("SIMPLE_EXPERIMENT_CONDA_ENV", ""), "agentToken": getattr(args, "token", "") or os.environ.get("SIMPLE_EXPERIMENT_AGENT_TOKEN", "")}
    contract = lifecycle_contract(params)
    alternate_state = getattr(args, "state_dir", "") or os.environ.get("SIMPLE_EXPERIMENT_AGENT_STATE_DIR", "")
    if alternate_state and lifecycle_canonical(alternate_state, exists=False) != contract["stateDir"]:
        raise AgentLifecycleError("AGENT_STATE_DIR_UNMANAGED")
    lifecycle_check_owner(contract)
    os.makedirs(contract["stateDir"], exist_ok=True)
    lock = os.open(os.path.join(contract["stateDir"], "agent.owner.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        lifecycle_check_owner(contract)
        lifecycle_save(os.path.join(contract["stateDir"], "agent.owner.json"), contract)
    except BaseException:
        os.close(lock)
        raise
    identity = dict(contract, pid=os.getpid(), nonce=os.environ.get("SIMPLE_EXPERIMENT_AGENT_NONCE") or uuid.uuid4().hex,
                    version=version, python=os.path.realpath(sys.executable), runtimeFiles=lifecycle_files(contract, {}))
    lifecycle_save(os.path.join(contract["stateDir"], "agent.process.json"),
                   {"pid": identity["pid"], "nonce": identity["nonce"], "process": lifecycle_process(identity["pid"])})
    return lock, identity


def lifecycle_inspect(params):
    contract = lifecycle_contract(params)
    try:
        lifecycle_check_owner(contract)
    except AgentLifecycleError as error:
        if error.code != "AGENT_LEGACY_STATE_UNVERIFIED":
            raise
        # Read-only, fixed small metadata evidence. Never adopt legacy state or
        # expose process commands, credentials, arbitrary files or entire configs.
        fields = {"agent.session.json": ("agentVersion", "startedAt", "agentInstallDir", "agentStateDir", "tokenConfigured"),
                  "worker_availability.json": ("schemaVersion", "workerId", "projectId", "projectRoot", "generatedAt", "agentVersion", "status"),
                  "gpu_snapshot.json": ("schemaVersion", "workerId", "projectId", "projectRoot", "generatedAt", "agentVersion")}
        metadata = []
        for name, allowed in fields.items():
            filename = os.path.join(contract["stateDir"], name)
            value = lifecycle_json(filename)
            if not os.path.exists(filename):
                continue
            with open(filename, "rb") as stream:
                raw = stream.read(65537)
            if len(raw) > 65536:
                raise AgentLifecycleError("AGENT_OWNER_INVALID", filename)
            metadata.append({"path": filename, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                             "values": {key: value[key] for key in allowed if key in value}})
        health = lifecycle_health(contract, params.get("agentToken") or "")
        try:
            migration = lifecycle_legacy_proof(contract, params)
        except Exception as failure:
            migration = {"blocked": getattr(failure, "code", "AGENT_LEGACY_PROOF_FAILED"), "errorType": type(failure).__name__}
        return {"ok": False, "code": error.code, "error": str(error), "evidence": {
            "stateDir": contract["stateDir"], "metadata": metadata, "requiresExplicitMigration": True,
            "migration": migration,
            "health": {key: health[key] for key in ("projectRoot", "agentStateDir", "agentInstallDir", "runtimeVersion", "mode", "startedAt") if key in health}}}
    files = lifecycle_files(contract, {**params, "files": {}})
    health = lifecycle_health(contract, params.get("agentToken") or "")
    window = lifecycle_tmux_window(params)
    if health:
        if not window:
            raise AgentLifecycleError("AGENT_TMUX_WINDOW_MISSING", lifecycle_tmux_config(params)["session"])
        lifecycle_verify_running(contract, health, {})
    active = lifecycle_active_tasks(contract["stateDir"])
    return {"ok": True, "status": "running" if health else "unhealthy" if window else "absent", "contract": contract, "tmuxWindow": window, "activeTasks": active, "activeTasksBlockRestart": False,
            "identity": health.get("agentIdentity"), "runningVersion": health.get("runtimeVersion"), "files": files,
            "schedulerRuntime": {key: health["schedulerRuntime"][key] for key in ("protocol", "status", "workerId", "windowId", "paneId", "dead", "runningVersion", "runtimeFiles", "error") if key in health["schedulerRuntime"]} if isinstance(health.get("schedulerRuntime"), dict) else None,
            "schedulerUpdateError": str(health.get("schedulerUpdateError") or "")[:500]}


def lifecycle_control(params):
    import fcntl
    action = params.get("action", "inspect")
    if action == "inspect":
        return lifecycle_inspect(params)
    if action == "migrate":
        return lifecycle_migrate(params)
    if action not in ("ensure", "stop", "restart"):
        raise AgentLifecycleError("AGENT_ACTION_INVALID")
    contract = lifecycle_contract(params)
    lifecycle_check_owner(contract)
    os.makedirs(contract["installDir"], exist_ok=True)
    lock_path = os.path.join(contract["installDir"], "agent-control.lock")
    lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "a", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise AgentLifecycleError("AGENT_LIFECYCLE_BUSY")
        before = lifecycle_inspect(params)
        record_path = os.path.join(contract["stateDir"], "agent.process.json")
        closed = {}
        version = str(params.get("expectedVersion") or "")
        if action != "stop":
            proofs = lifecycle_files(contract, params)
            if not version or any(not proofs.get(name) or proofs[name] != (params.get("files") or {}).get(name) for name in proofs):
                raise AgentLifecycleError("AGENT_RUNTIME_PROOF_REQUIRED")
        if before["status"] in ("running", "unhealthy"):
            identity = before["identity"]
            if action == "ensure" and before["status"] == "running" and before["runningVersion"] == version:
                lifecycle_files(contract, params)
                if identity.get("runtimeFiles") != params.get("files"):
                    raise AgentLifecycleError("AGENT_RUNNING_HASH_MISMATCH")
                return dict(before, reused=True)
            if action == "ensure" and before["status"] == "running":
                raise AgentLifecycleError("AGENT_RUNNING_VERSION_MISMATCH", str(before["runningVersion"]))
            closed = lifecycle_close_tmux(params, before["tmuxWindow"])
        if action == "stop":
            return {"ok": True, "status": "stopped", "closedTmuxWindow": closed, "contract": contract}
        files = lifecycle_files(contract, params)
        if not version or any(not files.get(name) or files[name] != (params.get("files") or {}).get(name) for name in files):
            raise AgentLifecycleError("AGENT_RUNTIME_PROOF_REQUIRED")
        python = lifecycle_python(contract)
        script = os.path.join(contract["installDir"], "simple_cluster", "runtime", "cluster_agent.py")
        nonce = uuid.uuid4().hex
        env = {"SIMPLE_EXPERIMENT_AGENT_INSTALL_DIR": contract["installDir"], "SIMPLE_EXPERIMENT_CONDA_ENV": contract["condaEnv"],
               "SIMPLE_EXPERIMENT_AGENT_NONCE": nonce, "SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX": str(params.get("sessionPrefix") or "simple"),
               "SIMPLE_EXPERIMENT_AGENT_TOKEN": str(params.get("agentToken") or "")}
        # Do not inherit a previous tmux server shell's GPU/container binding.
        # Preserve only this controller's binding in this one Agent command.
        for key in ("CUDA_VISIBLE_DEVICES", "NVIDIA_VISIBLE_DEVICES", "TMUX_TMPDIR"):
            if key in os.environ:
                env[key] = os.environ[key]
        os.makedirs(os.path.join(contract["installDir"], "logs"), exist_ok=True)
        log = os.path.join(contract["installDir"], "logs", "agent-lifecycle.log")
        command = "unset SIMPLE_EXPERIMENT_AGENT_STATE_DIR SIMPLE_EXPERIMENT_HUB_UPLINK_URL CUDA_VISIBLE_DEVICES NVIDIA_VISIBLE_DEVICES TMUX_TMPDIR; exec env " + " ".join(shlex.quote(key + "=" + value) for key, value in env.items())
        command += " " + " ".join(shlex.quote(value) for value in [python, script, "serve", "--project-dir", contract["projectDir"], "--mode", contract["mode"],
                                "--worker-id", contract["workerId"], "--host", contract["host"], "--port", str(contract["port"])])
        command += " >> " + shlex.quote(log) + " 2>&1"
        target = lifecycle_tmux_config(params)
        existing = lifecycle_tmux_run(["list-windows", "-t", "=" + target["session"], "-F", "#{window_id}"], allow_absent=True)
        args = ["new-window", "-d", "-t", "=" + target["session"]] if existing else ["new-session", "-d", "-s", target["session"]]
        lifecycle_tmux_run([*args, "-n", target["window"], "-c", contract["projectDir"], command])
        launched = lifecycle_tmux_window(params)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if lifecycle_tmux_window(params) != launched or not launched:
                raise AgentLifecycleError("AGENT_START_FAILED", {"tmuxWindow": launched, "log": log})
            health = lifecycle_health(contract, params.get("agentToken") or "")
            if health:
                process = {"nonce": nonce, "tmuxWindow": launched}
                lifecycle_verify_running(contract, health, process)
                if health.get("runtimeVersion") != version or health.get("agentIdentity", {}).get("version") != version:
                    raise AgentLifecycleError("AGENT_RUNNING_VERSION_MISMATCH", health.get("runtimeVersion"))
                if health.get("agentIdentity", {}).get("runtimeFiles") != params.get("files"):
                    raise AgentLifecycleError("AGENT_RUNNING_HASH_MISMATCH")
                return dict(lifecycle_inspect(params), reused=False, closedTmuxWindow=closed)
            time.sleep(0.1)
        # Leave the single identified launch intact for explicit inspect/recovery; no retry.
        raise AgentLifecycleError("AGENT_START_UNCONFIRMED", {"tmuxWindow": launched, "log": log})


def lifecycle_main(params=None):
    try:
        result = lifecycle_control(params if params is not None else json.load(sys.stdin))
    except Exception as error:
        result = {"ok": False, "code": getattr(error, "code", "AGENT_LIFECYCLE_FAILED"), "error": str(error)}
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(lifecycle_main())
