"""Load a checksummed private experiment and predict, without touching DSG."""
import argparse
import json
from pathlib import Path
import numpy as np
import xgboost as xgb
from features import SCHEMA, digest, encode


def load_bundle(directory):
    directory = Path(directory)
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("bundle_schema") != 1 or manifest.get("feature_schema") != SCHEMA or manifest.get("routing_enabled") is not False:
        raise ValueError("Unsupported experiment bundle")
    required = {"model.ubj", "features.json", "report.json"}
    if not required <= set(manifest.get("files", {})):
        raise ValueError("Missing checksummed artifact")
    for filename, expected in manifest["files"].items():
        p = Path(filename)
        if p.is_absolute() or ".." in p.parts or (directory / p).is_symlink():
            raise ValueError("Invalid bundle path")
        if digest((directory / p).read_bytes()) != expected:
            raise ValueError("Artifact checksum mismatch")
    encoding = json.loads((directory / "features.json").read_text())
    report = json.loads((directory / "report.json").read_text())
    model = xgb.Booster({"nthread": 2})
    model.load_model(directory / "model.ubj")
    if model.feature_names != encoding["feature_names"]:
        raise ValueError("Model/preprocessor feature order mismatch")
    return model, encoding, report


def estimate(directory, sample):
    if sample.get("schema") != SCHEMA:
        raise ValueError("Prediction input needs the exact feature schema")
    model, encoding, report = load_bundle(directory)
    features = sample["features"]
    values, unknown = encode(features, encoding)
    prediction = float(np.expm1(model.predict(xgb.DMatrix(values[None, :], feature_names=encoding["feature_names"]))[0]))
    if not np.isfinite(prediction):
        raise ValueError("Non-finite prediction")
    outside = [k for k, limits in report["numeric_training_ranges"].items() if features.get(k) is not None and not limits["min"] <= features[k] <= limits["max"]]
    return {"estimated_service_seconds": max(0, prediction), "baseline_seconds": report["baseline"]["global_median_seconds"],
            "unknown_categories": unknown, "outside_training_range": outside,
            "routing_enabled": False, "status": "experimental_not_validated"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--input", required=True, help="Private JSON containing schema and exact feature map")
    args = parser.parse_args()
    print(json.dumps(estimate(args.bundle, json.loads(Path(args.input).read_text())), indent=2))
