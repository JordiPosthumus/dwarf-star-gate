import copy
import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
import numpy as np

from features import (SCHEMA, build_rows, chronological_split, encode, fit_encoding,
                      parse_snapshots, validate_profiles)
from train import train
from predict import estimate, load_bundle

FINGERPRINT = "a" * 64


def stamp(seconds):
    return dt.datetime.fromtimestamp(1700000000 + seconds, dt.timezone.utc).isoformat()


def inventory():
    return {"schema": 1, "observed_at": stamp(9999), "workers": {
        name: {"hardware_family": "spark_gb10", "accelerator_family": "nvidia_gb10", "ram_gib": 120,
               "matching_profiles": [FINGERPRINT]} for name in ("box-a", "box-b")}}


def request(i, when, duration=2, session=None, node="box-a"):
    base = {"schema": 1, "run_id": "run-1", "request_id": f"request-{i}", "node": node}
    candidate = {"node": node, "healthy": True, "paused": False, "active": 0, "queued": 0,
                 "assigned_sessions": i, "context_length": 262144, "profile": FINGERPRINT}
    return [{**base, "event_id": f"d-{i}", "time": stamp(when), "kind": "decision", "session": session or f"session-{i}",
             "affinity": "new", "traffic_class": "unclassified", "candidates": [candidate], "candidates_truncated": False},
            {**base, "event_id": f"s-{i}", "time": stamp(when + .1), "kind": "dispatch", "queue_ms": 100},
            {**base, "event_id": f"f-{i}", "time": stamp(when + duration + .1), "kind": "finish", "service_ms": duration * 1000,
             "outcome": "complete", "finish_reason": "stop", "usage": {"prompt_tokens": 1000, "completion_tokens": 10, "cached_tokens": 800}}]


class EvidenceTests(unittest.TestCase):
    def test_repeated_shadow_predictions_are_not_training_labels(self):
        events = request(1, 0)
        expected, _ = build_rows(events, inventory())
        for i in range(3):
            events.append({**events[0], "event_id": f"shadow-{i}", "kind": "routing_shadow",
                           "verdict": "would_move", "saving_ms": 999999})
        rows, excluded = build_rows(events, inventory())
        self.assertEqual(rows, expected)
        self.assertEqual(excluded["orphan_without_decision"], 0)

    def test_duplicate_and_partial_tail(self):
        blob = b"".join((json.dumps(e) + "\n").encode() for e in request(1, 0))
        rows, report = parse_snapshots([blob, blob + b'{"unfinished":'])
        self.assertEqual(len(rows), 3)
        self.assertEqual(report["duplicate_events"], 3)
        self.assertEqual(report["partial_trailing_lines"], 1)

    def test_conflicting_events_and_bad_complete_lines_rejected(self):
        a = request(1, 0)[0]
        b = {**a, "node": "changed"}
        with self.assertRaises(ValueError):
            parse_snapshots([(json.dumps(a) + "\n" + json.dumps(b) + "\n").encode()])
        with self.assertRaises(ValueError):
            parse_snapshots([b"not-json\n"])

    def test_censored_failed_missing_and_observer_excluded(self):
        events = []
        for i, reason in enumerate(("length", None, "content_filter")):
            records = request(i, i * 10)
            records[-1]["finish_reason"] = reason
            events.extend(records)
        records = request(4, 40)
        records[-1]["outcome"] = "client_cancelled"
        events.extend(records)
        events.extend(request(5, 50)[:2])
        records = request(6, 60)
        records[0]["traffic_class"] = "genie"
        events.extend(records)
        rows, excluded = build_rows(events, inventory())
        self.assertFalse(rows)
        self.assertEqual(excluded["censored_or_unknown_finish"], 3)
        self.assertEqual(excluded["failed_or_cancelled"], 1)
        self.assertEqual(excluded["incomplete_lifecycle"], 1)
        self.assertEqual(excluded["observer_traffic"], 1)

    def test_target_and_current_usage_are_not_features(self):
        events = request(1, 0)
        before, _ = build_rows(events, inventory())
        events[-1]["usage"] = {"prompt_tokens": 9999999, "completion_tokens": 99999}
        events[-1]["service_ms"] = 3000
        after, _ = build_rows(events, inventory())
        self.assertEqual(before[0]["features"], after[0]["features"])
        self.assertNotEqual(before[0]["target_service_s"], after[0]["target_service_s"])

    def test_observation_limit_is_excluded_without_becoming_engine_failure_or_history(self):
        unknown = request(1, 0, session="same")
        unknown[-1]["outcome"] = "sse_observation_limited"
        rows, excluded = build_rows(unknown + request(2, 10, session="same"), inventory())
        self.assertEqual(len(rows), 1)
        self.assertEqual(excluded["observation_limited"], 1)
        self.assertNotIn("failed_or_cancelled", excluded)
        self.assertIsNone(rows[0]["features"]["prior_service_s"])

    def test_history_only_becomes_available_after_finish(self):
        events = request(1, 0, duration=20, session="same") + request(2, 5, session="same") + request(3, 30, session="same")
        rows, _ = build_rows(events, inventory())
        self.assertIsNone(rows[1]["features"]["prior_service_s"])
        self.assertEqual(rows[2]["features"]["prior_service_s"], 20)
        self.assertEqual(rows[2]["features"]["observed_session_requests"], 2)

    def test_same_request_id_different_process_runs_do_not_join(self):
        events = request(1, 0)
        other = request(2, 10)
        for e in other:
            e["request_id"] = "request-1"
            e["run_id"] = "run-2"
        rows, _ = build_rows(events + other, inventory())
        self.assertEqual(len(rows), 2)

    def test_inventory_mismatch_is_not_silently_relabelled(self):
        events = request(1, 0)
        events[0]["candidates"][0]["profile"] = "b" * 64
        rows, report = build_rows(events, inventory())
        self.assertFalse(rows)
        self.assertEqual(report["inventory_profile_mismatch"], 1)
        bad = inventory()
        bad["workers"]["box-a"]["ram_gib"] = "128"
        with self.assertRaises(ValueError):
            validate_profiles(bad)

    def test_time_split_purges_sessions_and_unfinished_training_labels(self):
        events = sum((request(i, i * 10, duration=100 if i == 1 else 2, session="shared" if i in (0, 4) else f"s-{i}") for i in range(6)), [])
        rows, _ = build_rows(events, inventory())
        tr, te, report = chronological_split(rows)
        self.assertTrue(te)
        self.assertFalse({r["group"] for r in tr} & {r["group"] for r in te})
        self.assertTrue(all(r["finish_time"] < report["cutoff"] for r in tr))
        same, _ = build_rows(request(1, 0, session="same") + request(2, 10, session="same") + request(3, 20, session="same"), inventory())
        self.assertEqual(chronological_split(same)[0], [])

    def test_shared_hardware_separate_identity_and_unseen_server(self):
        rows, _ = build_rows(request(1, 0) + request(2, 10, node="box-b"), inventory())
        encoding = fit_encoding(rows)
        self.assertEqual(encoding["vocabulary"]["hardware_family"], ["spark_gb10"])
        self.assertEqual(encoding["vocabulary"]["server_id"], ["box-a", "box-b"])
        sample = copy.deepcopy(rows[0]["features"])
        sample["server_id"] = "new-box"
        _, unknown = encode(sample, encoding)
        self.assertIn("server_id", unknown)
        self.assertNotIn("hardware_family", unknown)
        sample["ram_gib"] = None
        encoded, _ = encode(sample, encoding)
        self.assertTrue(np.isnan(encoded[0]))
        sample["ram_gib"] = "128"
        with self.assertRaises(ValueError):
            encode(sample, encoding)


class BundleTests(unittest.TestCase):
    def test_training_reload_predictions_unknowns_and_tamper(self):
        with tempfile.TemporaryDirectory(prefix="dsg-xgb-test-") as tmp:
            root = Path(tmp)
            data = root / "data"
            data.mkdir()
            events = sum((request(i, i * 10, duration=i + 1, node="box-a" if i % 2 else "box-b") for i in range(8)), [])
            (data / "routing-2026-01-01.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))
            profile = root / "profiles.json"
            profile.write_text(json.dumps(inventory()))
            output = root / "candidate"
            report = train(data, profile, output)
            self.assertTrue(report["save_reload_exact"])
            self.assertFalse(report["routing_enabled"])
            self.assertFalse(report["evidence_sufficient"])
            self.assertTrue(report["evaluation"]["available"])
            manifest = json.loads((output / "manifest.json").read_text())
            self.assertIn("uv.lock", manifest["implementation_sha256"])
            replay = root / "replayed-candidate"
            replay_report = train(output / "snapshots", output / "snapshots" / "worker-inventory.json", replay)
            self.assertEqual(report, replay_report)
            self.assertEqual((output / "model.ubj").read_bytes(), (replay / "model.ubj").read_bytes())
            rows, _ = build_rows(events, inventory())
            sample = {"schema": SCHEMA, "features": rows[0]["features"]}
            prediction = estimate(output, sample)
            self.assertGreaterEqual(prediction["estimated_service_seconds"], 0)
            sample["features"]["hardware_family"] = "new-family"
            sample["features"]["ram_gib"] = 512
            prediction = estimate(output, sample)
            self.assertIn("hardware_family", prediction["unknown_categories"])
            self.assertIn("ram_gib", prediction["outside_training_range"])
            with self.assertRaises(ValueError):
                train(data, profile, output)
            (output / "features.json").write_text("{}")
            with self.assertRaisesRegex(ValueError, "checksum"):
                load_bundle(output)

    def test_incomplete_data_never_creates_a_candidate(self):
        with tempfile.TemporaryDirectory(prefix="dsg-xgb-empty-test-") as tmp:
            root = Path(tmp)
            (root / "routing-2026-01-01.jsonl").write_text("".join(json.dumps(e) + "\n" for e in request(1, 0)[:2]))
            profile = root / "profiles.json"
            profile.write_text(json.dumps(inventory()))
            output = root / "candidate"
            with self.assertRaisesRegex(ValueError, "at least two"):
                train(root, profile, output)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
