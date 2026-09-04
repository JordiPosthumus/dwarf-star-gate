import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("launchd_adapter", Path(__file__).with_name("recovery-launchd.py"))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class LaunchdAdapterTests(unittest.TestCase):
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

    def test_restart_is_exact_launchd_job_and_durable_idempotent(self):
        current = {"active": True, "listener": True, "instance": "1" * 32, "machine": "a" * 64, "profile": "b" * 64, "fault": {"at": 1000}}
        request = {"action": "restart", "action_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "instance": current["instance"], "machine": current["machine"], "profile": current["profile"], "canary": False, "fault_after": 900}
        with tempfile.TemporaryDirectory() as temp, patch.object(adapter, "inspect", return_value=current), patch.object(adapter, "run") as command, patch.object(adapter.os, "getuid", return_value=501):
            state = Path(temp) / "actions.json"
            def issued(args):
                self.assertEqual(json.loads(state.read_text())[request["action_id"]]["state"], "intent")
                self.assertEqual(args, ["/bin/launchctl", "kickstart", "-k", "gui/501/com.example.ds4"])
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

    def test_stopped_start_requires_exact_static_identity_and_issues_no_kill(self):
        current = {"active": False, "listener": False, "loaded": True, "stopped": True, "stopped_epoch": "d" * 64, "instance": "", "machine": "a" * 64, "service_profile": "c" * 64}
        request = {"action": "start", "action_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "stopped_epoch": current["stopped_epoch"], "machine": current["machine"], "service_profile": current["service_profile"]}
        with tempfile.TemporaryDirectory() as temp, patch.object(adapter, "inspect", return_value=current), patch.object(adapter, "run") as command, patch.object(adapter.os, "getuid", return_value=501):
            state = Path(temp) / "actions.json"
            command.return_value = "", 0
            adapter.handle({"label": "com.example.ds4"}, request, state)
            command.assert_called_once_with(["/bin/launchctl", "kickstart", "gui/501/com.example.ds4"])
            self.assertEqual(adapter.handle({"label": "com.example.ds4"}, request, state)["state"], "issued")
            self.assertEqual(command.call_count, 1)

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
