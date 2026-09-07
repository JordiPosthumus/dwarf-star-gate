# Optional upstream observability opportunities

Research note, refreshed 2026-09-05. No DS4 patch, PR submission, deployment or
required fork is implied. DSG must continue working with stock DS4.

## Bounded request correlation

At inspected upstream revision
[`9ab7053`](https://github.com/antirez/ds4/blob/9ab705347c1775e7599ede7eb81a6255ec7dccb5/ds4_server.c#L13347),
the HTTP request structure retains method, path and body, but no client request
ID. The parser reads Content-Length and copies the body; it does not retain
`X-Request-Id`. DSG already sends a generated request ID, but that is not proof
that DS4 echoed it into engine telemetry.

A narrow proposal worth discussing is an **optional bounded opaque request ID**
carried from HTTP admission into existing start/finish diagnostics. This could
help any local client correlate its requests without enabling prompt tracing.
It is more targeted than changing the inference engine, scheduler or cache format.

Before a PR is ready:

- Agree on field format and lifecycle semantics with upstream. Keep omission
  backward compatible; preserve body, rendering, tokenization and model settings.
- Bound accepted IDs and handle malformed/duplicate headers explicitly without
  echoing attacker-controlled log text. Diagnostic IDs are neither credentials
  nor proof of uniqueness; DSG must still reject conflicting ownership evidence.
- Test admission, queued work, generation, rejection, cancellation and errors.
  Document what a terminal diagnostic proves about backend work, rather than
  treating a closed client connection as a completed job.
- Measure overhead using synthetic requests with correlation absent and present.
  Do not require verbose tracing or log prompts, output, image bytes or cache keys.
- Refresh issue/PR searches and bring a minimal reproducer and tested patch to
  the operator before submitting or installing anything.

This signal could improve attribution. It would **not** by itself establish cache
identity, authorize a cache transfer, or make post-dispatch retries idempotent.

## First useful stage: passive, attempt-bound cache observations

Proposed, not implemented or negotiated upstream. Prefer a small optional event
emitted during an ordinary request over a new cache-management endpoint. No
additional inference, cache load, prompt replay or query request should be needed.

Keep these identities distinct:

- A **gateway job** is the client request being served. DSG currently sends that
  ID in `X-Request-Id`, including its bounded normalized-image follow-up.
- A **transport attempt** is one submission to one backend. A follow-up needs a
  distinct attempt identity even when it belongs to the same job.
- A **backend execution** is the work actually admitted to an engine slot. Its
  process epoch and slot generation must be scoped; a slot number alone can be
  reused after restart. Admission or transport acceptance is not execution.

These are proposed semantics, not new header names or an advertised capability.
An echo of today's job ID alone would not distinguish multiple attempts. Agree
on exact propagation, bounds and lifecycle with upstream before implementing it.

A bounded event could carry the matched attempt, backend-scoped execution/slot
identity, selected cache-source category, prompt/cached/suffix token counts and
measured component spans. Use fixed outcomes and monotonic elapsed durations;
declare stage boundaries and whether spans overlap. Keep absence distinct from
zero. Correlation must survive queueing, errors, cancellation and restarts without
turning a connection close or missing terminal into a claim that work stopped.

DS4 computes the actual cache source and effective prompt during generation;
slot scoring and realized reuse are different observations. The inspected slot
scorer uses common-prefix length, while generation performs further reuse checks.
Report the realized result, not a score relabelled as cached tokens.
[Slot selection](https://github.com/antirez/ds4/blob/9ab705347c1775e7599ede7eb81a6255ec7dccb5/ds4_server.c#L13219),
[generation-time reuse](https://github.com/antirez/ds4/blob/9ab705347c1775e7599ede7eb81a6255ec7dccb5/ds4_server.c#L11959).

DSG would consume a capability only after explicit version/semantics validation.
Omission, unknown versions, malformed fields, duplicate/conflicting identities or
lost events retain existing bounded attribution or unknowns. The telemetry path
must be bounded, non-blocking and dispensable: a failed observer cannot stall
inference. Do not enable full prompt tracing to obtain these facts.

Keep new diagnostic identities in an explicitly opted-in private telemetry
channel, not an added public cache-inspection endpoint. Existing protocol response
IDs remain unchanged. Do not echo arbitrary user-supplied IDs, cache filenames,
rendered text, token arrays, image bytes, raw OS identifiers or cache-content
hashes into public responses or logs. Validate correlation values and reject
log-control characters.
Capabilities remain off/absent on stock versions that do not implement them.

This stage can label **realized** cache components and distinguish a worker-local
slot event from a gateway handover. It cannot discover an exact checkpoint for a
future request on another worker. Post-dispatch observations must not leak into
admission-time training features or count as forecasts of unchosen paths.

## A separate stage: genuinely non-mutating prefix inspection

The four-path comparator has been retired. The following inspection design is
historical research, outside the active simplified system; passive cache
observations remain available without it.

Do not reuse the current restore routine as a probe. The inspected loader changes
session state, touches cache hit metadata and can unlink a corrupt payload;
the server wrapper can invalidate vision state before loading. Those are normal
restore semantics, not a read-only inspection contract.
[Payload loading and metadata](https://github.com/antirez/ds4/blob/9ab705347c1775e7599ede7eb81a6255ec7dccb5/ds4_kvstore.c#L1275),
[server wrapper](https://github.com/antirez/ds4/blob/9ab705347c1775e7599ede7eb81a6255ec7dccb5/ds4_server.c#L10320).

A future inspection capability needs its own bounded, explicitly enrolled
contract: consistent inventory revision, freshness and expiry, exact reuse
predicate, complete-versus-partial results and race handling. It must not load,
save, evict, publish, pin or retokenize a checkpoint, alter LRU/hit metadata or
select/reserve an inference slot. A vanished or changed entry becomes unknown;
an inspection result is not a lease or transfer permission. Measure lock duration,
I/O and contention on isolated workers before proposing live use.

Do not expose stock cache filenames as privacy-safe identities: they are hashes
of rendered byte prefixes. Prefix lookup checks those byte prefixes, while the
payload retains exact tokens and engine state. Nor can a whole-prompt digest
identify every usable shorter prefix. An opaque reference design needs a separate
privacy review, including cross-worker scope, chosen-input membership oracles,
expiry/key rotation and full model/renderer/tool/vision compatibility. A matching
short header fingerprint is not enough.
[Prefix lookup](https://github.com/antirez/ds4/blob/9ab705347c1775e7599ede7eb81a6255ec7dccb5/ds4_kvstore.c#L1190).

In this inspected revision, disk restoration is skipped for multimodal requests;
live vision reuse has a separate identity check. Any future capability must state
that distinction explicitly. Do not infer a transferable vision checkpoint from
a live RAM hit or an otherwise compatible disk header.
[Multimodal and disk paths](https://github.com/antirez/ds4/blob/9ab705347c1775e7599ede7eb81a6255ec7dccb5/ds4_server.c#L12102).

## Acceptance before any proposed implementation is enabled

Use synthetic workloads and isolated caches, preserving all production settings.

| Check | Required evidence |
| --- | --- |
| Stock/disabled/unknown capability | Ordinary requests and existing fallback behavior are unchanged; no observer dependency |
| Concurrent jobs and a normalized follow-up | Each execution links to the right attempt; two attempts cannot collapse into one start |
| Duplicate, malformed or spoofed correlation | Bounded rejection/abstention, no raw log injection or manufactured ownership |
| Cancellation, abrupt EOF and restart | No false completion, cross-epoch join or automatic post-dispatch replay |
| Text, tool/reasoning and vision work | Realized source/counts agree with actual engine behavior; unsupported disk/vision cases remain explicit |
| Passive observer failure | Bounded memory/CPU and no request stall or changed response bytes/usage |
| Any later inspection API | Cache contents, hit/LRU state and resident KV unchanged; races and partial scans cannot prove absence |
| Four-path validation | Freeze forecasts before dispatch, score matched realized components, retain unchosen outcomes as unknown |

These are gates to satisfy, not reported test results. No upstream branch was
installed, no model probe was run and no remote acquisition was enabled for this
research note.

## Related upstream work to follow, not duplicate

- [PR #752](https://github.com/antirez/ds4/pull/752), open and unmerged when checked,
  proposes server-local Responses IDs backed by retained KV prefixes, including
  restart handling. Its described benchmark is a token-only host-side fixture,
  not GPU inference validation. This may become a useful optional capability;
  it is not a cross-worker cache-transfer protocol or a guarantee for existing
  Chat Completions clients.
- [PR #67](https://github.com/antirez/ds4/pull/67), closed and unmerged when checked,
  proposed broader multi-session/pool controls. Search results mentioning request
  IDs are not evidence that the narrow telemetry feature already shipped.
- [PR #765](https://github.com/antirez/ds4/pull/765), open and unmerged when checked,
  proposes slot selection based on usable resident KV rather than merely a shared
  prefix. This is worker-local behavior, distinct from DSG's fleet routing. Its
  reported tests/benchmarks are upstream-author evidence, not a DSG validation
  or proof that a particular deployment suffered the described problem.

The refreshed search was bounded; it does not prove that no other relevant work
exists. Recheck current source and issue/PR history with the maintainer before
preparing a patch. Do not adopt a broad cache/routing change solely to obtain
telemetry or duplicate an existing proposal.

The existing [integration boundary](ds4-integration.md) and
[attribution safeguards](request-attribution.md) remain unchanged. Review upstream
changes on their merits; do not adopt a broad patch merely to obtain one signal.
