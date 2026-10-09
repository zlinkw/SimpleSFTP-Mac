import importlib.util
import base64
import json
import hashlib
import os
import shlex
import stat
import sys
import types
import unittest
import zlib
from unittest.mock import patch

# No Linux filesystem or locks are created by this Windows-runnable fixture.
if sys.platform == "win32":
    sys.modules["fcntl"] = types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=lambda *_: None)
spec = importlib.util.spec_from_file_location("probe", os.path.join(os.path.dirname(__file__), "..", "transfer-settlement-probe.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
with open(os.path.join(os.path.dirname(__file__), "..", "staged-tar-receive.py"), "rb") as source:
    RECEIVER_CODE = source.read()
RECEIVER_HASH = hashlib.sha256(RECEIVER_CODE).hexdigest()


class ProbeSafety(unittest.TestCase):
    def locks(self, busy=False, unsafe=False):
        def opened(name, flags):
            self.assertFalse(flags & os.O_CREAT)
            if name.endswith("00.lock"):
                return 10
            raise FileNotFoundError()
        return [patch.object(probe.os, "O_NOFOLLOW", 0x20000, create=True), patch.object(probe.os, "O_CLOEXEC", 0x80000, create=True),
                patch.object(probe.os, "getuid", return_value=1000, create=True), patch.object(probe.os.path, "realpath", side_effect=lambda path: path),
                patch.object(probe.os.path, "isdir", return_value=True), patch.object(probe.os.path, "isabs", return_value=True), patch.object(probe.os, "open", side_effect=opened),
                patch.object(probe.os, "fstat", return_value=types.SimpleNamespace(st_mode=0o100600, st_nlink=2 if unsafe else 1, st_uid=1000)),
                patch.object(probe.os, "close"), patch.object(probe.fcntl, "flock", side_effect=BlockingIOError() if busy else None),
                patch.object(probe, "process_census", return_value=3)]

    def run_locks(self, **options):
        from contextlib import ExitStack
        with ExitStack() as stack:
            mocks = [stack.enter_context(item) for item in self.locks(**options)]
            try:
                return probe.verify_idle("/projects/example")
            finally:
                mocks[-3].assert_called_once_with(10)

    def test_idle(self):
        self.assertEqual(self.run_locks()["inspectedLocks"], 1)

    def test_busy_slot(self):
        with self.assertRaisesRegex(RuntimeError, "SLOT_BUSY"):
            self.run_locks(busy=True)

    def test_unsafe_lock(self):
        with self.assertRaisesRegex(RuntimeError, "UNSAFE_TRANSFER_SLOT"):
            self.run_locks(unsafe=True)

    def test_symlink_root(self):
        with patch.object(probe.os.path, "realpath", return_value="/other"):
            with self.assertRaisesRegex(RuntimeError, "UNSAFE_TRANSFER_ROOT"):
                probe.verify_idle("/projects/example")

    def census(self, command=b"python3\0train.py\0", mounts=b"", fail=False, count=1):
        def read(name, _limit):
            if name.endswith("mountinfo"):
                return mounts
            if fail:
                raise PermissionError("cannot inspect own process")
            if name.endswith("/stat"):
                return b"2 (python3) S 1 " + b"0 " * 17 + b"123 0"
            return command if name.endswith("cmdline") else b"python3\n"
        with patch.object(probe, "ancestors", return_value={1}), patch.object(probe.os, "getuid", return_value=1000, create=True), \
                patch.object(probe.os, "listdir", return_value=[str(index + 2) for index in range(count)]), \
                patch.object(probe.os, "stat", return_value=types.SimpleNamespace(st_uid=1000)), patch.object(probe, "read_bounded", side_effect=read):
            return probe.process_census("/projects/example")

    def test_other_training_allowed(self):
        self.assertEqual(self.census(), 1)

    def test_receiver_and_source_pipeline_detected(self):
        for command in (b"python3\0-c\0exec(compile(code,'simple_sftp_staged_receive','exec'))\0", b"bash\0-c\0tar --null -T -\0", b"ssh\0dest\0"):
            with self.assertRaisesRegex(RuntimeError, "REMOTE_TRANSFER_STILL_ACTIVE"):
                self.census(command=command)

    def test_permission_failure_not_empty_evidence(self):
        with self.assertRaises(PermissionError):
            self.census(fail=True)

    def test_hidden_processes_not_empty_evidence(self):
        with self.assertRaisesRegex(RuntimeError, "PROCESS_CENSUS_UNAVAILABLE"):
            self.census(mounts=b"proc hidepid=4")

    def test_bounded_census(self):
        with self.assertRaisesRegex(RuntimeError, "PROCESS_CENSUS_LIMIT"):
            self.census(count=8193)

    def test_nondumpable_same_user_is_not_mistaken_for_other_user(self):
        with patch.object(probe, "ancestors", return_value={1}), patch.object(probe.os, "getuid", return_value=1000, create=True), \
                patch.object(probe.os, "listdir", return_value=["2"]), patch.object(probe.os, "stat", return_value=types.SimpleNamespace(st_uid=0)), \
                patch.object(probe, "read_bounded", side_effect=[b"proc", b"Name:\ttest\nUid:\t1000\t1000\t1000\t1000\n", PermissionError()]):
            with self.assertRaises(PermissionError):
                probe.process_census("/projects/example")

    def scoped_census(self, command, name="python3", state="S", identity_changed=False, descriptors=None, executable=None,
                      denied=False, unstable=False, descriptor_failure=None, descriptor_changed=False,
                      final_identity_changed=False, final_state=None, exe_denied=False, protocol="", observations=None,
                      trusted_program=True):
        reads, fd_reads = 0, 0
        def read(path, _limit):
            nonlocal reads, fd_reads
            if path.endswith("mountinfo"):
                return b"proc"
            if path.endswith("/stat"):
                reads += 1
                start = 124 if (identity_changed and reads > 1) or (final_identity_changed and reads > 2) else 123
                current_state = final_state if reads > 2 and final_state else state
                return ("2 (%s) %s 1 " % (name, current_state) + "0 " * 17 + str(start) + " 0").encode()
            if path.endswith("cmdline"):
                return command
            if path.endswith("comm"):
                return name.encode()
            if "/fdinfo/" in path:
                fd_reads += 1
                item = (descriptors or {})[path.rsplit("/", 1)[-1]]
                if descriptor_failure:
                    raise descriptor_failure
                flags = "0" if descriptor_changed and fd_reads > 1 else item.get("flags", "02")
                return ("pos:\t0\nflags:\t%s\nmnt_id:\t1\nino:\t%s\n" % (flags, item.get("ino", "100"))).encode()
            raise AssertionError(path)
        fd_scans = 0
        def listdir(path):
            nonlocal fd_scans
            if path == "/proc":
                return ["2"]
            if denied:
                raise PermissionError("fd table unavailable")
            fd_scans += 1
            return list(descriptors or {}) + (["99"] if unstable and fd_scans > 1 else [])
        def readlink(path):
            if path.endswith("/exe"):
                if exe_denied:
                    raise PermissionError("exe unavailable")
                return executable or "/usr/lib/openssh/sftp-server"
            return (descriptors or {})[path.rsplit("/", 1)[-1]]["path"]
        def stat_path(path):
            if path == "/usr/lib/openssh/sftp-server":
                return types.SimpleNamespace(st_uid=0 if trusted_program else 1000, st_mode=stat.S_IFREG | 0o755)
            if "/fd/" in path:
                item = (descriptors or {})[path.rsplit("/", 1)[-1]]
                return types.SimpleNamespace(st_mode=item.get("mode", stat.S_IFREG | 0o600), st_nlink=item.get("links", 1),
                                             st_ino=int(item.get("ino", "100")))
            return types.SimpleNamespace(st_uid=1000)
        with patch.object(probe, "ancestors", return_value={1}), patch.object(probe.os, "getuid", return_value=1000, create=True), \
                patch.object(probe.os, "O_ACCMODE", 3, create=True), \
                patch.object(probe.os, "listdir", side_effect=listdir), patch.object(probe.os, "readlink", side_effect=readlink), \
                patch.object(probe.os, "stat", side_effect=stat_path), \
                patch.object(probe.os.path, "realpath", side_effect=lambda path: path), patch.object(probe, "read_bounded", side_effect=read):
            if protocol:
                return probe.process_census("/projects/example", RECEIVER_HASH, protocol, observations)
            return probe.process_census("/projects/example", RECEIVER_HASH)

    def receiver(self, root):
        payload = base64.b64encode(zlib.compress(json.dumps({"root": root, "identity": "a" * 64, "entries": []}).encode())[2:-4]).decode()
        loader = "import base64,zlib,sys; code=zlib.decompress(base64.b64decode(sys.argv[1])); sys.argv=sys.argv[1:]; exec(compile(code,'simple_sftp_staged_receive','exec'))"
        return ["python3", "-c", loader, base64.b64encode(zlib.compress(RECEIVER_CODE)).decode(), payload]

    def test_zombie_transport_cannot_still_write(self):
        self.assertEqual(self.scoped_census(b"", "ssh", "Z"), 1)

    def test_pure_ssh_forward_is_not_an_old_file_transfer(self):
        self.assertEqual(self.scoped_census(b"ssh\0-N\0-L\08000:localhost:8000\0host\0", "ssh"), 1)

    def test_other_project_receiver_does_not_block(self):
        command = "\0".join(self.receiver("/projects/other")).encode()
        self.assertEqual(self.scoped_census(command), 1)

    def test_marker_in_diagnostic_text_is_not_receiver(self):
        self.assertEqual(self.scoped_census(b"grep\0simple_sftp_staged_receive\0log.txt\0", "grep"), 1)

    def test_related_receiver_and_sender_still_block_with_bounded_identity(self):
        args = self.receiver("/projects/example")
        sender = "root=$(realpath -e -- /projects/example) && cd -- \"$root\" && tar --null -T - -cvf - | ssh target " + shlex.join(self.receiver("/projects/other"))
        for command, name in [("\0".join(args).encode(), "python3"), (("bash\0-c\0" + sender).encode(), "bash")]:
            with self.assertRaisesRegex(RuntimeError, "REMOTE_TRANSFER_STILL_ACTIVE") as caught:
                self.scoped_census(command, name)
            self.assertEqual(caught.exception.blocker["pid"], 2)
            self.assertNotIn("command", caught.exception.blocker)

    def test_stopped_or_uninterruptible_transport_is_not_dead(self):
        for state in ("D", "T", "S"):
            with self.assertRaisesRegex(RuntimeError, "REMOTE_TRANSFER_STILL_ACTIVE"):
                self.scoped_census(b"ssh\0host\0", "ssh", state)

    def test_multiplex_master_and_misplaced_N_are_not_proven_forward_only(self):
        for args in (["ssh", "-N", "-M", "host"], ["ssh", "-N", "-oControlMaster=yes", "host"],
                     ["ssh", "host", "-N"], ["ssh", "-N", "host", "remote-command"], ["ssh", "-N", "-S", "socket", "host"]):
            self.assertFalse(probe.ssh_forward_only(args))

    def test_real_forward_options_are_parsed_without_using_command_substrings(self):
        for args in (["ssh", "-fNT", "-L8000:localhost:8000", "host"], ["ssh", "-N", "-p", "2222", "-o", "BatchMode=yes", "host"]):
            self.assertTrue(probe.ssh_forward_only(args))

    def test_changed_code_or_bad_manifest_remains_ambiguous(self):
        args = self.receiver("/projects/other")
        args[3] = base64.b64encode(zlib.compress(b"print('changed')")).decode()
        with self.assertRaisesRegex(RuntimeError, "REMOTE_TRANSFER_STILL_ACTIVE"):
            self.scoped_census("\0".join(args).encode())
        args = self.receiver("/projects/other")
        args[4] = "invalid"
        with self.assertRaisesRegex(RuntimeError, "REMOTE_TRANSFER_STILL_ACTIVE"):
            self.scoped_census("\0".join(args).encode())

    def test_root_overlap_is_path_bounded(self):
        self.assertFalse(probe.roots_overlap("/projects/example-other", "/projects/example"))
        self.assertTrue(probe.roots_overlap("/projects/example/sub", "/projects/example"))
        self.assertTrue(probe.roots_overlap("/projects", "/projects/example"))

    def test_compressed_manifest_is_bounded(self):
        oversized = base64.b64encode(zlib.compress(b"x" * 70000)[2:-4]).decode()
        with self.assertRaises(ValueError):
            probe.inflate_bounded(oversized, -zlib.MAX_WBITS, 65536)

    def test_pid_reuse_cannot_become_idle_evidence(self):
        with self.assertRaisesRegex(RuntimeError, "PROCESS_IDENTITY_CHANGED"):
            self.scoped_census(b"ssh\0-N\0host\0", "ssh", identity_changed=True)

    def test_versioned_python_receiver_is_detected(self):
        args = self.receiver("/projects/example")
        args[0] = "/usr/bin/python3.11"
        with self.assertRaisesRegex(RuntimeError, "REMOTE_TRANSFER_STILL_ACTIVE"):
            self.scoped_census("\0".join(args).encode(), "python3.11")

    def test_persistent_sftp_session_without_file_handles_is_not_old_tar_transfer(self):
        descriptors = {str(fd): {"path": "socket:[%d]" % (100 + fd), "mode": stat.S_IFSOCK} for fd in range(3)}
        self.assertEqual(self.scoped_census(b"/usr/lib/openssh/sftp-server\0", "sftp-server", descriptors=descriptors), 1)

    def test_sftp_other_project_or_read_only_target_handles_are_not_old_writers(self):
        for item in ({"path": "/projects/example/raw.csv", "flags": "0100000"},
                     {"path": "/projects/example-other/raw.csv", "flags": "0100002"},
                     {"path": "/projects/other/raw.csv", "flags": "0100002"}):
            self.assertEqual(self.scoped_census(b"/usr/lib/openssh/sftp-server\0", "sftp-server", descriptors={"3": item}), 1)

    def test_sftp_target_writable_file_still_blocks_and_reports_target_scope(self):
        for flags in ("0100001", "0100002", "02001002"):
            with self.assertRaises(probe.ActiveTransfer) as caught:
                self.scoped_census(b"/usr/lib/openssh/sftp-server\0", "sftp-server",
                                   descriptors={"3": {"path": "/projects/example/raw.csv", "flags": flags}})
            self.assertEqual(caught.exception.blocker["scope"], "target-root")
            self.assertEqual(set(caught.exception.blocker), {"pid", "name", "state", "scope"})

    def test_sftp_target_deleted_file_handle_cannot_be_mistaken_for_idle(self):
        with self.assertRaises(probe.ActiveTransfer) as caught:
            self.scoped_census(b"/usr/lib/openssh/sftp-server\0", "sftp-server",
                               descriptors={"3": {"path": "/projects/example/raw.csv (deleted)", "links": 0}})
        self.assertEqual(caught.exception.blocker["scope"], "target-root")

    def test_unknown_sftp_executable_and_uninspectable_handles_stay_guarded(self):
        for options in ({"executable": "/home/user/other-program"}, {"denied": True}, {"unstable": True},
                        {"descriptors": {"3": {"path": "/projects/other/a", "flags": "bad"}}},
                        {"descriptors": {"3": {"path": "/projects/other/a", "links": 2}}},
                        {"descriptors": {"3": {"path": "/projects/other/a"}}, "descriptor_failure": FileNotFoundError()}):
            with self.assertRaises((RuntimeError, OSError)):
                self.scoped_census(b"/usr/lib/openssh/sftp-server\0", "sftp-server", **options)

    def test_sftp_fd_table_remains_bounded_and_pid_identity_is_rechecked(self):
        with self.assertRaises(RuntimeError):
            self.scoped_census(b"/usr/lib/openssh/sftp-server\0", "sftp-server", descriptors={str(fd): {"path": "/other/a"} for fd in range(1025)})
        with self.assertRaisesRegex(RuntimeError, "PROCESS_IDENTITY_CHANGED"):
            self.scoped_census(b"/usr/lib/openssh/sftp-server\0", "sftp-server", identity_changed=True)

    def test_sftp_fd_changes_and_final_process_changes_never_prove_idle(self):
        with self.assertRaisesRegex(RuntimeError, "PROCESS_DESCRIPTOR_CHANGED"):
            self.scoped_census(b"/usr/lib/openssh/sftp-server\0", "sftp-server", descriptor_changed=True,
                               descriptors={"3": {"path": "/projects/other/a"}})
        with self.assertRaisesRegex(RuntimeError, "PROCESS_IDENTITY_CHANGED"):
            self.scoped_census(b"/usr/lib/openssh/sftp-server\0", "sftp-server", final_identity_changed=True)
        with self.assertRaises(probe.ActiveTransfer):
            self.scoped_census(b"/usr/lib/openssh/sftp-server\0", "sftp-server", final_state="R")

    def test_sftp_stopped_or_uninterruptible_session_is_not_ignored(self):
        for state in ("D", "T", "R"):
            with self.assertRaises(probe.ActiveTransfer):
                self.scoped_census(b"/usr/lib/openssh/sftp-server\0", "sftp-server", state=state)

    def test_sftp_descriptor_budget_is_shared_across_sessions(self):
        args = ["/usr/lib/openssh/sftp-server"]
        with patch.object(probe.os, "readlink", return_value=args[0]), patch.object(probe.os, "listdir", return_value=["0", "1"]):
            with self.assertRaisesRegex(RuntimeError, "PROCESS_DESCRIPTOR_LIMIT"):
                probe.sftp_file_scope("/proc/2", args, "/projects/example", [1])

    def test_protected_system_sftp_is_external_to_explicit_tar_protocol(self):
        for options in ({"exe_denied": True}, {"denied": True}):
            observations = []
            self.assertEqual(self.scoped_census(b"/usr/lib/openssh/sftp-server\0", "sftp-server",
                             protocol="staged-tar-v1", observations=observations, **options), 1)
            self.assertEqual(observations, [{"pid": 2, "name": "sftp-server", "scope": "external-session-uninspectable"}])

    def test_permission_does_not_exempt_unknown_program_or_unknown_protocol(self):
        for options in ({}, {"protocol": "other"}, {"protocol": "staged-tar-v1", "trusted_program": False},
                        {"protocol": "staged-tar-v1", "final_identity_changed": True},
                        {"protocol": "staged-tar-v1", "final_state": "R"}):
            with self.assertRaises((RuntimeError, OSError)):
                self.scoped_census(b"/usr/lib/openssh/sftp-server\0", "sftp-server", exe_denied=True, **options)

    def test_tar_protocol_still_blocks_observed_target_sftp_writer(self):
        with self.assertRaises(probe.ActiveTransfer):
            self.scoped_census(b"/usr/lib/openssh/sftp-server\0", "sftp-server", protocol="staged-tar-v1",
                               descriptors={"3": {"path": "/projects/example/raw.csv", "flags": "0100002"}})


if __name__ == "__main__":
    unittest.main()
