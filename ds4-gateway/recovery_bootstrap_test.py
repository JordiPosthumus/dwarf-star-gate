"""Synthetic native boundaries only; never register or stop a real job."""
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bootstrap_adapter", Path(__file__).with_name("recovery-launchd.py"))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

NOW = 1788566400000
BOOT = "12345678-1234-1234-1234-123456789abc"
ACTION = "12345678-1234-4123-8123-123456789abc"
OTHER_ACTION = "12345678-1234-4123-8123-123456789abd"


class BootstrapTests(unittest.TestCase):
    def fixture(self, directory, fmt=plistlib.FMT_XML):
        root = Path(directory).resolve()
        definition = {"Label": "com.example.ds4", "ProgramArguments": ["/opt/ds4/runner", "--context", "262144", ""],
                      "EnvironmentVariables": {"PRIVATE_KEY": "private-value"}, "RunAtLoad": True,
                      "KeepAlive": True, "WorkingDirectory": "/opt/ds4", "ExitTimeOut": 120}
        raw = plistlib.dumps(definition, fmt=fmt)
        filename = root / "retained.plist"
        filename.write_bytes(raw); filename.chmod(0o600)
        config = {"label": definition["Label"], "plist": str(filename), "retained_definition_sha256": adapter.digest(raw),
                  "bootstrap_removed": True, "bootstrap_callers": ["loginwindow"], "port": 8001,
                  "binary": "/opt/ds4/ds4-server", "profile_files": ["/opt/ds4/runner"]}
        prior = {"machine": "a" * 64, "profile": "b" * 64, "service_profile": "c" * 64, "pid": 123,
                 "started_at": NOW - 3600000, "observed_at": NOW - 60000, "boot_uuid": BOOT}
        prior["instance"] = adapter.digest(json.dumps({"label": config["label"], "machine": prior["machine"],
            "pid": prior["pid"], "started_at": prior["started_at"]}, sort_keys=True).encode())[:32]
        request = {"action": "bootstrap", "action_id": ACTION, "prior": prior,
                   "definition_sha256": config["retained_definition_sha256"], "canary": False}
        return config, request, root / "actions.json", raw

    def native(self, config, request, caller="loginwindow"):
        stack = ExitStack()
        stack.enter_context(patch.object(adapter.time, "time", return_value=NOW / 1000))
        stack.enter_context(patch.object(adapter, "machine_identity", return_value=request["prior"]["machine"]))
        stack.enter_context(patch.object(adapter, "boot_identity", return_value=BOOT))
        stack.enter_context(patch.object(adapter, "service_profile", return_value=request["prior"]["service_profile"]))
        stack.enter_context(patch.object(adapter, "launch_state", return_value={"registration": "absent"}))
        stack.enter_context(patch.object(adapter, "native_disabled", return_value=False))
        stack.enter_context(patch.object(adapter, "port_occupied", return_value=False))
        event = {"eventType": "logEvent", "timestamp": "2026-09-04T23:59:30Z", "processID": 1,
                 "processImagePath": "/sbin/launchd", "senderImagePath": "/sbin/launchd", "bootUUID": BOOT,
                 "subsystem": f"gui/{os.getuid()}/{config['label']} [123]", "eventMessage": f"removing job: caller = {caller}"}
        stack.enter_context(patch.object(adapter, "bounded_capture", return_value=json.dumps(event) + '\n{"count":1,"finished":1}\n'))
        return stack

    def test_exact_xml_and_binary_are_durably_staged_once_and_native_request_has_no_custom_command(self):
        for fmt in [plistlib.FMT_XML, plistlib.FMT_BINARY]:
            with self.subTest(fmt=fmt), tempfile.TemporaryDirectory() as temp:
                config, request, state, raw = self.fixture(temp, fmt)
                staged = state.parent / f"bootstrap-{ACTION}.plist"
                def issue(command):
                    self.assertEqual(command, ["/bin/launchctl", "bootstrap", f"gui/{os.getuid()}", str(staged)])
                    self.assertEqual(adapter.load_history(state)[ACTION]["state"], "intent")
                    self.assertEqual(staged.read_bytes(), raw)
                    self.assertEqual(staged.stat().st_mode & 0o777, 0o400)
                    return "", 0
                with self.native(config, request), patch.object(adapter, "run", side_effect=issue) as command:
                    result = adapter.handle(config, request, state)
                    self.assertEqual(result["state"], "issued")
                    self.assertEqual(adapter.handle(config, request, state), result)
                    command.assert_called_once()
                    with self.assertRaisesRegex(ValueError, "removed_instance_already_attempted"):
                        adapter.handle(config, {**request, "action_id": OTHER_ACTION}, state)
                    with self.assertRaisesRegex(ValueError, "action_id_conflict"):
                        adapter.handle(config, {**request, "canary": True}, state)
                self.assertEqual(Path(config["plist"]).read_bytes(), raw)
                self.assertTrue(staged.exists())
                for private in [str(state.parent), "private-value", "/opt/ds4/runner", config["label"]]:
                    self.assertNotIn(private, json.dumps(result))

    def test_bootstrap_enrollment_is_explicit_and_does_not_change_service_profile(self):
        with tempfile.TemporaryDirectory() as temp:
            config, request, state, _ = self.fixture(temp)
            filename = state.parent / "config.json"
            filename.write_text(json.dumps(config)); filename.chmod(0o600)
            adapter.validate_config(filename, config)
            adapter.validate_config(filename, {**config, "bootstrap_callers": []})
            for change in [{"bootstrap_removed": "yes"}, {"bootstrap_removed": 1}, {"bootstrap_callers": "loginwindow"},
                           {"bootstrap_callers": ["launchctl"]}, {"bootstrap_callers": ["other"]},
                           {"bootstrap_callers": ["loginwindow", "loginwindow"]}, {"bootstrap_removed": False}]:
                with self.subTest(change=change), self.assertRaisesRegex(ValueError, "invalid_bootstrap_configuration"):
                    adapter.validate_config(filename, {**config, **change})
            with self.assertRaisesRegex(ValueError, "invalid_bootstrap_configuration"):
                adapter.validate_config(filename, {k:v for k,v in config.items() if k != "retained_definition_sha256"})
            with patch.object(adapter, "file_digest", return_value="d" * 64):
                self.assertEqual(adapter.service_profile(config), adapter.service_profile({k:v for k,v in config.items() if not k.startswith("bootstrap_")}))
            for change, error in [({"bootstrap_removed": False}, "not_enrolled"),
                                  ({"retained_definition_sha256": "d" * 64}, "enrollment_changed")]:
                with patch.object(adapter, "run") as command, self.assertRaisesRegex(ValueError, error):
                    adapter.handle({**config, **change}, request, state)
                command.assert_not_called()
                self.assertFalse(state.exists())

    def test_caller_policy_and_operator_canary_are_separate(self):
        for caller, allowed, canary, succeeds in [
            ("loginwindow", ["loginwindow"], False, True), ("runningboardd", ["runningboardd"], False, True),
            ("runningboardd", ["loginwindow"], False, False), ("loginwindow", [], False, False),
            ("launchctl", ["loginwindow"], False, False), ("launchctl", [], True, True),
            ("unknown", [], True, False), ("loginwindow", [], True, False)]:
            with self.subTest(caller=caller, allowed=allowed, canary=canary), tempfile.TemporaryDirectory() as temp:
                config, request, state, _ = self.fixture(temp)
                config["bootstrap_callers"] = allowed; request["canary"] = canary
                with self.native(config, request, caller), patch.object(adapter, "run", return_value=("", 0)) as command:
                    if succeeds:
                        self.assertEqual(adapter.handle(config, request, state)["state"], "issued")
                        command.assert_called_once()
                    else:
                        with self.assertRaisesRegex(ValueError, "caller_not_enrolled"):
                            adapter.handle(config, request, state)
                        command.assert_not_called()
                        self.assertFalse(state.exists())

    def test_fresh_identity_native_policy_port_and_provenance_veto_before_intent(self):
        for method, value in [("boot_identity", None), ("machine_identity", "changed"), ("service_profile", "changed"),
                              ("launch_state", {"registration": "loaded"}), ("native_disabled", True), ("native_disabled", None),
                              ("port_occupied", True), ("bounded_capture", '{"count":0,"finished":1}\n')]:
            with self.subTest(method=method, value=value), tempfile.TemporaryDirectory() as temp:
                config, request, state, _ = self.fixture(temp)
                with self.native(config, request), patch.object(adapter, method, return_value=value), patch.object(adapter, "run") as command:
                    with self.assertRaises(ValueError):
                        adapter.handle(config, request, state)
                    command.assert_not_called()
                    self.assertFalse(state.exists())
                    self.assertFalse(list(state.parent.glob("bootstrap-*.plist")))

    def test_post_intent_races_leave_receipt_and_never_reissue(self):
        for mutation in ["boot", "machine", "profile", "registration", "disabled", "port", "original", "staged"]:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temp:
                config, request, state, raw = self.fixture(temp)
                save = adapter.atomic_save
                changed = ExitStack()
                def intent(path, history):
                    save(path, history)
                    if mutation == "original":
                        Path(config["plist"]).write_bytes(raw + b"\n")
                    elif mutation == "staged":
                        staged = state.parent / f"bootstrap-{ACTION}.plist"
                        staged.chmod(0o600); staged.write_bytes(raw + b"\n")
                    else:
                        method, value = {"boot": ("boot_identity", None), "machine": ("machine_identity", "changed"),
                            "profile": ("service_profile", "changed"), "registration": ("launch_state", {"registration": "loaded"}),
                            "disabled": ("native_disabled", True), "port": ("port_occupied", True)}[mutation]
                        changed.enter_context(patch.object(adapter, method, return_value=value))
                with self.native(config, request), changed, patch.object(adapter, "atomic_save", side_effect=intent), patch.object(adapter, "run") as command:
                    with self.assertRaises(ValueError):
                        adapter.handle(config, request, state)
                    self.assertEqual(adapter.load_history(state)[ACTION]["state"], "intent")
                    self.assertEqual(adapter.handle(config, request, state)["state"], "intent")
                    command.assert_not_called()

    def test_unknown_acknowledgement_and_failed_receipt_write_do_not_repeat_command(self):
        for failure in ["command", "issued_receipt"]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp:
                config, request, state, _ = self.fixture(temp)
                save = adapter.atomic_save
                def write(path, history):
                    if failure == "issued_receipt" and history[ACTION]["state"] == "issued":
                        raise OSError("private write detail")
                    save(path, history)
                with self.native(config, request), patch.object(adapter, "atomic_save", side_effect=write), patch.object(adapter, "run", side_effect=subprocess.TimeoutExpired("private", 15) if failure == "command" else None, return_value=("", 0)) as command:
                    with self.assertRaises((OSError, subprocess.TimeoutExpired)):
                        adapter.handle(config, request, state)
                    self.assertEqual(adapter.handle(config, request, state)["state"], "intent")
                    command.assert_called_once()

    def test_unsupported_definitions_no_native_command_or_settings_rewrite(self):
        for update in [{"RunAtLoad": False, "KeepAlive": False}, {"BundleProgram": "Contents/MacOS/runner"}, {"RootDirectory": "/opt/other"}]:
            with self.subTest(update=update), tempfile.TemporaryDirectory() as temp:
                config, request, state, raw = self.fixture(temp)
                raw = plistlib.dumps({**plistlib.loads(raw), **update})
                Path(config["plist"]).write_bytes(raw)
                request["definition_sha256"] = config["retained_definition_sha256"] = adapter.digest(raw)
                with self.native(config, request), patch.object(adapter, "run") as command:
                    with self.assertRaisesRegex(ValueError, "definition_requires_review"):
                        adapter.handle(config, request, state)
                    command.assert_not_called()
                    self.assertFalse(state.exists())
                    self.assertEqual(Path(config["plist"]).read_bytes(), raw)

    def test_protocol_rejects_injected_scope_and_invalid_types_before_creating_files(self):
        for update in [{"command": "invented"}, {"path": "/tmp/not-enrolled"}, {"canary": 1}, {"prior": []},
                       {"definition_sha256": "not-a-digest"}, {"action_id": "../../escape"}]:
            with self.subTest(update=update), tempfile.TemporaryDirectory() as temp:
                config, request, state, _ = self.fixture(temp)
                with patch.object(adapter, "run") as command, self.assertRaisesRegex(ValueError, "invalid_adapter_request"):
                    adapter.handle(config, {**request, **update}, state)
                command.assert_not_called()
                self.assertEqual([p.name for p in state.parent.iterdir()], ["retained.plist"])

    def test_multiple_removals_or_partial_native_capture_never_authorize_bootstrap(self):
        for kind in ["repeated", "conflicting", "partial", "wrong_prior"]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temp:
                config, request, state, _ = self.fixture(temp)
                with self.native(config, request), patch.object(adapter, "run") as command:
                    original = adapter.bounded_capture.return_value
                    event = json.loads(original.splitlines()[0])
                    if kind == "partial":
                        adapter.bounded_capture.return_value = original.splitlines()[0] + "\n"
                    elif kind == "wrong_prior":
                        request["prior"]["instance"] = "invented"
                    else:
                        extra = {**event, "timestamp": "2026-09-04T23:59:31Z"}
                        if kind == "conflicting":
                            extra["eventMessage"] = "removing job: caller = launchctl"
                        adapter.bounded_capture.return_value = json.dumps(event) + "\n" + json.dumps(extra) + '\n{"count":2,"finished":1}\n'
                    with self.assertRaisesRegex(ValueError, "exact_removal_required"):
                        adapter.handle(config, request, state)
                    command.assert_not_called()
                    self.assertFalse(state.exists())

    def test_staging_never_overwrites_an_existing_artifact_and_failed_intent_never_issues(self):
        for kind in ["existing", "symlink", "intent_write"]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temp:
                config, request, state, raw = self.fixture(temp)
                staged = state.parent / f"bootstrap-{ACTION}.plist"
                if kind == "existing":
                    staged.write_bytes(b"existing artifact")
                elif kind == "symlink":
                    staged.symlink_to(config["plist"])
                with self.native(config, request), patch.object(adapter, "run") as command, patch.object(adapter, "atomic_save", side_effect=OSError("disk unavailable")):
                    with self.assertRaises(OSError):
                        adapter.handle(config, request, state)
                    command.assert_not_called()
                    self.assertFalse(state.exists())
                    self.assertEqual(Path(config["plist"]).read_bytes(), raw)
                    if kind == "existing":
                        self.assertEqual(staged.read_bytes(), b"existing artifact")
                    elif kind == "symlink":
                        self.assertTrue(staged.is_symlink())
                    else:
                        self.assertEqual(staged.read_bytes(), raw)


if __name__ == "__main__":
    unittest.main()
