import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("adapter", Path(__file__).with_name("recovery-systemd.py"))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class AdapterTests(unittest.TestCase):
    def test_static_service_profile_covers_unit_binary_files_and_port(self):
        with tempfile.TemporaryDirectory() as temp:
            binary = Path(temp) / "ds4-server"
            settings = Path(temp) / "settings.env"
            binary.write_bytes(b"binary-v1")
            settings.write_bytes(b"DS4_CONTEXT=262144\n")
            config = {"unit": "ds4.service", "port": 8000, "binary": str(binary), "profile_files": [str(settings)]}
            baseline = adapter.service_profile(config, "[Service]\nExecStart=/opt/ds4/run.sh\n")
            self.assertNotEqual(baseline, adapter.service_profile({**config, "port": 8001}, "[Service]\nExecStart=/opt/ds4/run.sh\n"))
            self.assertNotEqual(baseline, adapter.service_profile(config, "[Service]\nExecStart=/opt/ds4/other.sh\n"))
            settings.write_bytes(b"DS4_CONTEXT=131072\n")
            self.assertNotEqual(baseline, adapter.service_profile(config, "[Service]\nExecStart=/opt/ds4/run.sh\n"))

    def test_live_profile_recipe_is_unchanged(self):
        files = {"/opt/ds4/run.sh": "a" * 64, "/opt/ds4/ds4-server": "b" * 64}
        self.assertEqual(
            adapter.runtime_profile(files, b"/opt/ds4/ds4-server\0--port\08000\0", [b"DS4_A=1", b"DS4_B=2"], "[Service]\nExecStart=/opt/ds4/run.sh\n"),
            "b679da13fff5fbc301e2a32ccbc3b0a97c38b8279c6827f37cc3a8ee86856047",
        )

    def test_fault_requires_current_invocation_and_exact_engine_error(self):
        def line(message, invocation="one", time=1000):
            return json.dumps({"MESSAGE": message, "_SYSTEMD_INVOCATION_ID": invocation, "__REALTIME_TIMESTAMP": str(time * 1000)})
        fatal = "ds4: CUDA synchronize failed: an illegal memory access was encountered"
        self.assertIsNotNone(adapter.fault_evidence(line(fatal), "one"))
        self.assertIsNone(adapter.fault_evidence(line(fatal, "old"), "one"))
        self.assertIsNone(adapter.fault_evidence(line("Answer: " + fatal), "one"))
        self.assertIsNone(adapter.fault_evidence(line("cuda prefill state reset failed"), "one"))
        self.assertIsNone(adapter.fault_evidence(line(fatal) + "\n" + line("0903 00:00:00 ds4-server: chat ctx=1..2 decoding chunk=12", time=2000), "one"))

    def test_restart_is_exact_service_and_durable_idempotent(self):
        current = {"active": True, "listener": True, "instance": "1" * 32, "machine": "a" * 64, "profile": "b" * 64, "fault": {"at": 1000}}
        request = {"action": "restart", "action_id": "a" * 36, "instance": current["instance"], "machine": current["machine"], "profile": current["profile"], "canary": False, "fault_after": 900}
        with tempfile.TemporaryDirectory() as temp, patch.object(adapter, "inspect", return_value=current), patch.object(adapter, "run") as command:
            state = Path(temp) / "actions.json"
            def issued(args):
                self.assertEqual(json.loads(state.read_text())[request["action_id"]]["state"], "intent")
                self.assertEqual(args, ["systemctl", "--user", "restart", "--no-block", "ds4.service"])
            command.side_effect = issued
            first = adapter.handle({"unit": "ds4.service"}, request, state)
            self.assertEqual(first, adapter.handle({"unit": "ds4.service"}, request, state))
            self.assertEqual(command.call_count, 1)
            with self.assertRaises(ValueError):
                adapter.handle({"unit": "ds4.service"}, {**request, "action_id": "b" * 36}, state)
            with self.assertRaises(ValueError):
                adapter.handle({"unit": "ds4.service"}, {**request, "profile": "c" * 64}, state)

    def test_identity_and_fatal_checks_precede_any_effect(self):
        baseline = {"active": True, "listener": True, "instance": "1" * 32, "machine": "a" * 64, "profile": "b" * 64, "fault": {"at": 1000}}
        request = {"action": "restart", "action_id": "a" * 36, "instance": baseline["instance"], "machine": baseline["machine"], "profile": baseline["profile"], "canary": False, "fault_after": 900}
        for change in [{"instance": "2" * 32}, {"listener": False}, {"active": False}, {"profile": "changed"}, {"fault": None}, {"fault": {"at": 1}}]:
            with tempfile.TemporaryDirectory() as temp, patch.object(adapter, "inspect", return_value={**baseline, **change}), patch.object(adapter, "run") as command:
                with self.assertRaises(ValueError):
                    adapter.handle({"unit": "ds4.service"}, request, Path(temp) / "actions.json")
                command.assert_not_called()

    def test_ambiguous_command_failure_is_not_reissued(self):
        current = {"active": True, "listener": True, "instance": "1" * 32, "machine": "a" * 64, "profile": "b" * 64, "fault": {"at": 1000}}
        request = {"action": "restart", "action_id": "a" * 36, "instance": current["instance"], "machine": current["machine"], "profile": current["profile"], "canary": False, "fault_after": 900}
        with tempfile.TemporaryDirectory() as temp, patch.object(adapter, "inspect", return_value=current), patch.object(adapter, "run", side_effect=TimeoutError) as command:
            state = Path(temp) / "actions.json"
            with self.assertRaises(TimeoutError):
                adapter.handle({"unit": "ds4.service"}, request, state)
            self.assertEqual(adapter.handle({"unit": "ds4.service"}, request, state)["state"], "intent")
            self.assertEqual(command.call_count, 1)

    def test_stopped_service_start_requires_exact_static_identity_and_is_idempotent(self):
        current = {
            "active": False,
            "listener": False,
            "loaded": True,
            "stopped": True,
            "stopped_epoch": "d" * 64,
            "instance": "",
            "machine": "a" * 64,
            "service_profile": "c" * 64,
        }
        request = {
            "action": "start",
            "action_id": "a" * 36,
            "stopped_epoch": current["stopped_epoch"],
            "machine": current["machine"],
            "service_profile": current["service_profile"],
        }
        with tempfile.TemporaryDirectory() as temp, patch.object(adapter, "inspect", return_value=current), patch.object(adapter, "run") as command:
            state = Path(temp) / "actions.json"
            def issued(args):
                saved = json.loads(state.read_text())[request["action_id"]]
                self.assertEqual(saved["state"], "intent")
                self.assertEqual(saved["operation"], "start")
                self.assertEqual(args, ["systemctl", "--user", "start", "--no-block", "ds4.service"])
            command.side_effect = issued
            first = adapter.handle({"unit": "ds4.service"}, request, state)
            self.assertEqual(first, adapter.handle({"unit": "ds4.service"}, request, state))
            self.assertEqual(command.call_count, 1)
            with self.assertRaises(ValueError):
                adapter.handle({"unit": "ds4.service"}, {**request, "action_id": "b" * 36}, state)

    def test_stopped_service_identity_checks_precede_start(self):
        baseline = {
            "active": False,
            "listener": False,
            "loaded": True,
            "stopped": True,
            "stopped_epoch": "d" * 64,
            "machine": "a" * 64,
            "service_profile": "c" * 64,
        }
        request = {
            "action": "start",
            "action_id": "a" * 36,
            "stopped_epoch": baseline["stopped_epoch"],
            "machine": baseline["machine"],
            "service_profile": baseline["service_profile"],
        }
        changes = [
            {"active": True}, {"listener": True}, {"loaded": False}, {"stopped": False},
            {"stopped_epoch": "e" * 64}, {"machine": "b" * 64}, {"service_profile": "f" * 64},
        ]
        for change in changes:
            with tempfile.TemporaryDirectory() as temp, patch.object(adapter, "inspect", return_value={**baseline, **change}), patch.object(adapter, "run") as command:
                with self.assertRaises(ValueError):
                    adapter.handle({"unit": "ds4.service"}, request, Path(temp) / "actions.json")
                command.assert_not_called()

    def test_ambiguous_stopped_start_is_not_reissued(self):
        current = {
            "active": False, "listener": False, "loaded": True, "stopped": True,
            "stopped_epoch": "d" * 64, "instance": "", "machine": "a" * 64,
            "service_profile": "c" * 64,
        }
        request = {
            "action": "start", "action_id": "a" * 36,
            "stopped_epoch": current["stopped_epoch"], "machine": current["machine"],
            "service_profile": current["service_profile"],
        }
        with tempfile.TemporaryDirectory() as temp, patch.object(adapter, "inspect", return_value=current), patch.object(adapter, "run", side_effect=TimeoutError) as command:
            state = Path(temp) / "actions.json"
            with self.assertRaises(TimeoutError):
                adapter.handle({"unit": "ds4.service"}, request, state)
            self.assertEqual(adapter.handle({"unit": "ds4.service"}, request, state)["state"], "intent")
            self.assertEqual(command.call_count, 1)


if __name__ == "__main__":
    unittest.main()
