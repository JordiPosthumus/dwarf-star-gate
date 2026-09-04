# Early client metadata

Implemented as **versioned V3 predictor evidence**. An opt-in client can send admission hints
before its body is uploaded or a queued request is dispatched. Existing clients
need no changes. DSG does not buffer/rewrite prompts for these hints, infer hidden
thinking, or alter model/context/output settings.

One optional HTTP header, `X-DSG-Client-Metadata`, contains up to 512 bytes of JSON:

```json
{"schema":1,"prompt_tokens_estimate":48000,"turn_index":12,"compaction_count":1,"reasoning_effort":"xhigh"}
```

- `prompt_tokens_estimate`: estimate of the **current full input**, including known
  tools/formatting. Not previous response usage, capacity or an exact engine count.
- `turn_index`: zero-based model-call index in this client session, not just user
  messages. Retries of the same call keep the same index.
- `compaction_count`: completed compactions in this session. Only supply when
  actually known; never guess from shorter input.
- `reasoning_effort`: `none`, `minimal`, `low`, `medium`, `high` or `xhigh`, when
  the requested value is known. It is **not** forwarded as a DS4 setting.

Fields may be omitted/null; zero differs from missing. Nonnegative integers only:
estimates up to 16,777,216 and counters up to 1,000,000. These are metadata parser
bounds, **not inference limits**. Unknown keys/types/schemas and malformed or
overlong headers become invalid metadata, not failed inference requests. Never
send text, paths, keys or user identifiers.

The decision event records schema/status (`ready`, `missing`, `invalid`),
`source: client_header` and allowlisted values. Its timestamp and normal
request/session/worker IDs establish when hints existed. Raw headers and parse
errors are never saved. The reserved header is stripped before DS4; original
body bytes and actual reasoning/output fields stay unchanged. Hints cannot change
auth, compatibility, context guarantees or permissions. Clients can lie; header
and later body/usage evidence must remain separate.

## What remains

No client adapter is automatically installed and no Pi config is edited. Clients
without the header produce `missing`, not invented counters. Next add a reviewed
per-request harness hook using actual client state; test retries, subagents and
compactions. Do not put changing per-request hints in static provider headers.

The v2 feature builder stays byte-for-byte unchanged so existing model artifacts
and evidence remain compatible. V3 exposes these fields to XGB as a separately
cross-validated client block; missing hints remain explicit missing values. A V3
candidate still needs the fixed holdout and fresh-traffic gates before routing may
use it. Preserve the old contract/model during rollout; do not invalidate active
models merely by editing their feature builder. Early embeddings are not part of
this header.
