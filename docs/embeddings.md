# Optional local embedding and progress collection

**Implemented; off by default. Collection is independent of routing.** The optional
[v2 predictor](predictor-lifecycle.md) can use embeddings in timestamped updated
forecasts, never retroactively in initial placement. Feature selection may reject
them; collection alone does not prove predictive value.
The gateway can send bounded visible-text slices to one private CPU encoder
process. It never waits for an embedding before forwarding inference. Failed or
overloaded encoding loses an observation, not a model request. No DS4 worker,
model/context/output/thinking/concurrency setting is changed.

## Exact encoder and extraction contract

Credit to [Sentence Transformers' all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2).
The pinned revision is `1110a243fdf4706b3f48f1d95db1a4f5529b4d41`.
DSG uses its ONNX model and tokenizer, 384 dimensions, attention-mask mean pooling,
L2 normalization and CPU execution with one inference thread. Dependencies are
locked separately in `ds4-gateway/encoder/uv.lock`; no Python import is required
by the ordinary gateway when this feature is off.

Extraction `visible-head-tail-v1` produces at most two separately labelled vectors:

1. `latest_user`: the latest visible user message in a bounded suffix of the request.
2. `recent_conversation`: up to eight preceding user/assistant-visible messages,
   with role labels, before that user message.

Inspect only the last 256 messages and at most the last 64 content blocks per
message. Each resulting text slice keeps at most its last 8,192 UTF-16 code units
in the JavaScript extractor. Tokenization then retains the first 128 and last 128
tokens when the slice exceeds 256 tokens (including special tokens). Token counts
and truncation flags are recorded. This is a small bounded workload representation,
**not a full-context embedding** and not a promise of predictive usefulness.

System/developer messages, tool messages, tool-call arguments, hidden reasoning
blocks and image payloads are excluded. Visible answers from earlier turns may
be included; the answer to the current request cannot be. Tool-heavy and visual
work therefore have explicit blind spots. Chat Completions, Messages and message-
based Responses are supported; bare Completions are not inspected because their
concatenated prompt has no reliable role boundary.

The existing 8 MiB request-observation budget remains unchanged. Encoded,
oversized, malformed or incomplete bodies have unavailable features. **The full
original inference request is still forwarded unchanged.** These are observation
bounds, not inference context or output limits.

## Install explicitly; no automatic downloads

From the repository root, with `uv` available:

```sh
uv sync --locked --project ds4-gateway/encoder
uv run --locked --project ds4-gateway/encoder python ds4-gateway/encoder/prepare.py \
  ./runtime/encoders/minilm-v1
npm run encoder:test
```

Preparation downloads only the pinned ONNX/tokenizer artifacts, verifies expected
upstream digests and sizes, and writes a checksummed private manifest. It refuses
to overwrite an existing destination. Inspect the model's upstream license and
documentation; weights are not vendored into this repository. Preparation needs
network access to the model host; **live encoding does not**.

In a backed-up private gateway config, enable `dataset_enabled` and add:

```json
{
  "embeddings": {
    "enabled": true,
    "python": "/ABSOLUTE/checkout/ds4-gateway/encoder/.venv/bin/python",
    "model_dir": "/ABSOLUTE/private/encoders/minilm-v1"
  }
}
```

Use actual absolute paths. Restart the gateway only in an approved maintenance
window, and restart the dashboard for its updated collection display. There is
no model-server restart or public embedding endpoint. To stop future embedding
collection, explicitly set `enabled:false` and restart; existing evidence is not
deleted. Preserve the old config/source release for rollback.

The encoder communicates over private child-process pipes, has a 16-job bound
(including the active job), and a 20-second startup/batch timeout. On failure it
drops pending encoding jobs and permits a new start after a one-minute cooldown.
It never substitutes another encoder or makes a cloud fallback call. Raw text is
transient in bounded process memory, not written to a disk queue or error log.
This is not a hardened OS sandbox against a compromised local executable.

## Data and UI

New schema-1 event kinds join by **gateway run + request ID + worker**:

- `request_features`: extraction/version/status, bounded character/message
  counts, requested thinking and `available_at`; prediction point `after_upload`.
- `embedding`: model/revision/dimensions, per-scope normalized vectors and encoder
  token/truncation metadata, queued/available times, encoding duration or failure.
- `progress`: at dispatch and every 30 seconds while active, elapsed milliseconds,
  observed stream phase, cumulative semantic UTF-16 character count, time since
  a semantic delta, requested thinking; prediction point `while_active`.

Progress requires only numerical collection, not embeddings. SSE heartbeats do
not count as semantic progress. `awaiting_content` is **not proof of prefill**;
non-streaming or unsupported events may leave progress unknown. Character counts
are not token counts. Failures, cancellations and incomplete tails stay visible;
they are not short successful completions. No remaining-time XGB is activated
by collecting these rows.

The Analytics collection line shows enabled/ready, observed/encoded, queued,
missing/failed/dropped, encoder identity and last latency. These are current-run
encoding counters, not a claim every vector was durably saved; inspect the
separate dataset write/drop/error counters too. The dashboard/diagnostic JSON
does not expose vectors. Existing Analytics and metadata-only training explicitly
ignore the new event streams instead of duplicating labels or counting false gaps.

Vectors are **sensitive derived conversation data**, not anonymization. Keep the
mode-0600 daily files and mode-0700 directory private, outside Git and public
screenshots. Existing 1 GiB storage/queue budgets and no-deletion retention stay
unchanged. Collection stops with a visible error at that storage budget; inference
continues. There is no historical backfill: old raw conversations were not kept.

## Availability and validation gates

DSG currently assigns a server before reading the body. An embedding produced
later is **not an initial-routing feature**. Future prediction code must use
only features available by its declared prediction time, in both training and
serving. Do not silently turn after-upload features into hindsight admission
forecasts. Do not treat embedding similarity as proof of compatible KV state.

The test suite covers extraction/privacy, bounded queues, invalid output,
timeouts and unchanged forwarding with an unavailable encoder. Optional local
integration tests use a prepared real bundle and fake inference workers:

```sh
DSG_TEST_ENCODER_PYTHON=/ABSOLUTE/encoder/.venv/bin/python \
DSG_TEST_ENCODER_BUNDLE=/ABSOLUTE/private/encoders/minilm-v1 \
node --test ds4-gateway/gateway.test.mjs
```

That test verifies real normalized vectors, request/run/worker joins, availability
timestamps, no persisted source text and byte-identical forwarded requests. CI
does not download model weights. Before live activation, measure local startup,
batch latency and memory overhead; after activation verify new private rows and
unchanged serving configuration. Fit/save/reload does not establish that adding
embeddings beats metadata-only prediction.
