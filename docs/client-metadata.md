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

## Opt-in Pi metadata adapter

The [continuity extension](client-continuity.md#opt-in-pi-adapter-tested-with-pi-0844)
can now supply bounded client evidence with `DSG_CLIENT_METADATA=1`:

```sh
DSG_PI_PROVIDER=local-ds4 DSG_PI_BASE_URL=http://127.0.0.1:30000/v1 \
DSG_CLIENT_METADATA=1 pi -e /path/to/DSG/examples/pi-dsg-continuity.ts
```

Use your existing provider and the gateway/Door endpoint, not a direct DS4 worker.
The flag defaults off and is independent of `DSG_AGENT_WATCH`. No client adapter
is automatically installed, no Pi config/session file is edited, and existing
sessions do not acquire the feature merely because DSG is upgraded.

- Requested reasoning effort comes from the actual stream options, not inference
  about hidden thinking. It remains a hint, not a change to DS4 request settings.
- Compaction count comes from completed compaction entries in the same non-forked
  session journal, including earlier branches. It is not guessed from token use.
- The absolute call index is tracked only for a verified new, unseeded session:
  Pi's `new` session event (for example `/new`), or fresh in-memory SDK startup.
  Retries keep the same input index, including Pi's automatic retry after a failed
  assistant attempt. A new user/tool/successful-assistant input advances it.
- Resumed, reloaded, forked or ordinary file-backed startup histories do **not**
  reconstruct an index from assistant-message counts. Branch/model changes or
  foreign-provider history invalidate the observed index until a new session.
  Forked histories also leave compaction count unknown because entries may be
  inherited. Unknown is omitted, never silently reset to zero.
- Current full-input token count remains unknown: neither previous usage nor
  `getContextUsage()` is substituted for a current serialized-input estimate.

Hints are snapshotted once per scoped stream call and held constant through its
transport retries. Exact provider, endpoint, route, immutable JSON body and client
session checks prevent attaching another subagent's state. Explicit caller-supplied
metadata takes precedence. No request body, model capability, authentication,
reasoning/output setting or unrelated provider is changed. Entry IDs are used only
locally to recognize the same input; the header contains no IDs or text.

The adapter reads entry types and terminal metadata through Pi's read-only session
API, not message content, summaries or session files. At more than 10,000 entries,
inconsistent/duplicate IDs, missing APIs or inaccessible state, counters remain
unknown; this bounds optional telemetry work, **not session length or inference**.
Unit tests cover fresh/resumed/forked histories, scope, content non-access and
unknown state. Installed-Pi tests exercise actual retries and SDK compaction with
a synthetic summary, verify admission-time collection and upstream header stripping,
and preserve the original provider capabilities and single tool execution.

Clients without the header still produce `missing`. Reliable resumed-session call
identity and a current full-input token estimator remain future work. Do not put
changing per-request hints in static provider headers or claim DSG can infer
counters it never received. Loading this extension does not backfill old data.

The v2 feature builder stays byte-for-byte unchanged so existing model artifacts
and evidence remain compatible. V3 exposes these fields to XGB as a separately
cross-validated client block; missing hints remain explicit missing values. A V3
candidate still needs the fixed holdout and fresh-traffic gates before routing may
use it. Preserve the old contract/model during rollout; do not invalidate active
models merely by editing their feature builder. Early embeddings are not part of
this header.
