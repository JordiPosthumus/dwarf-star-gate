import contextlib
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("native_smoke", Path(__file__).resolve().parents[1] / "scripts" / "launchd-recovery-smoke.py")
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class NativeSmokeScopeTests(unittest.TestCase):
    def test_cli_never_accepts_existing_targets_and_requires_exact_opt_in(self):
        with patch.object(smoke, "run_smoke", return_value=0) as run, contextlib.redirect_stdout(io.StringIO()):
            for args, code in [([], 0), (["--help"], 0), (["--run", "--worker", "existing"], 2), (["--run", "--label", "com.example.ds4"], 2), (["--config", "/private/existing.json"], 2)]:
                self.assertEqual(smoke.main(args), code)
                run.assert_not_called()
            self.assertEqual(smoke.main(["--run"]), 0)
            run.assert_called_once()

    def test_environment_guard_never_creates_files_or_queries_native_state(self):
        for platform, uid in [("linux", 501), ("darwin", 0)]:
            output = io.StringIO()
            with patch.object(smoke.sys, "platform", platform), patch.object(smoke.os, "getuid", return_value=uid), \
                    patch.object(smoke, "helper_module") as helper, patch.object(smoke.tempfile, "mkdtemp") as directory, contextlib.redirect_stdout(output):
                self.assertEqual(smoke.main(["--run"]), 1)
                self.assertEqual(json.loads(output.getvalue())["reason"], "non_root_macos_session_required")
                helper.assert_not_called(); directory.assert_not_called()

    def test_generated_fixture_is_private_loopback_only_and_not_a_model_server(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            config = smoke.fixture(root, Path("/opt/fixture/node"), 39001, "synthetic-nonce", "com.dsg.fixture.synthetic")
            definition = plistlib.loads(Path(config["plist"]).read_bytes())
            self.assertEqual(definition["Label"], "com.dsg.fixture.synthetic")
            self.assertEqual(definition["ProgramArguments"], ["/opt/fixture/node", str(root / "fixture.mjs"), "39001", "synthetic-nonce"])
            self.assertIs(definition["RunAtLoad"], True); self.assertIs(definition["KeepAlive"], False)
            self.assertEqual(config["bootstrap_callers"], [])
            self.assertIn("'127.0.0.1'", smoke.SERVER)
            self.assertNotIn("/v1/chat/completions", smoke.SERVER)
            self.assertNotIn("cached_tokens", smoke.SERVER)
            self.assertIn("setTimeout(()=>process.exit(0),300000).unref()", smoke.SERVER)
            for name in ["fixture.mjs", "retained.plist", "fixture.stdout", "fixture.stderr"]:
                self.assertEqual((root / name).stat().st_mode & 0o777, 0o600)

    def test_sigterm_handler_uses_cleanup_exception_and_restores_prior_handler(self):
        previous = smoke.signal.getsignal(smoke.signal.SIGTERM)
        def interrupted_run():
            handler = smoke.signal.getsignal(smoke.signal.SIGTERM)
            handler(smoke.signal.SIGTERM, None)
        output = io.StringIO()
        with patch.object(smoke, "run_smoke", side_effect=interrupted_run), contextlib.redirect_stdout(output):
            self.assertEqual(smoke.main(["--run"]), 1)
        self.assertEqual(json.loads(output.getvalue())["reason"], "fixture_interrupted")
        self.assertEqual(smoke.signal.getsignal(smoke.signal.SIGTERM), previous)

    def test_uncertain_fixture_registration_still_unregisters_only_its_own_random_job(self):
        for error in [ValueError("fixture_interrupted"), KeyboardInterrupt()]:
            with self.subTest(error=type(error).__name__), tempfile.TemporaryDirectory() as temp:
                root = Path(temp).resolve()
                calls = []
                def run(command, **_options):
                    calls.append(command)
                    if command[1] == "print":
                        return "gui/501 = {\n}\n", 0
                    if command[1] == "bootstrap":
                        raise error  # An acknowledgement can be lost after registration.
                    self.assertEqual(command[1], "bootout")
                    return "", 0
                adapter = SimpleNamespace(run=run, file_digest=lambda _file:"d"*64, validate_config=lambda *_args:None,
                                          launch_state=lambda _config:{"registration":"absent"}, port_occupied=lambda _port:False,
                                          handle=lambda *_args:{"verified":True})
                reservation = SimpleNamespace(bind=lambda _address:None, getsockname=lambda:("127.0.0.1", 39001))
                with patch.object(smoke.sys, "platform", "darwin"), patch.object(smoke.os, "getuid", return_value=501), \
                        patch.object(smoke.shutil, "which", return_value=__file__), patch.object(smoke, "helper_module", return_value=adapter), \
                        patch.object(smoke.tempfile, "mkdtemp", return_value=str(root)), patch.object(smoke.socket, "socket") as sock, contextlib.redirect_stdout(io.StringIO()):
                    sock.return_value.__enter__.return_value = reservation
                    self.assertEqual(smoke.main(["--run"]), 1)
                receipt = json.loads((root / "receipt.json").read_text())
                self.assertEqual(receipt["cleanup"], "fixture_job_absent_and_port_free")
                self.assertEqual(receipt["outcome"], "failed")
                self.assertEqual([c[1] for c in calls], ["print", "bootstrap", "bootout"])
                label = json.loads((root / "helper.json").read_text())["label"]
                self.assertRegex(label, r"^com\.dsg\.fixture\.[a-f0-9]{32}$")
                self.assertEqual(calls[-1], ["/bin/launchctl", "bootout", "gui/501/" + label])


if __name__ == "__main__":
    unittest.main()
