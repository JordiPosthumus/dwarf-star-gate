"""No network, HTTP listener, raw-text log or disk queue. JSON over private pipes."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time

os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"


def pool(hidden, mask):
    import numpy as np
    values = (hidden * mask[..., None]).sum(axis=1) / np.maximum(mask.sum(axis=1, keepdims=True), 1)
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    if not np.isfinite(values).all() or (norms <= 0).any():
        raise ValueError("Invalid encoder output")
    return values / norms


class Encoder:
    def __init__(self, directory):
        import onnxruntime as ort
        ort.disable_telemetry_events()
        from tokenizers import Tokenizer
        from prepare import MODEL, REVISION
        directory = Path(directory)
        self.manifest = json.loads((directory / "manifest.json").read_text())
        if (self.manifest.get("schema"), self.manifest.get("model"), self.manifest.get("revision"), self.manifest.get("dimensions"), self.manifest.get("max_tokens"), self.manifest.get("pooling")) != (1, MODEL, REVISION, 384, 256, "attention_mask_mean_l2"):
            raise ValueError("Unsupported encoder contract")
        if set(self.manifest.get("files", {})) != {"model.onnx", "tokenizer.json"}:
            raise ValueError("Incomplete encoder bundle")
        for name, digest in self.manifest["files"].items():
            file = directory / name
            if file.is_symlink() or hashlib.sha256(file.read_bytes()).hexdigest() != digest:
                raise ValueError("Encoder checksum mismatch")
        self.tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
        self.tokenizer.no_truncation()
        self.tokenizer.no_padding()
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self.session = ort.InferenceSession(str(directory / "model.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
        self.inputs = {item.name for item in self.session.get_inputs()}

    def encode(self, texts):
        import numpy as np
        if not isinstance(texts, list) or not 1 <= len(texts) <= 2 or any(not isinstance(t, str) or not t or len(t) > 8192 for t in texts):
            raise ValueError("Invalid bounded input")
        encoded = self.tokenizer.encode_batch(texts)
        lengths = [len(x.ids) for x in encoded]
        # Retain both ends of the bounded slice, including model CLS/SEP.
        ids = [x.ids if len(x.ids) <= 256 else x.ids[:128] + x.ids[-128:] for x in encoded]
        width = max(map(len, ids))
        mask = np.array([[1] * len(row) + [0] * (width - len(row)) for row in ids], dtype=np.int64)
        batch = {"input_ids": np.array([row + [0] * (width - len(row)) for row in ids], dtype=np.int64),
                 "attention_mask": mask, "token_type_ids": np.zeros_like(mask)}
        hidden = self.session.run(None, {k: v for k, v in batch.items() if k in self.inputs})[0]
        vectors = pool(hidden, mask)
        if vectors.shape != (len(texts), 384):
            raise ValueError("Wrong encoder dimensions")
        return [{"vector": vector.tolist(), "input_tokens": size, "used_tokens": min(size, 256), "truncated": size > 256}
                for vector, size in zip(vectors, lengths)]


def emit(value):
    print(json.dumps(value, allow_nan=False, separators=(",", ":")), flush=True)


def main():
    os.umask(0o077)
    try:
        encoder = Encoder(sys.argv[1])
    except Exception:
        emit({"error": "encoder_initialization_failed"})
        return 1
    emit({"ready": True, "model": encoder.manifest["model"], "revision": encoder.manifest["revision"], "dimensions": 384})
    while True:
        raw = sys.stdin.buffer.readline(262145)
        if not raw:
            return 0
        if len(raw) > 262144 or not raw.endswith(b"\n"):
            return 1
        try:
            job = json.loads(raw)
            if not isinstance(job.get("id"), str) or len(job["id"]) > 64:
                raise ValueError("Invalid identity")
            started = time.monotonic()
            result = encoder.encode(job["texts"])
            emit({"id": job["id"], "results": result, "elapsed_ms": (time.monotonic() - started) * 1000})
        except Exception:
            # Exceptions can contain input data. Never echo them or traceback.
            emit({"error": "encoding_failed"})


if __name__ == "__main__":
    sys.exit(main())
