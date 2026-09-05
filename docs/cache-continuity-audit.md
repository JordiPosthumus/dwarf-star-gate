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

Two different requests with the same admission timestamp in the same session
and gateway run have **unknown relative order**. Every member of that tied group
is a comparison barrier, as is the next comparison leaving it, with reason
`ambiguous_session_order`. Input order, request-ID sorting and client turn hints
cannot choose a predecessor. Later unambiguous neighbors are still assessed.
This differs from an ordinary request whose finish equals its own admission:
that zero-duration clock reading alone is not a chronology contradiction.

Malformed decision, finish or relocation envelopes stop the audit with a fixed
diagnostic, without printing the record. Silently discarding one could erase an
intervening request or move; an invalid clock/identity cannot safely identify the
affected interval. Inspect and repair the evidence separately rather than treating
the remaining rows as complete. Unrelated event kinds remain outside this audit.

The API permits only positive integer event budgets up to 200,000 events and
request budgets up to 50,000. Invalid overrides or exceeded budgets fail explicitly
instead of disabling the bound or silently truncating retained evidence. This
limits the audit, not data collection or inference.

## Evidence boundary

### Machine-card view

Each machine's **Cache checks** row summarizes recent low-reuse turns. Expand it
for assessed/candidate pair coverage, recency, abstention reasons and a next
diagnostic check. Possible lost reuse and unconfirmed low reuse stay distinct;
neither is engine-protocol proof. Engine RAM misses, disk restores and starts
without reuse are separate observations over the displayed observation epoch.
A new or edited prompt can legitimately start without reuse.

Disk-load spans are measured components from the last hour (up to 128 retained
components), not total cache acquisition or time lost to a miss. Extra time
caused by lost reuse remains unknown. No counterfactual cost is invented.

The dashboard reuses its existing bounded analytics file reader. Its private
projection retains only continuity fields, at most 16,384 relevant events and
8 MiB of serialized projected data; JavaScript object overhead is additional.
It recalculates only after changes and at most once per 15 seconds. Source reads
remain on the existing schedule. There is no additional inference, model fitting,
cache access, raw text/vector retention, or dataset write.

This is the latest contiguous retained suffix of the reader's most recent two
daily files (up to 8 MiB per file), not a lifetime audit. A skipped daily prefix
starts a new cache view so pairs cannot span the missing interval. Malformed or
oversized middle lines and unfinished older-file tails withhold findings; file
replacement/rotation rebuilds the view. Exhausting either projection budget shows
“Evidence window full” until a rebuild, instead of silently dropping middle
requests. These limits bound the dashboard view, not collection or retention.
Disabled collection and empty installations show missing evidence without
requiring any predictor, encoder or model files. Inference remains independent.

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
of valid neighbors, tied admission groups, shuffled input and bounded configuration. A frozen-data comparison kept all
previous valid classifications identical after this chronology hardening.
The first deployment smoke audit must keep its exact counts private.

The next safe improvements are earlier real client turn/compaction metadata,
strong backend-process attribution where available, and a future stock DS4
opaque rendered-prefix signal if upstream accepts a mutually useful interface.
Until then, missing guards remain missing and never become invented confidence.
