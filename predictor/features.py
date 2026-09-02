"""One versioned preprocessing contract, used by training and prediction.

Only decision-time fields and strictly earlier completed history enter features.
No current request's usage, finish reason, bytes, elapsed time or output length.
"""
import bisect
import collections
import datetime as dt
import hashlib
import json
import math

SCHEMA = "dsg-service-decision-v1"
CATEGORICAL = ("server_id", "hardware_family", "accelerator_family", "affinity")
NUMERIC = ("ram_gib", "context_length", "selected_active", "selected_queued",
           "assigned_sessions", "fleet_active", "fleet_queued", "fleet_free",
           "fleet_size", "observed_session_requests", "prior_prompt_tokens",
           "prior_completion_tokens", "prior_service_s", "prior_cached_fraction",
           "seconds_since_prior_completion")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("Missing event timestamp")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Event timestamp must include timezone")
    return parsed.timestamp()


def validate_profiles(raw):
    if not isinstance(raw, dict) or raw.get("schema") != 1 or not isinstance(raw.get("workers"), dict):
        raise ValueError("Expected schema-1 worker inventory")
    timestamp(raw.get("observed_at"))
    for name, p in raw["workers"].items():
        if not isinstance(name, str) or not isinstance(p, dict):
            raise ValueError("Invalid inventory entry")
        for key in ("hardware_family", "accelerator_family"):
            if not isinstance(p.get(key), str) or not p[key] or len(p[key]) > 64:
                raise ValueError("Invalid hardware category")
        if not finite(p.get("ram_gib")) or p["ram_gib"] == 0:
            raise ValueError("ram_gib must be positive OS-reported RAM, not free RAM")
        if not p.get("matching_profiles") or any(not isinstance(x, str) or len(x) != 64 or any(c not in "0123456789abcdef" for c in x) for x in p["matching_profiles"]):
            raise ValueError("Inventory must be tied to observed collector profile fingerprints")
    return raw


def parse_snapshots(blobs):
    """Snapshot bytes are captured once by the CLI. Never train on a moving file.

    Identical replay is deduplicated. Conflicting IDs or malformed complete lines
    fail closed. Only an unterminated final line is skipped and reported.
    """
    events, seen, duplicates, tails = [], {}, 0, 0
    for blob in blobs:
        lines = blob.splitlines(keepends=True)
        for i, line in enumerate(lines):
            if i == len(lines) - 1 and not line.endswith(b"\n"):
                tails += 1
                continue
            if not line.strip():
                continue
            event = json.loads(line)
            if event.get("schema") != 1 or not all(isinstance(event.get(k), str) and event[k] for k in ("run_id", "event_id", "request_id", "kind")):
                raise ValueError("Unsupported or malformed evidence record")
            timestamp(event.get("time"))
            key = event["event_id"]
            canonical = json.dumps(event, sort_keys=True)
            if key in seen:
                if seen[key] != canonical:
                    raise ValueError("Conflicting duplicate event ID")
                duplicates += 1
                continue
            seen[key] = canonical
            events.append(event)
    return events, {"events": len(events), "duplicate_events": duplicates, "partial_trailing_lines": tails}


def build_rows(events, profiles):
    validate_profiles(profiles)
    groups = collections.defaultdict(dict)
    excluded = collections.Counter()
    for event in events:
        key = (event["run_id"], event["request_id"])
        if event["kind"] in groups[key]:
            raise ValueError("Multiple events of same kind for one request")
        groups[key][event["kind"]] = event
    # Availability is finish time, NOT the request's earlier admission time.
    history = collections.defaultdict(list)
    for group in groups.values():
        d, f = group.get("decision"), group.get("finish")
        dispatch = group.get("dispatch")
        if d and f and dispatch and d.get("session") and f.get("outcome") == "complete" and finite(f.get("service_ms")) and timestamp(d["time"]) <= timestamp(dispatch["time"]) <= timestamp(f["time"]):
            history[d["session"]].append((timestamp(f["time"]), f))
    for h in history.values():
        h.sort(key=lambda x: x[0])
    decisions = sorted((g for g in groups.values() if "decision" in g), key=lambda g: (timestamp(g["decision"]["time"]), g["decision"]["event_id"]))
    counts, rows = collections.Counter(), []
    for group in decisions:
        d, f, dispatch = group["decision"], group.get("finish"), group.get("dispatch")
        session = d.get("session")
        n_prior = counts[session] if session else None
        if session:
            counts[session] += 1
        if not f or not dispatch:
            terminal = next((k for k in ("queued_cancel", "queue_timeout", "unavailable_before_dispatch") if k in group), "incomplete_lifecycle")
            excluded[terminal] += 1
            continue
        if any(group.get(k) for k in ("queued_cancel", "queue_timeout", "unavailable_before_dispatch")):
            raise ValueError("Conflicting lifecycle terminal events")
        if f.get("outcome") != "complete":
            excluded["failed_or_cancelled"] += 1
            continue
        if f.get("finish_reason") not in ("stop", "tool_calls", "function_call"):
            excluded["censored_or_unknown_finish"] += 1
            continue
        if d.get("traffic_class") == "genie":
            excluded["observer_traffic"] += 1
            continue
        if not finite(f.get("service_ms")) or f["service_ms"] <= 0:
            excluded["invalid_target"] += 1
            continue
        if not d.get("candidates") or d.get("candidates_truncated"):
            excluded["missing_or_truncated_candidates"] += 1
            continue
        if not timestamp(d["time"]) <= timestamp(dispatch["time"]) <= timestamp(f["time"]):
            excluded["clock_or_lifecycle_order"] += 1
            continue
        if f.get("node") != d.get("node") or dispatch.get("node") != d.get("node"):
            raise ValueError("Worker identity changed inside a request")
        candidates = d["candidates"]
        chosen = [w for w in candidates if w.get("node") == d.get("node")]
        if len(chosen) != 1:
            raise ValueError("Chosen worker missing or duplicated")
        chosen = chosen[0]
        profile = profiles["workers"].get(d["node"])
        if profile and chosen.get("profile") not in profile["matching_profiles"]:
            # Never silently attach today's hardware record to a different endpoint/profile.
            excluded["inventory_profile_mismatch"] += 1
            continue
        at = timestamp(d["time"])
        h = history.get(session, []) if session else []
        pos = bisect.bisect_left([x[0] for x in h], at)
        prior_at, prior = h[pos - 1] if pos else (None, {})
        usage = prior.get("usage") or {}
        feature = {"server_id": d["node"], "hardware_family": profile["hardware_family"] if profile else None,
                   "accelerator_family": profile["accelerator_family"] if profile else None,
                   "affinity": d.get("affinity"), "ram_gib": profile["ram_gib"] if profile else None,
                   "context_length": chosen.get("context_length"), "selected_active": chosen.get("active"),
                   "selected_queued": chosen.get("queued"), "assigned_sessions": chosen.get("assigned_sessions"),
                   "fleet_active": sum(w["active"] for w in candidates) if all(finite(w.get("active")) for w in candidates) else None,
                   "fleet_queued": sum(w["queued"] for w in candidates) if all(finite(w.get("queued")) for w in candidates) else None,
                   "fleet_free": sum(w.get("healthy") is True and w.get("paused") is False and w.get("active") == 0 and w.get("queued") == 0 for w in candidates),
                   "fleet_size": len(candidates), "observed_session_requests": n_prior,
                   "prior_prompt_tokens": usage.get("prompt_tokens"), "prior_completion_tokens": usage.get("completion_tokens"),
                   "prior_service_s": prior.get("service_ms", 0) / 1000 if prior else None,
                   "prior_cached_fraction": usage["cached_tokens"] / usage["prompt_tokens"] if finite(usage.get("cached_tokens")) and finite(usage.get("prompt_tokens")) and usage["prompt_tokens"] > 0 else None,
                   "seconds_since_prior_completion": at - prior_at if prior_at is not None else None}
        rows.append({"request_id": d["request_id"], "run_id": d["run_id"], "group": session or "__unknown_session__",
                     "decision_time": at, "finish_time": timestamp(f["time"]), "features": feature,
                     "target_service_s": f["service_ms"] / 1000})
    excluded["orphan_without_decision"] = sum("decision" not in g for g in groups.values())
    return rows, dict(excluded)


def chronological_split(rows):
    """Latest decision block; purge its sessions AND labels not yet available.

    No random row split, no tuning on this holdout, no fallback to leaked rows.
    """
    n = len(rows)
    for index in range(max(2, int(n * .8)), n):
        cutoff = rows[index]["decision_time"]
        test = [r for r in rows if r["decision_time"] >= cutoff]
        held_groups = {r["group"] for r in test}
        train = [r for r in rows if r["decision_time"] < cutoff and r["finish_time"] < cutoff and r["group"] not in held_groups]
        if len(train) >= 2 and test:
            return train, test, {"cutoff": cutoff, "purged": n - len(train) - len(test)}
    return [], [], {"reason": "No chronological session-disjoint holdout with at least two completed training rows"}


def fit_encoding(rows):
    # Vocabulary fits training rows only. Explicit unknown slot, never ordinal IDs.
    vocabulary = {k: sorted({r["features"][k] for r in rows if r["features"].get(k) is not None}) for k in CATEGORICAL}
    return {"schema": SCHEMA, "numeric": list(NUMERIC), "categorical": list(CATEGORICAL), "vocabulary": vocabulary,
            "feature_names": list(NUMERIC) + [f"{k}_{i}" for k in CATEGORICAL for i in range(len(vocabulary[k]) + 1)]}


def encode(features, encoding):
    import numpy as np
    if encoding.get("schema") != SCHEMA or encoding.get("numeric") != list(NUMERIC) or encoding.get("categorical") != list(CATEGORICAL):
        raise ValueError("Incompatible feature schema")
    if set(features) != set(NUMERIC + CATEGORICAL):
        raise ValueError("Feature keys must exactly match the versioned contract")
    if any(features[k] is not None and not finite(features[k]) for k in NUMERIC):
        raise ValueError("Numeric features must be non-negative finite numbers or null")
    if any(features[k] is not None and (not isinstance(features[k], str) or not features[k]) for k in CATEGORICAL):
        raise ValueError("Categorical features must be strings or null")
    values = [float(features[k]) if finite(features[k]) else float("nan") for k in NUMERIC]
    unknown = []
    for key in CATEGORICAL:
        vocabulary = encoding["vocabulary"][key]
        value = features.get(key)
        index = vocabulary.index(value) if value in vocabulary else len(vocabulary)
        if index == len(vocabulary):
            unknown.append(key)
        values.extend(float(i == index) for i in range(len(vocabulary) + 1))
    if len(values) != len(encoding["feature_names"]):
        raise ValueError("Encoding width mismatch")
    return np.asarray(values, dtype=np.float32), unknown
