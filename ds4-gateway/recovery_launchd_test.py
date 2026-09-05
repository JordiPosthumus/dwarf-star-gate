import importlib.util
import ctypes
import json
import os
from pathlib import Path
import plistlib
import subprocess
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("launchd_adapter", Path(__file__).with_name("recovery-launchd.py"))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class LaunchdAdapterTests(unittest.TestCase):
    def definition_fixture(self, directory, definition=None, fmt=plistlib.FMT_XML):
        root = Path(directory).resolve()
        filename = root / "retained.plist"
        definition = definition if definition is not None else {
            "Label": "com.example.ds4", "ProgramArguments": ["/usr/bin/env", "PRIVATE_KEY=private-value", "/opt/ds4/runner.sh", "/opt/ds4/ds4-server", "--context", "262144", ""],
            "EnvironmentVariables": {"DS4_CACHE_POLICY": "preserved"}, "WorkingDirectory": "/opt/ds4", "RunAtLoad": True,
            "KeepAlive": True, "ExitTimeOut": 120, "StandardOutPath": "/opt/ds4/runtime/engine.log",
        }
        raw = plistlib.dumps(definition, fmt=fmt)
        filename.write_bytes(raw)
        filename.chmod(0o600)
        return {"label": "com.example.ds4", "plist": str(filename), "retained_definition_sha256": adapter.digest(raw)}, raw

    def test_retained_definition_preflight_preserves_exact_xml_and_binary_bytes_without_actions(self):
        for fmt in [plistlib.FMT_XML, plistlib.FMT_BINARY]:
            with self.subTest(fmt=fmt), tempfile.TemporaryDirectory() as temp, patch.object(adapter, "run") as command:
                config, raw = self.definition_fixture(temp, fmt=fmt)
                before = Path(config["plist"]).stat()
                result = adapter.handle(config, {"action": "inspect_definition"}, Path(temp) / "actions.json")
                self.assertEqual(result, {"version": 1, "enrolled": True, "verified": True, "authority": "none", "scope": "pinned_definition_only", "definition_bytes": len(raw)})
                self.assertEqual(adapter.retained_definition(config), raw)
                self.assertEqual(Path(config["plist"]).read_bytes(), raw)
                self.assertEqual(Path(config["plist"]).stat().st_mtime_ns, before.st_mtime_ns)
                self.assertEqual(sorted(p.name for p in Path(temp).iterdir()), ["retained.plist"])
                command.assert_not_called()
                for private in [config["label"], config["plist"], config["retained_definition_sha256"], "private-value", "runner.sh"]:
                    self.assertNotIn(private, json.dumps(result))

    def test_retained_definition_is_explicit_and_cannot_supply_paths_or_commands_in_requests(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(adapter, "run") as command:
            self.assertFalse(adapter.handle({}, {"action": "inspect_definition"}, Path(temp) / "actions.json")["enrolled"])
            for request in [{"action": "inspect_definition", "plist": "/tmp/invented"}, {"action": "bootstrap"}, {"action": "inspect_definition", "command": "launchctl enable"}]:
                with self.assertRaisesRegex(ValueError, "invalid_adapter_request"):
                    adapter.handle({}, request, Path(temp) / "actions.json")
            command.assert_not_called()
            self.assertEqual(list(Path(temp).iterdir()), [])

    def test_retained_definition_rejects_drift_label_ambiguity_and_disabled_intent(self):
        with tempfile.TemporaryDirectory() as temp:
            config, raw = self.definition_fixture(temp)
            filename = Path(config["plist"])
            filename.write_bytes(raw + b"\n")
            with self.assertRaisesRegex(ValueError, "digest_mismatch"):
                adapter.retained_definition(config)
            for definition in [
                {"Label": "com.example.other", "Program": "/opt/ds4/runner"},
                {"Label": config["label"], "Program": "relative-runner"},
                {"Label": config["label"], "ProgramArguments": "not-an-array"},
                {"Label": config["label"], "ProgramArguments": ["/opt/ds4/runner", 1]},
                {"Label": config["label"], "ProgramArguments": ["/opt/ds4/runner"], "Disabled": "false"},
                {"Label": config["label"], "Disabled": False},
            ]:
                bad, _ = self.definition_fixture(temp, definition)
                with self.assertRaisesRegex(ValueError, "retained_definition_invalid"):
                    adapter.retained_definition(bad)
            disabled, _ = self.definition_fixture(temp, {"Label": config["label"], "Program": "/opt/ds4/runner", "Disabled": True})
            with self.assertRaisesRegex(ValueError, "retained_definition_disabled"):
                adapter.retained_definition(disabled)
            # Duplicate identity or nested environment keys must not silently take the last value.
            for duplicate in [b"<key>Label</key><string>com.example.ds4</string>", b"<key>EnvironmentVariables</key><dict><key>X</key><string>a</string><key>X</key><string>b</string></dict>"]:
                body = b"<plist version='1.0'><dict><key>Label</key><string>com.example.ds4</string><key>Program</key><string>/opt/ds4/runner</string>" + duplicate + b"</dict></plist>"
                filename.write_bytes(body)
                with self.assertRaisesRegex(ValueError, "retained_definition_invalid"):
                    adapter.retained_definition({**config, "retained_definition_sha256": adapter.digest(body)})

    def test_retained_definition_requires_private_regular_canonical_bounded_files(self):
        with tempfile.TemporaryDirectory() as temp:
            config, raw = self.definition_fixture(temp)
            filename = Path(config["plist"])
            filename.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "not_private"):
                adapter.retained_definition(config)
            filename.chmod(0o600)
            link = filename.with_name("alias.plist");link.symlink_to(filename)
            with self.assertRaisesRegex(ValueError, "not_private"):
                adapter.retained_definition({**config, "plist": str(link)})
            parent_link = filename.with_name("alias-dir");parent_link.symlink_to(filename.parent, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "not_private"):
                adapter.retained_definition({**config, "plist": str(parent_link / filename.name)})
            for replacement in [b"", b"x" * (1024 * 1024 + 1)]:
                filename.write_bytes(replacement)
                with self.assertRaisesRegex(ValueError, "bounded"):
                    adapter.retained_definition(config)
            filename.unlink();filename.mkdir()
            with self.assertRaisesRegex(ValueError, "bounded"):
                adapter.retained_definition(config)
            filename.rmdir();os.mkfifo(filename, 0o600)
            # NONBLOCK is essential: a FIFO configured by mistake cannot hang enrollment.
            with self.assertRaisesRegex(ValueError, "bounded"):
                adapter.retained_definition(config)

    def test_retained_definition_read_race_fails_without_returning_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            config, _ = self.definition_fixture(temp)
            original = os.read
            def changed(fd, count):
                result = original(fd, count)
                with open(config["plist"], "ab") as file:
                    file.write(b"\n")
                return result
            with patch.object(adapter.os, "read", side_effect=changed):
                with self.assertRaisesRegex(ValueError, "changed_during_read"):
                    adapter.retained_definition(config)

    def test_retained_definition_binary_counts_duplicates_and_xml_entities_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            config, raw = self.definition_fixture(temp, {"Label": "com.example.ds4", "Program": "/opt/ds4/runner"}, plistlib.FMT_BINARY)
            filename = Path(config["plist"])
            width, ref_width, count, top, table = struct.unpack(">6xBBQQQ", raw[-32:])
            malformed = raw[:-32] + struct.pack(">6xBBQQQ", width, ref_width, 2**63, top, table)
            filename.write_bytes(malformed)
            with patch.object(adapter.plistlib, "loads") as parser:
                result = adapter.inspect_definition({**config, "retained_definition_sha256": adapter.digest(malformed)})
                self.assertFalse(result["verified"])
                parser.assert_not_called()
            root = int.from_bytes(raw[table + top * width:table + (top + 1) * width], "big")
            self.assertEqual(raw[root], 0xD2)
            duplicate = bytearray(raw)
            duplicate[root + 1 + ref_width:root + 1 + 2 * ref_width] = raw[root + 1:root + 1 + ref_width]
            entity = b'<!DOCTYPE plist [<!ENTITY secret "private-value">]><plist><dict><key>Label</key><string>&secret;</string></dict></plist>'
            for body in [bytes(duplicate), entity, b"not a plist", b"\xff\xfeinvalid"]:
                filename.write_bytes(body)
                result = adapter.inspect_definition({**config, "retained_definition_sha256": adapter.digest(body)})
                self.assertEqual(result["reason"], "retained_definition_invalid")
                self.assertNotIn("private-value", json.dumps(result))

    def test_retained_definition_cli_is_read_only_private_and_backward_compatible(self):
        with tempfile.TemporaryDirectory() as temp:
            config, raw = self.definition_fixture(temp)
            config.update({"port": 8001, "binary": "/opt/ds4/ds4-server", "profile_files": ["/opt/ds4/runner.sh"]})
            filename = Path(temp) / "config.json"
            filename.write_text(json.dumps(config));filename.chmod(0o600)
            adapter.validate_config(filename, config)
            adapter.validate_config(filename, {k:v for k,v in config.items() if k != "retained_definition_sha256"})
            with patch.object(adapter, "file_digest", return_value="a" * 64):
                self.assertEqual(adapter.service_profile(config), adapter.service_profile({k:v for k,v in config.items() if k != "retained_definition_sha256"}))
            for invalid in [None, True, "bad", "A" * 64]:
                with self.assertRaisesRegex(ValueError, "invalid_adapter_configuration"):
                    adapter.validate_config(filename, {**config, "retained_definition_sha256": invalid})
            call = [sys.executable, str(Path(adapter.__file__)), str(filename)]
            result = subprocess.run(call, input='{"action":"inspect_definition"}', text=True, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(json.loads(result.stdout)["authority"], "none")
            Path(config["plist"]).write_bytes(raw + b"\n")
            failed = subprocess.run(call, input='{"action":"inspect_definition"}', text=True, capture_output=True, timeout=5)
            self.assertEqual(failed.returncode, 0)
            self.assertEqual(json.loads(failed.stdout), {"version": 1, "enrolled": True, "verified": False, "authority": "none", "reason": "retained_definition_digest_mismatch"})
            self.assertEqual(failed.stderr, "")
            self.assertEqual(sorted(p.name for p in Path(temp).iterdir()), ["config.json", "retained.plist"])

    def test_native_disable_parser_requires_a_complete_unambiguous_override_table(self):
        label = "com.example.ds4"
        self.assertIs(adapter.parse_disabled('disabled services = {\n "com.example.ds4" => disabled\n}', label), True)
        for body in ('', ' "com.example.ds4" => enabled\n', ' "com.example.ds4.other" => disabled\n'):
            self.assertIs(adapter.parse_disabled('disabled services = {\n' + body + '}', label), False)
        for output in ('', '{}', 'disabled services = {', 'disabled services = {\n "com.example.ds4" => unknown\n}',
                       'disabled services = {\n "com.example.ds4" => enabled\n "com.example.ds4" => disabled\n}',
                       'disabled services = {\n "com.example.ds4" => disabled\n}\nextra',
                       'disabled services = {\n not a record\n}'):
            self.assertIsNone(adapter.parse_disabled(output, label))
        with patch.object(adapter, "run", return_value=('disabled services = {\n}', 0)) as command:
            self.assertIs(adapter.native_disabled({"label": label}), False)
            command.assert_called_once_with(["/bin/launchctl", "print-disabled", f"gui/{os.getuid()}"], check=False)
        for result in [('', 112), ('PRIVATE_STDOUT', 1)]:
            with patch.object(adapter, "run", return_value=result):
                self.assertIsNone(adapter.native_disabled({"label": label}))
        with patch.object(adapter, "run", side_effect=adapter.subprocess.TimeoutExpired('fixture', 15)):
            self.assertIsNone(adapter.native_disabled({"label": label}))

    def test_native_disable_veto_covers_start_restart_canary_and_changes_after_journaling(self):
        current = {"active": True, "listener": True, "instance": "1" * 32, "machine": "a" * 64, "profile": "b" * 64, "fault": {"at": 1000}}
        restart = {"action": "restart", "action_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "instance": current["instance"], "machine": current["machine"], "profile": current["profile"], "canary": False, "fault_after": 900}
        stopped = {"active": False, "listener": False, "loaded": True, "stopped": True, "stopped_epoch": "d" * 64, "instance": "", "machine": "a" * 64, "service_profile": "c" * 64}
        start = {"action": "start", "action_id": restart["action_id"], **{key: stopped[key] for key in ("stopped_epoch", "machine", "service_profile")}}
        for request, snapshot in [(restart, current), ({**restart, "canary": True}, current), (start, stopped)]:
            for checks in ([True], [None], [False, True], [False, None]):
                with self.subTest(action=request["action"], checks=checks), tempfile.TemporaryDirectory() as temp, patch.object(adapter, "inspect", return_value=snapshot), patch.object(adapter, "native_disabled", side_effect=checks), patch.object(adapter, "run") as command:
                    state = Path(temp) / "actions.json"
                    with self.assertRaisesRegex(ValueError, 'launchd_native_disabled|launchd_disable_state_unverified'):
                        adapter.handle({"label": "com.example.ds4"}, request, state)
                    command.assert_not_called()
                    self.assertEqual(state.exists(), len(checks) == 2)
                    if state.exists():
                        self.assertEqual(adapter.handle({"label": "com.example.ds4"}, request, state)["state"], "intent")
                        command.assert_not_called()

    def test_absent_job_requires_repeated_absence_and_readable_exact_gui_domain(self):
        config = {"label": "com.example.ds4"}
        domain = f"gui/{os.getuid()}"
        with patch.object(adapter, "run", side_effect=[("", 113), (domain + " = {\n}\n", 0), ("", 113)]) as command:
            state = adapter.launch_state(config)
        self.assertEqual(state["registration"], "absent")
        self.assertIs(state["loaded"], False)
        self.assertFalse(state["active"] or state["stopped"])
        self.assertEqual([call.args[0] for call in command.call_args_list], [
            ["/bin/launchctl", "print", domain + "/com.example.ds4"],
            ["/bin/launchctl", "print", domain],
            ["/bin/launchctl", "print", domain + "/com.example.ds4"],
        ])

    def test_unreadable_or_changed_domain_is_not_absent_and_inspection_never_mutates(self):
        domain = f"gui/{os.getuid()}"
        scenarios = [
            ([("", 112)], "gui_domain_unavailable"),
            ([("", 1)], "unverified"),
            ([("", 113), ("", 112)], "gui_domain_unavailable"),
            ([("", 113), ("private diagnostic", 1)], "unverified"),
            ([("", 113), ("wrong-domain = {\n}\n", 0)], "unverified"),
            ([("", 113), (domain + " = {\n}\n", 0), ("", 112)], "gui_domain_unavailable"),
            ([("", 113), (domain + " = {\n}\n", 0), ("", 1)], "unverified"),
        ]
        for results, expected in scenarios:
            with self.subTest(expected=expected, results=results), patch.object(adapter, "run", side_effect=results) as command:
                state = adapter.launch_state({"label": "com.example.ds4"})
                self.assertEqual(state["registration"], expected)
                self.assertIsNone(state["loaded"])
                self.assertFalse(state["active"] or state["stopped"])
                self.assertTrue(all(call.args[0][1] == "print" for call in command.call_args_list))
                self.assertNotIn("private diagnostic", json.dumps(state))

    def test_job_appearing_during_absence_check_is_reported_loaded(self):
        domain = f"gui/{os.getuid()}"
        with patch.object(adapter, "run", side_effect=[("", 113), (domain + " = {\n}\n", 0), ("state = running\npid = 123\n", 0)]):
            state = adapter.launch_state({"label": "com.example.ds4"})
        self.assertEqual(state["registration"], "loaded")
        self.assertTrue(state["active"])
        self.assertEqual(state["pid"], 123)

    def test_malformed_pid_is_not_interpreted_as_a_stopped_job(self):
        for pid in ("unknown", "-1", "2147483648", "1"):
            with self.subTest(pid=pid), patch.object(adapter, "run", return_value=(f"state = exited\npid = {pid}\n", 0)):
                state = adapter.launch_state({"label": "com.example.ds4"})
                self.assertEqual(state["registration"], "unverified")
                self.assertIsNone(state["loaded"])
                self.assertFalse(state["stopped"])
        for output in ("state = exited\n", "state = exited\npid = 0\n", "state = not running\n"):
            with patch.object(adapter, "run", return_value=(output, 0)):
                state = adapter.launch_state({"label": "com.example.ds4"})
                self.assertEqual(state["registration"], "loaded")
                self.assertTrue(state["stopped"])

    def test_kernel_executable_path_is_bounded_and_fail_closed(self):
        for content,returned,valid in [(b'/opt/ds4/server',15,True),(b'relative',8,False),(b'/x',0,False),(b'/x',4096,False),(b'/x',3,False),(b'/\xff',2,False)]:
            with patch.object(adapter.ctypes, 'CDLL') as library:
                def query(pid,buffer,size):
                    self.assertEqual(pid,123);self.assertEqual(size,4096)
                    ctypes.memmove(buffer,content,len(content))
                    return returned
                library.return_value.proc_pidpath.side_effect=query
                if valid:self.assertEqual(adapter.process_executable(123),content.decode())
                else:
                    with self.assertRaises(ValueError):adapter.process_executable(123)
        with patch.object(adapter.ctypes,'CDLL',side_effect=OSError):
            with self.assertRaises(ValueError):adapter.process_executable(123)
        for pid in [True,0,-1,2147483648,'123']:
            with self.assertRaises(ValueError):adapter.process_executable(pid)

    def test_process_metadata_rechecks_kernel_executable_and_never_uses_text_mappings(self):
        with patch.object(adapter,'process_executable',side_effect=['/opt/ds4/server','/other']), patch.object(adapter,'run',side_effect=[('Fri Sep  4 10:00:00 2026',0),('/opt/ds4/server --port 8001',0),('Fri Sep  4 10:00:00 2026',0)]) as run:
            with self.assertRaisesRegex(ValueError,'service_executable_changed'):adapter.process_info(123)
            self.assertTrue(all(call.args[0][0]=='/bin/ps' for call in run.call_args_list))

    def test_same_executable_pid_reuse_during_metadata_reads_is_rejected(self):
        started='Fri Sep  4 10:00:00 2026'
        for checked in ('Fri Sep  4 10:00:01 2026',''):
            with patch.object(adapter,'process_executable',return_value='/opt/ds4/server'), patch.object(adapter,'run',side_effect=[(started,0),('/opt/ds4/server --port 8001',0),(checked,0)]):
                with self.assertRaisesRegex(ValueError,'service_start_time_changed'):adapter.process_info(123)
        with patch.object(adapter,'process_executable',return_value='/opt/ds4/server'), patch.object(adapter,'run',side_effect=[(started,0),('/opt/ds4/server --port 8001',0),(started+'\n',0)]):
            self.assertEqual(adapter.process_info(123)['executable'],'/opt/ds4/server')

    def files(self, temp):
        root = Path(temp)
        binary = root / "ds4-server"
        plist = root / "com.example.ds4.plist"
        settings = root / "settings.env"
        binary.write_bytes(b"binary-v1")
        plist.write_bytes(b"plist-v1")
        settings.write_bytes(b"DS4_CONTEXT=262144\n")
        return {
            "label": "com.example.ds4",
            "plist": str(plist),
            "port": 8001,
            "binary": str(binary),
            "profile_files": [str(settings)],
            "log_file": None,
        }

    def test_static_profile_covers_label_plist_binary_files_and_port(self):
        with tempfile.TemporaryDirectory() as temp:
            config = self.files(temp)
            baseline = adapter.service_profile(config)
            self.assertNotEqual(baseline, adapter.service_profile({**config, "label": "com.example.other"}))
            self.assertNotEqual(baseline, adapter.service_profile({**config, "port": 8002}))
            other_plist = Path(temp) / "same-bytes.plist"
            other_plist.write_bytes(b"plist-v1")
            self.assertNotEqual(baseline, adapter.service_profile({**config, "plist": str(other_plist)}))
            Path(config["plist"]).write_bytes(b"plist-v2")
            self.assertNotEqual(baseline, adapter.service_profile(config))
            Path(config["plist"]).write_bytes(b"plist-v1")
            Path(config["profile_files"][0]).write_bytes(b"DS4_CONTEXT=131072\n")
            self.assertNotEqual(baseline, adapter.service_profile(config))

    def test_launchctl_parser_and_live_inspection_are_bounded_identity_evidence(self):
        parsed = adapter.parse_launchctl("state = running\n\tpid = 123\n\truns = 7\n\tlast exit code = 0\n")
        self.assertEqual(parsed, {"state": "running", "pid": 123, "runs": 7, "last_exit": 0})
        with tempfile.TemporaryDirectory() as temp:
            config = self.files(temp)
            process = {"executable": config["binary"], "started_at": 1000, "command": config["binary"] + " --port 8001"}
            with patch.object(adapter, "machine_identity", return_value="a" * 64), patch.object(adapter, "service_profile", return_value="b" * 64), patch.object(adapter, "launch_state", return_value={"loaded": True, "active": True, "stopped": False, "pid": 123}), patch.object(adapter, "process_info", return_value=process), patch.object(adapter, "owns_listener", return_value=True), patch.object(adapter, "read_log_tail", return_value=""):
                result = adapter.inspect(config)
            self.assertEqual(result["machine"], "a" * 64)
            self.assertEqual(result["service_profile"], "b" * 64)
            self.assertTrue(result["active"] and result["listener"])
            self.assertRegex(result["instance"], r"^[a-f0-9]{32}$")
            self.assertRegex(result["profile"], r"^[a-f0-9]{64}$")
            self.assertNotIn(config["binary"], json.dumps(result))

    def test_fault_requires_current_process_and_is_invalidated_by_later_progress(self):
        fatal = "0904 10:00:00 ds4-server: ds4: CUDA synchronize failed: an illegal memory access was encountered"
        progress = "0904 10:00:01 ds4-server: chat ctx=1..2 decoding chunk=12"
        import datetime
        now = round(datetime.datetime(2026, 9, 4, 10, 0, 2).timestamp() * 1000)
        started = now - 10000
        self.assertIsNotNone(adapter.fault_evidence(fatal, started, now))
        self.assertIsNone(adapter.fault_evidence(fatal + "\n" + progress, started, now))
        self.assertIsNone(adapter.fault_evidence(fatal, now + 10000, now))
        self.assertIsNone(adapter.fault_evidence("0904 10:00:00 ds4-server: cuda prefill state reset failed", started, now))

    @patch.object(adapter, "native_disabled", lambda config: False)
    def test_restart_is_exact_launchd_job_and_durable_idempotent(self):
        current = {"active": True, "listener": True, "instance": "1" * 32, "machine": "a" * 64, "profile": "b" * 64, "fault": {"at": 1000}}
        request = {"action": "restart", "action_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "instance": current["instance"], "machine": current["machine"], "profile": current["profile"], "canary": False, "fault_after": 900}
        with tempfile.TemporaryDirectory() as temp, patch.object(adapter, "inspect", return_value=current), patch.object(adapter, "run") as command:
            state = Path(temp) / "actions.json"
            def issued(args):
                self.assertEqual(json.loads(state.read_text())[request["action_id"]]["state"], "intent")
                self.assertEqual(args, ["/bin/launchctl", "kickstart", "-k", f"gui/{os.getuid()}/com.example.ds4"])
                return "", 0
            command.side_effect = issued
            first = adapter.handle({"label": "com.example.ds4"}, request, state)
            self.assertEqual(first, adapter.handle({"label": "com.example.ds4"}, request, state))
            self.assertEqual(command.call_count, 1)
            with self.assertRaises(ValueError):
                adapter.handle({"label": "com.example.ds4"}, {**request, "profile": "c" * 64}, state)

    def test_restart_identity_and_fatal_checks_precede_any_effect(self):
        baseline = {"active": True, "listener": True, "instance": "1" * 32, "machine": "a" * 64, "profile": "b" * 64, "fault": {"at": 1000}}
        request = {"action": "restart", "action_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "instance": baseline["instance"], "machine": baseline["machine"], "profile": baseline["profile"], "canary": False, "fault_after": 900}
        for change in ({"instance": "2" * 32}, {"listener": False}, {"active": False}, {"profile": "changed"}, {"fault": None}, {"fault": {"at": 1}}):
            with tempfile.TemporaryDirectory() as temp, patch.object(adapter, "inspect", return_value={**baseline, **change}), patch.object(adapter, "run") as command:
                with self.assertRaises(ValueError):
                    adapter.handle({"label": "com.example.ds4"}, request, Path(temp) / "actions.json")
                command.assert_not_called()
        for bad in (True, float("nan"), float("inf"), -1):
            with tempfile.TemporaryDirectory() as temp, patch.object(adapter, "inspect", return_value=baseline), patch.object(adapter, "run") as command:
                with self.assertRaises(ValueError):
                    adapter.handle({"label": "com.example.ds4"}, {**request, "fault_after": bad}, Path(temp) / "actions.json")
                command.assert_not_called()

    @patch.object(adapter, "native_disabled", lambda config: False)
    def test_stopped_start_requires_exact_static_identity_and_issues_no_kill(self):
        current = {"active": False, "listener": False, "loaded": True, "stopped": True, "stopped_epoch": "d" * 64, "instance": "", "machine": "a" * 64, "service_profile": "c" * 64}
        request = {"action": "start", "action_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "stopped_epoch": current["stopped_epoch"], "machine": current["machine"], "service_profile": current["service_profile"]}
        with tempfile.TemporaryDirectory() as temp, patch.object(adapter, "inspect", return_value=current), patch.object(adapter, "run") as command:
            state = Path(temp) / "actions.json"
            command.return_value = "", 0
            adapter.handle({"label": "com.example.ds4"}, request, state)
            command.assert_called_once_with(["/bin/launchctl", "kickstart", f"gui/{os.getuid()}/com.example.ds4"])
            self.assertEqual(adapter.handle({"label": "com.example.ds4"}, request, state)["state"], "issued")
            self.assertEqual(command.call_count, 1)

    @patch.object(adapter, "native_disabled", lambda config: False)
    def test_ambiguous_command_failure_is_persisted_and_never_reissued(self):
        current = {"active": True, "listener": True, "instance": "1" * 32, "machine": "a" * 64, "profile": "b" * 64, "fault": {"at": 1000}}
        request = {"action": "restart", "action_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "instance": current["instance"], "machine": current["machine"], "profile": current["profile"], "canary": False, "fault_after": 900}
        with tempfile.TemporaryDirectory() as temp, patch.object(adapter, "inspect", return_value=current), patch.object(adapter, "run", side_effect=TimeoutError) as command:
            state = Path(temp) / "actions.json"
            with self.assertRaises(TimeoutError):
                adapter.handle({"label": "com.example.ds4"}, request, state)
            self.assertEqual(adapter.handle({"label": "com.example.ds4"}, request, state)["state"], "intent")
            self.assertEqual(command.call_count, 1)

    def test_config_is_exact_private_and_rejects_extra_authority(self):
        with tempfile.TemporaryDirectory() as temp:
            config = self.files(temp)
            path = Path(temp) / "recovery.json"
            path.write_text(json.dumps(config))
            os.chmod(path, 0o600)
            adapter.validate_config(path, config)
            self.assertEqual(adapter.read_private_config(path), config)
            with self.assertRaises(ValueError):
                adapter.validate_config(path, {**config, "command": "reboot"})
            link = Path(temp) / "linked.json"
            link.symlink_to(path)
            with self.assertRaises(ValueError):
                adapter.read_private_config(link)
            os.chmod(path, 0o644)
            with self.assertRaises(ValueError):
                adapter.validate_config(path, config)

    def test_private_state_and_no_follow_log_inputs_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = root / "actions.json"
            state.write_text("{}")
            os.chmod(state, 0o644)
            with self.assertRaises(ValueError):
                adapter.load_history(state)
            os.chmod(state, 0o600)
            link = root / "actions-link.json"
            link.symlink_to(state)
            with self.assertRaises(ValueError):
                adapter.load_history(link)
            log = root / "engine.log"
            log.write_text("0904 10:00:00 ds4-server: ordinary line\n")
            self.assertIn("ordinary line", adapter.read_log_tail(log))
            log_link = root / "engine-link.log"
            log_link.symlink_to(log)
            with self.assertRaises(ValueError):
                adapter.read_log_tail(log_link)


if __name__ == "__main__":
    unittest.main()
