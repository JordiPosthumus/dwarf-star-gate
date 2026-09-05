# Cache-continuity audit

**Implemented as a read-only, aggregate audit over DSG's private numerical
dataset. It has no routing or cache authority.** The audit asks a narrow question:
when two consecutive requests identify the same DSG session and stay on the same
server, how much of the earlier prompt does DS4 report reusing on the later turn?

Run it from a deployment checkout:

```sh
npm run cache-continuity:audit
# Optional bounded horizon:
node ds4-gateway/cache-continuity-audit.mjs --data /absolute/private/training --max-age-hours 24
```

The report is private operational metadata. It contains only aggregate counts,
ratios, fixed reason codes and configured server IDs. It never returns prompt or
response text, embeddings, session/request/event IDs, paths, credentials, cache
filenames or snapshot pseudonyms.

## What is actually measured

For one immediately consecutive session pair, the auditor requires:

- one unambiguous decision and at most one completion for each request;
- a finish timestamp at or after that request's own admission; contradictory
  chronology yields `noncausal_request_evidence`, never a reuse/loss assessment;
- no queued relocation in either request;
- a completed, uncensored supported route on the same worker;
- the current decision marked `existing` affinity;
- matching configured worker profiles and, when present, an unchanged gateway
  observation epoch;
- prompts retaining at least 80% of the earlier token count and at least 256
  reference tokens, reported prompt/cached token usage, and no more than 24 hours
  between the earlier completion and later admission.

The measured reuse ratio is:

```text
later cached tokens / min(earlier prompt tokens, later prompt tokens)
```

It is capped at one. At least 80% is `reuse_observed`; 20–80% is
`partial_reuse`; below 20% is low reuse. These fixed bands are diagnostic
thresholds, not learned truth or a DS4 policy.

Low reuse becomes `high_suspicion_low_reuse` only when two additional client
guards are present: consecutive model-call indices and an unchanged compaction
count, together with the same observed worker epoch. Otherwise it is
`unconfirmed_low_reuse`. A compaction, changed worker/profile/epoch, route change,
failed or missing terminal, stale pair, prompt shrink, relocation or overlap
abstains with an explicit reason instead of entering the ratio.
An invalid middle request is not skipped to manufacture a consecutive pair from
its neighbors. Input ordering cannot repair contradictory recorded timestamps;
equal millisecond timestamps alone are not treated as contradictory.

The API permits only positive integer event budgets up to 200,000 events and
request budgets up to 50,000. Invalid overrides or exceeded budgets fail explicitly
instead of disabling the bound or silently truncating retained evidence. This
limits the audit, not data collection or inference.

## Evidence boundary

Even the high-suspicion class is not proof of an engine defect. Client metadata
is an untrusted hint, a gateway observation epoch is not an OS process identity,
and a user can branch or edit history without changing a session ID. DSG does not
currently receive an exact rendered-prefix identity from stock DS4. The auditor
therefore identifies where to investigate; it does not accuse automatically,
move a session, rewrite a prompt, delete a cache or restart a worker.

This audit complements, but does not unlock, the
[four-path cache-continuity shadow](cache-continuity-shadow.md). It supplies
realized reuse evidence and data-quality reasons. It does not prove that a
particular disk snapshot exists, implement a remote acquisition protocol, or
validate the counterfactual completion time of an unchosen path.

## Validation and next evidence

Unit tests cover observed, partial, strongly guarded and unconfirmed low reuse;
compaction, epoch/profile changes, relocation, failure, staleness, prompt shrink,
route changes, run boundaries, duplicate/conflicting evidence and report privacy.
They also cover impossible request chronology, reversed input order, preservation
of valid neighbors and bounded configuration. A frozen-data comparison kept all
previous valid classifications identical after this chronology hardening.
The first deployment smoke audit must keep its exact counts private.

The next safe improvements are earlier real client turn/compaction metadata,
strong backend-process attribution where available, and a future stock DS4
opaque rendered-prefix signal if upstream accepts a mutually useful interface.
Until then, missing guards remain missing and never become invented confidence.
