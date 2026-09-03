"""Explicit, pinned public-model download. Never called by the live collector."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import urllib.request

MODEL = "sentence-transformers/all-MiniLM-L6-v2"
REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
FILES = {
    "model.onnx": ("onnx/model.onnx", 90405214, "6fd5d72fe4589f189f8ebc006442dbb529bb7ce38f8082112682524616046452"),
    "tokenizer.json": ("tokenizer.json", 466247, "cb202bfe2e3c98645018a6d12f182a434c9d3e02"),
}


def prepare(destination):
    os.umask(0o077)
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError("Bundle already exists; do not replace a running encoder")
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".encoder-", dir=destination.parent))
    manifest = {"schema": 1, "model": MODEL, "revision": REVISION, "dimensions": 384,
                "max_tokens": 256, "pooling": "attention_mask_mean_l2", "files": {}}
    for name, (remote, size, expected) in FILES.items():
        with urllib.request.urlopen(f"https://huggingface.co/{MODEL}/resolve/{REVISION}/{remote}", timeout=60) as response:
            blob = response.read(size + 1)
        if len(blob) != size:
            raise ValueError("Unexpected model-file length")
        actual = hashlib.sha256(blob).hexdigest() if name.endswith("onnx") else hashlib.sha1(f"blob {len(blob)}\0".encode() + blob).hexdigest()
        if actual != expected:
            raise ValueError("Pinned upstream file hash mismatch")
        (staging / name).write_bytes(blob)
        manifest["files"][name] = hashlib.sha256(blob).hexdigest()
    (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    staging.rename(destination)
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination")
    print(json.dumps(prepare(parser.parse_args().destination)))
