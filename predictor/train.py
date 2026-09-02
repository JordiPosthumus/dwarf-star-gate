"""Offline-only experiment. No gateway imports, mutation API or activation path."""
import argparse
import collections
import datetime as dt
import json
import os
from pathlib import Path
import platform
import tempfile

import numpy as np
import xgboost as xgb
from features import (SCHEMA, NUMERIC, build_rows, chronological_split, digest,
                      encode, fit_encoding, parse_snapshots, validate_profiles)

PARAMS = {"objective": "reg:squarederror", "tree_method": "hist", "device": "cpu",
          "nthread": 2, "max_depth": 2, "eta": .05, "min_child_weight": 1,
          "lambda": 10, "subsample": 1, "colsample_bytree": 1, "seed": 42}
ROUNDS = 32
MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024


def write_json(file, value):
    with open(file, "x", encoding="utf8") as f:
        json.dump(value, f, indent=2, allow_nan=False)
        f.write("\n")


def matrix(rows, encoding):
    return np.vstack([encode(row["features"], encoding)[0] for row in rows])


def fit(rows):
    encoding = fit_encoding(rows)
    data = xgb.DMatrix(matrix(rows, encoding), label=np.log1p([r["target_service_s"] for r in rows]), feature_names=encoding["feature_names"])
    model = xgb.train(PARAMS, data, num_boost_round=ROUNDS)
    return model, encoding


def predict(model, encoding, rows):
    values = np.expm1(model.predict(xgb.DMatrix(matrix(rows, encoding), feature_names=encoding["feature_names"])))
    if not np.all(np.isfinite(values)):
        raise ValueError("Non-finite prediction")
    return np.maximum(values, 0)


def mae(actual, predicted):
    return float(np.mean(np.abs(np.asarray(actual) - np.asarray(predicted))))


def train(data_directory, inventory_file, output):
    os.umask(0o077)
    output = Path(output).resolve()
    if output.exists():
        raise ValueError("Output already exists; every candidate is immutable")
    sources = sorted(Path(data_directory).glob("routing-????-??-??.jsonl"))
    if not sources:
        raise ValueError("No collector files")
    # Read up to each file's initial size; concurrent appends belong to the next run.
    blobs, captured_bytes = [], 0
    for source in sources:
        with source.open("rb") as f:
            size = os.fstat(f.fileno()).st_size
            captured_bytes += size
            if captured_bytes > MAX_SNAPSHOT_BYTES:
                raise ValueError("Offline snapshot exceeds 256 MiB budget; select an explicit smaller data window")
            blobs.append(f.read(size))
    profile_bytes = Path(inventory_file).read_bytes()
    profiles = validate_profiles(json.loads(profile_bytes))
    events, ingestion = parse_snapshots(blobs)
    rows, excluded = build_rows(events, profiles)
    if len(rows) < 2:
        raise ValueError("Need at least two uncensored completed requests; no synthetic padding")
    # This is an experiment artifact even if evaluation passes. Never a live model.
    report = {"status": "experimental_not_validated", "routing_enabled": False,
              "target": "log1p(service_seconds), reported back in seconds; queue wait excluded",
              "feature_schema": SCHEMA, "ingestion": ingestion, "excluded": excluded,
              "usable_rows": len(rows), "session_groups": len({r["group"] for r in rows}),
              "worker_rows": dict(collections.Counter(r["features"]["server_id"] for r in rows)),
              "inventory_workers_without_labels": sorted(set(profiles["workers"]) - {r["features"]["server_id"] for r in rows}),
              "hardware_rows": dict(collections.Counter(r["features"]["hardware_family"] or "unknown" for r in rows)),
              "current_request_prompt_length_available": False, "embeddings": False,
              "hardware_enrichment": "Static inventory supplied after collection, bound to matching endpoint/profile fingerprints; not historical engine attestation",
              "parameters": PARAMS, "boosting_rounds": ROUNDS,
              "versions": {"python": platform.python_version(), "numpy": np.__version__, "xgboost": xgb.__version__},
              "warnings": ["Small convenience sample is not routing validation", "Only chosen servers have observed outcomes",
                           "Existing collector lacks decision-time input tokens, compaction, actual cache residency and engine epochs",
                           "Per-server name is not an ordinal number; hardware class supports sharing but does not guarantee transfer",
                           "Unknown hardware and RAM outside training range are unsupported for performance claims",
                           "The fixed routing fallback remains unchanged; this artifact is not a production fallback"]}
    tr, te, split = chronological_split(rows)
    evaluation = {"available": bool(te), "split": split, "train_rows": len(tr), "test_rows": len(te)}
    eval_model = None
    if te:
        eval_model, eval_encoding = fit(tr)
        predictions = predict(eval_model, eval_encoding, te)
        baseline = float(np.median([r["target_service_s"] for r in tr]))
        evaluation.update({"method": "chronological latest block, session-disjoint, train labels available before cutoff",
                           "train_groups": sorted({r["group"] for r in tr}), "test_groups": sorted({r["group"] for r in te}),
                           "mae_seconds": mae([r["target_service_s"] for r in te], predictions),
                           "baseline_median_seconds": baseline, "baseline_mae_seconds": mae([r["target_service_s"] for r in te], baseline),
                           "holdout_predictions": [{"request_id": row["request_id"], "observed_seconds": row["target_service_s"],
                                                     "predicted_seconds": float(p), "unknown_categories": encode(row["features"], eval_encoding)[1]}
                                                    for row, p in zip(te, predictions)]})
    report["evaluation"] = evaluation
    # Diagnostic evidence criteria, not a promotion API. No parameter search on holdout.
    report["evidence_sufficient"] = len(rows) >= 100 and len({r["group"] for r in rows}) >= 20 and len(te) >= 20
    model, encoding = fit(rows)
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".dsg-candidate-", dir=output.parent))
    snapshots = staging / "snapshots"
    snapshots.mkdir(mode=0o700)
    for source, blob in zip(sources, blobs):
        (snapshots / source.name).write_bytes(blob)
    (snapshots / "worker-inventory.json").write_bytes(profile_bytes)
    write_json(staging / "features.json", encoding)
    with (staging / "rows.jsonl").open("x") as f:
        for row in rows:
            f.write(json.dumps(row, allow_nan=False) + "\n")
    model.save_model(staging / "model.ubj")
    reloaded = xgb.Booster({"nthread": 2})
    reloaded.load_model(staging / "model.ubj")
    np.testing.assert_allclose(predict(model, encoding, rows), predict(reloaded, encoding, rows), rtol=0, atol=0)
    report["save_reload_exact"] = True
    report["candidate_refit_on_all_usable_rows"] = True
    report["baseline"] = {"global_median_seconds": float(np.median([r["target_service_s"] for r in rows]))}
    report["numeric_training_ranges"] = {key: {"min": min(values), "max": max(values)} for key in NUMERIC
                                         if (values := [r["features"][key] for r in rows if r["features"].get(key) is not None])}
    if eval_model is not None:
        eval_model.save_model(staging / "evaluation-model.ubj")
        write_json(staging / "evaluation-features.json", eval_encoding)
    write_json(staging / "report.json", report)
    payloads = sorted(p for p in staging.rglob("*") if p.is_file())
    manifest = {"bundle_schema": 1, "feature_schema": SCHEMA, "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "routing_enabled": False,
                "implementation_sha256": {name: digest((Path(__file__).parent / name).read_bytes())
                                          for name in ("train.py", "features.py", "predict.py", "pyproject.toml", "uv.lock")},
                "files": {str(p.relative_to(staging)): digest(p.read_bytes()) for p in payloads}}
    write_json(staging / "manifest.json", manifest)
    os.rename(staging, output)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, help="Private directory of schema-1 routing JSONL files")
    parser.add_argument("--profiles", required=True, help="Private fingerprint-bound worker inventory JSON")
    parser.add_argument("--output", required=True, help="New private candidate directory; never overwritten")
    args = parser.parse_args()
    report = train(args.data, args.profiles, args.output)
    print(json.dumps({"output": str(Path(args.output).resolve()), "status": report["status"], "usable_rows": report["usable_rows"],
                      "worker_rows": report["worker_rows"], "evaluation": report["evaluation"], "save_reload_exact": report["save_reload_exact"],
                      "routing_enabled": False}, indent=2))


if __name__ == "__main__":
    main()
