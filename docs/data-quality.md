# Audit prediction evidence before tuning

Run locally, against your private runtime directory:

```sh
npm run data:audit -- --data runtime/training --profiles runtime/worker-profiles.local.json
```

This read-only command reports event joins, terminal coverage, missing usage,
worker representation, embedding availability/truncation and causal feature
coverage using the same replay as the trainer. It never changes routing or trains
a model. Keep its output private: worker identifiers and workload counts are
operational information even though it contains no text, vectors or session IDs.

Exact duplicate events are counted once; conflicting IDs fail the audit. Bad
complete JSON lines fail visibly. An incomplete final line is counted and ignored,
not repaired. Reads are bounded to 128 MiB/200,000 events/20,000 requests and fail
instead of silently sampling. A live snapshot can contain an unfinished write or
in-flight request; absent terminal evidence is not automatically a failed job.
The audit shares its event-kind allowlist with the collector so new bounded
receipts cannot silently appear as corrupt evidence. A valid pre-dispatch
relocation is reported separately from an unexplained worker-identity mismatch;
the moved request remains excluded from ordinary decision-node training labels.

## What matters

- **Causal coverage:** first calls have no previous-call history. Embeddings are
  available after upload, not at initial placement. A vector arriving after a
  response finishes cannot improve that response's prediction retroactively.
- **Independent examples:** many progress rows from a single long call are still
  one request. The trainer weights them accordingly. Count requests and sessions,
  not just rows, and inspect representation per device/hardware class.
- **Censoring:** cancelled, failed, output-limited and missing-finish responses
  are not unrestricted completion-time targets. Do not fill missing usage with zero.
- **Observation limits:** the request metadata parser has an 8 MiB capture
  budget. Larger bodies still pass through intact, but cannot currently produce
  embeddings through that parser. The encoder's own bounded token slices are
  separate; neither limit reduces model context or forwarded prompt/output size.
- **Traffic mix:** unclassified traffic may include tests. Do not silently guess
  that a short call is synthetic or that one machine's workload represents all
  others. The observer marker is client-declared, not authenticated provenance.
- **No historical invention:** older records have no response-format provenance.
  Missing usage cannot conclusively be blamed on JSON versus SSE in those records.
  Raw conversation text was not retained, so missing old embeddings cannot be rebuilt.

New finish records identify response format, route, HTTP status, observed usage
status and captured stream/include-usage flags. Bounded non-streaming OpenAI JSON
usage observation closes one known gap. Unsupported formats remain unknown.
See the [collector contract](collector-schema.md) for precise semantics.

## Training discipline

Prefer one motivated reviewed recipe over repeatedly searching the same holdout.
Tree count is selected by three forward-time CV folds, followed by a separate
holdout and fresh-traffic release gate. An offline improvement smaller than the
fixed required gain is not a qualified model. Failed candidates remain reports;
they do not replace the baseline. See [predictor lifecycle](predictor-lifecycle.md).
More representative long-context traffic and earlier client metadata are useful
next steps; weakening validation to manufacture a win is not.
