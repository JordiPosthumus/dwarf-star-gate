import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("native_capture_adapter", Path(__file__).with_name("recovery-launchd.py"))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

NOW = 1788566400000
BOOT = "12345678-1234-1234-1234-123456789abc"
CONFIG = {"label": "com.example.ds4"}
PRIOR = {"machine": "a" * 64, "profile": "b" * 64, "service_profile": "c" * 64, "pid": 123,
         "started_at": NOW - 3600000, "observed_at": NOW - 60000, "boot_uuid": BOOT}
PRIOR["instance"] = adapter.digest(json.dumps({"label": CONFIG["label"], **{k: PRIOR[k] for k in ("machine", "pid", "started_at")}}, sort_keys=True).encode())[:32]


def event(**changes):
    return {"eventType": "logEvent", "timestamp": "2026-09-05T00:00:00Z", "subsystem": f"gui/{os.getuid()}/com.example.ds4 [123]",
            "processID": 1, "processImagePath": "/sbin/launchd", "senderImagePath": "/sbin/launchd", "bootUUID": BOOT,
            "eventMessage": "removing job: caller = loginwindow", **changes}


def archive(rows):
    return "".join(json.dumps(row) + "\n" for row in [*rows, {"count": len(rows), "finished": 1}])


class NativeCaptureTests(unittest.TestCase):
    def test_native_bootout_request_is_distinct_stop_intent_not_completed_removal(self):
        message = "bootout initiated by: launchctl[321]<-fixture-runner[300]<-fixture-ui[299]"
        result = adapter.audit_native_removal(archive([event(eventMessage=message)]), CONFIG["label"], 123, BOOT, NOW - 60000, NOW)
        self.assertEqual(result["status"], "exact_stop_request_observed")
        self.assertEqual(result["observations"][0]["caller"], "launchctl")
        self.assertTrue(result["native_stop_caller_observed"])
        self.assertNotIn("fixture-runner", json.dumps(result))
        for bad in [message.replace("[321]", "[1]"), message.replace("[321]", "[2147483648]"), message + "\n", message + "\nextra", "bootout initiated by: launchctl[321]<-", "bootout initiated by: launchctl[321]<-" + "x" * 1025]:
            self.assertEqual(adapter.audit_native_removal(archive([event(eventMessage=bad)]), CONFIG["label"], 123, BOOT, NOW - 60000, NOW)["status"], "no_exact_removal_record")
        for change in [{"processID": 2}, {"senderImagePath": "/tmp/fake"}, {"bootUUID": None}, {"subsystem": "gui/999/com.example.ds4 [123]"}, {"timestamp": "2026-09-04T23:00:00Z"}]:
            self.assertEqual(adapter.audit_native_removal(archive([event(eventMessage=message, **change)]), CONFIG["label"], 123, BOOT, NOW - 60000, NOW)["status"], "no_exact_removal_record")
        mixed = adapter.audit_native_removal(archive([event(), event(eventMessage=message)]), CONFIG["label"], 123, BOOT, NOW - 60000, NOW)
        self.assertEqual(mixed["status"], "conflicting_callers")
        self.assertEqual(len(mixed["observations"]), 2)

    def test_boot_identity_requires_exact_native_success_and_does_not_invent_a_boot(self):
        with patch.object(adapter, "run", return_value=(BOOT.upper() + "\n", 0)) as command:
            self.assertEqual(adapter.boot_identity(), BOOT)
            command.assert_called_once_with(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], check=False)
        for result in [(BOOT, 1), ("private-value", 0), ("", 0)]:
            with patch.object(adapter, "run", return_value=result):
                self.assertIsNone(adapter.boot_identity())

    def test_native_query_is_fixed_scoped_read_only_and_returns_no_private_identity(self):
        with patch.object(adapter.time, "time", return_value=NOW / 1000), patch.object(adapter, "machine_identity", return_value=PRIOR["machine"]), \
                patch.object(adapter, "service_profile", return_value=PRIOR["service_profile"]), patch.object(adapter, "boot_identity", return_value=BOOT), \
                patch.object(adapter, "launch_state", return_value={"registration": "absent"}), patch.object(adapter, "bounded_capture", return_value=archive([event()])) as capture:
            result = adapter.handle(CONFIG, {"action": "inspect_removal", "prior": PRIOR}, Path("/unused/actions.json"))
        self.assertEqual(result["status"], "exact_removal_observed")
        self.assertEqual(result["authority"], "none")
        command = capture.call_args.args[0]
        self.assertEqual(command[:4], ["/usr/bin/log", "show", "--style", "ndjson"])
        self.assertEqual(command[4:8], ["--start", "2026-09-04 23:59:00+0000", "--end", "2026-09-05 00:00:01+0000"])
        self.assertEqual(command[8], "--predicate")
        self.assertIn(f'gui/{os.getuid()}/com.example.ds4 [123]', command[9])
        for private in [CONFIG["label"], BOOT, PRIOR["machine"], PRIOR["instance"], "eventMessage", "processImagePath"]:
            self.assertNotIn(private, json.dumps(result))

    def test_native_capture_rechecks_absence_boot_and_profile_and_never_promotes_stale_evidence(self):
        for first, second, expected in [(BOOT, "other", "identity_changed_during_capture"), (None, None, "boot_unverified_or_changed")]:
            with patch.object(adapter.time, "time", return_value=NOW / 1000), patch.object(adapter, "machine_identity", return_value=PRIOR["machine"]), \
                    patch.object(adapter, "service_profile", return_value=PRIOR["service_profile"]), patch.object(adapter, "boot_identity", side_effect=[first, second]), \
                    patch.object(adapter, "launch_state", return_value={"registration": "absent"}), patch.object(adapter, "bounded_capture", return_value=archive([event()])):
                result = adapter.inspect_removal(CONFIG, PRIOR)
                self.assertEqual(result["status"], expected)
                self.assertEqual(result["observations"], [])
        for states in [[{"registration": "loaded"}], [{"registration": "absent"}, {"registration": "loaded"}]]:
            with patch.object(adapter.time, "time", return_value=NOW / 1000), patch.object(adapter, "machine_identity", return_value=PRIOR["machine"]), \
                    patch.object(adapter, "service_profile", return_value=PRIOR["service_profile"]), patch.object(adapter, "boot_identity", return_value=BOOT), \
                    patch.object(adapter, "launch_state", side_effect=states), patch.object(adapter, "bounded_capture", return_value=archive([event()])) as capture:
                result = adapter.inspect_removal(CONFIG, PRIOR)
                self.assertEqual(result["status"], "job_not_absent" if len(states) == 1 else "identity_changed_during_capture")
                self.assertEqual(result["observations"], [])
                self.assertEqual(capture.call_count, len(states) - 1)

    def test_prior_identity_cannot_inject_queries_and_missing_boot_is_not_inferred(self):
        for change in [{"pid": "123 OR true"}, {"pid": True}, {"boot_uuid": None}, {"instance": "bad"}, {"observed_at": NOW + 1}, {"label": "invented"}, {"log": "/tmp/copied-log"}]:
            with patch.object(adapter.time, "time", return_value=NOW / 1000), patch.object(adapter, "bounded_capture") as capture:
                self.assertEqual(adapter.inspect_removal(CONFIG, {**PRIOR, **change})["status"], "prior_identity_unverified")
                capture.assert_not_called()
        with self.assertRaisesRegex(ValueError, "invalid_adapter_request"):
            adapter.handle(CONFIG, {"action": "inspect_removal", "prior": PRIOR, "command": "invented"}, Path("/unused"))

    def test_native_rows_require_exact_sender_identity_epoch_time_and_complete_footer(self):
        for changes in [{"processID": 2}, {"processID": True}, {"senderImagePath": "/tmp/fake"}, {"bootUUID": "other"},
                        {"subsystem": "gui/999/com.example.ds4 [123]"}, {"timestamp": "2026-09-04T23:00:00Z"}]:
            self.assertEqual(adapter.audit_native_removal(archive([event(**changes)]), CONFIG["label"], 123, BOOT, NOW - 60000, NOW)["status"], "no_exact_removal_record")
        good = archive([event()])
        for text in [good.rstrip(), good.replace('"count": 1', '"count": 2'), good.replace('"finished": 1', '"finished": true'), good + "{}\n", "{broken}\n", archive([event(timestamp="bad")])]:
            with self.assertRaises((ValueError, TypeError)):
                adapter.audit_native_removal(text, CONFIG["label"], 123, BOOT, NOW - 60000, NOW)
        result = adapter.audit_native_removal(archive([event(), event(eventMessage="removing job: caller = launchctl")]), CONFIG["label"], 123, BOOT, NOW - 60000, NOW)
        self.assertEqual(result["status"], "conflicting_callers")
        self.assertTrue(result["native_stop_caller_observed"])
        other = adapter.audit_native_removal(archive([event(eventMessage="removing job: caller = PRIVATE_CALLER")]), CONFIG["label"], 123, BOOT, NOW - 60000, NOW)
        self.assertEqual(other["observations"][0]["caller"], "other")
        self.assertNotIn("PRIVATE_CALLER", json.dumps(other))

    def test_real_capture_pipes_are_bounded_settled_and_private(self):
        self.assertEqual(adapter.bounded_capture([sys.executable, "-c", "print('fixture')"]), "fixture\n")
        for code, options, reason in [
            ("import time;time.sleep(10)", {"timeout": 0.02}, "capture_timeout"),
            ("print('x'*10000)", {"max_bytes": 100}, "capture_output_limit"),
            ("import sys;sys.stderr.write('x'*10000)", {"max_bytes": 100}, "capture_output_limit"),
            ("import sys;sys.stderr.write('PRIVATE_ERROR');sys.exit(1)", {}, "capture_unavailable"),
        ]:
            with self.assertRaisesRegex(ValueError, reason):
                adapter.bounded_capture([sys.executable, "-c", code], **options)


if __name__ == "__main__":
    unittest.main()
