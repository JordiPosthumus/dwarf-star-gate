# Request-to-engine attribution

**Implemented as shadow evidence; never a routing input or exact identity claim.**
DSG now separates two questions that were previously conflated:

1. Did the DS4 backend process change?
2. Which gateway request, if any, plausibly caused one observed engine prompt?

## Backend process epochs

For systemd journal telemetry, DSG requests the stock
`_SYSTEMD_INVOCATION_ID`, `_BOOT_ID` and `_PID` fields. It prefers the invocation
ID and labels boot ID plus PID as a weaker fallback. The UI, metrics, diagnostics
and Gate Genie receive only a domain-separated SHA-256 digest bound to the worker
ID; raw OS identifiers are never retained.

A journal reconnect with the same service invocation keeps the same epoch. For a
local stock-DS4 log, DSG can derive a weaker bounded epoch from the most recent
timestamped `listening on` marker, file identity and byte location. It scans at
most the latest 8 MiB on reader startup; an older/missing marker stays unknown.
Parsed timing records after that marker inherit only the derived digest; records
before it, or in a rotated file without a fresh marker, do not. This preserves
file order without guessing across process boundaries. Only the digest is
retained—the endpoint and raw line are not. A new
epoch clears incomplete timing spans, speed history, cache counters and component
cost samples in the dashboard observer. It does **not** restart DS4, remove cache
files, change model settings, change routing or touch Pi. Missing process evidence
remains unknown.

## Conservative request candidates

The dashboard joins its bounded gateway lifecycle tail to DS4 `prompt start`
events in the same worker and observed process epoch. A row is:

- `candidate` when exactly one gateway dispatch window can explain the start;
- `corroborated` when that one candidate later reports exactly matching prompt
  and cached-token usage, or when every clock-overlapped gateway window has
  completed and exactly one reports that matching usage tuple;
- `abstained` when the epoch is missing, no window exists, windows overlap, one
  request sees multiple starts, returned usage conflicts, or more than one
  overlapped request reports the same tuple.

With a strong systemd epoch, `corroborated` means **high-confidence candidate**,
not protocol proof. The boot/PID fallback and local-log listen-marker epoch remain
explicitly bounded. DS4 does not currently echo the gateway request ID into its
timing record. Invisible direct clients and unknown clock error cannot be ruled
out merely by a time-and-usage match. Therefore these rows do not train XGB,
accuse a route of a cache miss, move work, or authorize recovery.

The correlator normally retains 15 minutes of completed history, but preserves an
open attribution span for up to seven days so long-context xhigh generations are
not discarded merely for being slow. When one completed request overlaps a peer
that is still running, its private candidate window is retained until every
candidate has a terminal event. The set is capped at 64 candidates per start and
512 lifecycle records overall. Under capacity pressure, a missing remembered
candidate preserves the overlap abstention; forgetting evidence can never create
a unique owner. A missing candidate is not counted as a terminal event: surviving
overlap windows remain eligible for delayed reconciliation within the same
seven-day/512-record bounds. Once every candidate's completion has actually been
observed, settled evidence returns to the ordinary history bound; ordinary aging
does not reopen retention. A newly discovered possible owner does reopen it.
Identical normalized engine-start replays and later normalized field updates
preserve the remembered overlap and overflow guards, even after a completed
candidate has aged out. Epoch/confidence enrichment still updates the displayed
metadata; it does not erase possible owners. Raw input cannot replace the private
guards, and they are not emitted into telemetry or status. Replaying a log
line is not new ownership evidence and cannot manufacture a unique surviving
request. Pending starts still accept genuinely later completion evidence.

Contradictory lifecycle records are not a choice between the first dispatch and
the last completion. Different dispatch/finish clocks, terminal outcomes, usage
tuples or worker identities for the same request—and a finish clock before its
dispatch—produce `gateway_evidence_conflict` for potentially affected starts.
An identical normalized replay is harmless; receiving a valid finish before its
dispatch record is also supported. Arrival order is not timestamp order.

The correlator keeps bounded observed clock ranges and, only for contradictory
worker identities, up to 64 private worker IDs per lifecycle row. A range may
over-cover the gap between contradictory revisions; it cannot establish a match.
If the worker set overflows, the time-bounded conflict is conservatively applicable
to any worker. Otherwise unrelated workers and out-of-window starts retain their
ordinary matching behavior. The existing 512-record/seven-day bounds still apply.
A conflict seen by a retained engine sample remains a guard after lifecycle
pruning and metadata enrichment; removing a contradictory peer cannot manufacture
a unique owner. The guard and worker set are never exported. The audit and Genie
receive only the fixed reason/category, not a new recovery or routing authority.
Missing evidence outside the bounded observation history remains unknowable.

It uses a five-second clock tolerance and a ten-minute maximum
dispatch-to-prompt-start lead. Stable sample and revision digests allow later
readers to deduplicate dashboard replay. Only allowlisted IDs, times, token counts,
status and epoch digests are saved in the private dashboard metrics stream;
private candidate sets, prompts, responses, journal text, paths and credentials
are absent.

The Genie briefing uses the same fixed reason/confidence vocabulary as the
quality summary, including uniquely disambiguated overlaps and duplicate usage
matches. It retains signed dispatch offsets only within the correlator's existing
clock-tolerance/dispatch-lead bounds. Request/sample IDs and arbitrary prose
are not included in this briefing projection. These explanations do not upgrade
bounded epoch evidence, prove a cache hit or grant action authority.

## Attribution-yield audit

The dashboard now reports an honest corroboration rate over **resolved** engine
starts, with pending candidates outside that denominator. It also exposes bounded
abstention causes. A local read-only audit can deduplicate final revisions across
up to seven recent daily metric files and break the result down by configured
server:

```sh
npm run attribution:audit
# or: node ds4-gateway/attribution-audit.mjs --directory /absolute/private/dashboard --files 7
```

Add `--since 2026-09-04T00:00:00Z` to select engine starts at or after a UTC
timestamp, for example when validating a collector upgrade. This works with
both the recorded audit and `--gateway-log` reconciliation. It filters the
reported cohort, not the evidence read: earlier request owners and competing
engine starts still veto unsafe matches. Later revisions of selected starts
remain included. Source bounds and incomplete-source warnings still apply.

The audit reads at most 8 MiB per file and 65,536 attribution records. It rejects
symlink roots, skips symlinked/non-regular metric files, bounds individual lines,
and reports malformed/partial/truncated input instead of implying complete
history. Output contains counts, fixed reason codes and configured server IDs—no
prompts, responses, request/sample IDs, paths or credentials. Treat the report as
private deployment metadata and do not commit it.

An optional second, still read-only view can revisit recorded clock-overlap
abstentions after their gateway requests have finished:

```sh
npm run attribution:reconcile-audit
# or add --gateway-log /absolute/private/runtime/gateway.log
```

This mode reads at most 32 MiB from each selected metric file and 32 MiB from the
gateway lifecycle log. It acts only when all selected sources are complete,
regular, parseable and within their bounds; the gateway coverage must begin at
least ten minutes before the engine start. Every overlapped request must have
finished with an exact prompt/cached-token tuple, exactly one tuple must match,
and no other engine start may own that request. Otherwise the row remains an
abstention. The report presents the recorded view beside the later-evidence view;
it never rewrites telemetry or hides the original decision. Private request and
sample IDs are used only inside the bounded join and never returned.

When one metric day outgrows its share but the selected files collectively fit,
an explicit offline option can read them completely:

```sh
npm run attribution:reconcile-audit -- --shared-metric-budget
```

This shares the **same combined metric allowance** (`--files` × 32 MiB; three
files/96 MiB by default). It does not raise the gateway-log allowance, file-count,
line or record limits. Every selected regular metric file must fit in full;
aggregate overflow—including growth detected on open—fails explicitly, never
silently drops an older file or reads only a tail. `metric_budget` reports the
mode, limit and bytes read. Individual read buffers can be larger than in the
per-file mode; this remains an operator-run offline audit, not live collection.
The default per-file behavior remains unchanged. The flag requires reconciliation
with `--gateway-log`; the npm command above already supplies that argument.

Both reader modes complete short filesystem reads and fail if the source shrinks
before its pinned byte range has been read. For reproducibility, audit private
frozen copies and record their hashes; reading running files is not an atomic
cross-process snapshot. Source completeness does not prove protocol identity.

The later-evidence report also provides `reconciliation_by_worker`, sorted by
configured server ID. Each entry accounts for the selected engine starts that
were originally abstained as `overlapping_gateway_windows`:

```text
recorded_overlap_abstentions = reconciled_overlaps + remaining_overlap_abstentions
```

`block_reasons` explains each remaining overlap once; its counts sum to that
worker's remaining overlaps. `competing_start_details` describes the subset
blocked by another engine start. Those flags can overlap—for example, the same
target can have both an identified competing start and unresolved ownership—so
they must not be added as if they were separate requests. Per-worker totals
reproduce the existing fleet totals. Source-incomplete and contradictory-gateway
failures also retain per-worker explanations without inferring any new match.
Workers with no selected overlap abstentions are omitted from this breakdown;
they remain in the ordinary summary when they have other starts.

This is a diagnostic ledger, not a new matching policy or a hardware-fault score.
Missing candidate usage calls for checking terminal evidence; competing starts
need independent ownership evidence, not a smaller clock tolerance or circular
confirmation between new proposals. Selecting a fresh cohort still retains older
owners and competing starts in the checks. A single observed Mac listen-marker
epoch cannot validate behavior across a real backend restart: that requires a
separately authorized, isolated before/after process-boundary exercise. A higher
later-evidence yield alone does not provide that proof.

The engine-start record must exactly agree with the attribution row's timestamp,
process epoch and its strong/bounded confidence, and prompt/cache/new-token tuple.
A reused sample ID with conflicting normalized start records yields
`engine_start_conflict`; identical duplicates are harmless. Conflicting samples
also cannot establish independent ownership for a competing start.

Contradictory attribution revisions tied at the latest observation timestamp
yield `attribution_evidence_conflict` when used as the target and cannot establish
independent ownership for competing starts. Every possible tied request claim
still participates in collision checks; unrelated supported matches remain usable.
File order cannot decide which tied ownership claim is true. Identical normalized
duplicates remain usable, and a unique strictly later revision supersedes an
older tie. This also applies to potential owners outside the selected cohort;
filtering them away could manufacture a match. The original recorded view stays
visible and is not repaired by the audit.

Contradictory dispatch/finish records, including a finish before its own dispatch,
yield `gateway_evidence_conflict` and leave
the entire selected cohort's recorded view unchanged. The auditor must not discard
an inconsistent request and thereby make another match appear unique. These are
consistency checks in addition to `source_complete`, which describes bounded file
read/parse coverage, not a guarantee that all records agree. Original historical
corroborations and abstentions are never rewritten by this offline audit.

Every dispatch/finish used by reconciliation also needs a valid positive clock,
not just a recognized event name and request ID. Missing or invalid lifecycle
timestamps make the file view `source_complete:false` and increment
`gateway_invalid_records`; the direct row API likewise preserves the recorded
view. Silently skipping an undated dispatch could remove a possible competitor
and manufacture a unique owner. The general telemetry sanitizer remains unchanged;
this stricter requirement belongs to the offline ownership-evidence join.

A competing start can be excluded only when its **original recorded** attribution
already corroborates a different, uniquely owned, successfully completed request:
its engine timestamp, process epoch, prompt/cache tuple and gateway lifetime must
agree, and its tuple must differ from the target's. New reconciliation proposals
never establish that independent ownership, so circular inference remains blocked.
Anonymous starts, conflicting lifecycle records, missing usage and inconsistent
epochs continue to abstain. This changes only the offline later-evidence view.

The offline join indexes validated dispatches and engine starts by worker/time
before applying those same exact predicates. Inclusive, padded candidate ranges
reduce repeated full scans; they do not drop source records, relax clock bounds,
change ownership or alter the online correlator. Regression tests cover both
skew/lead endpoints, finish bounds, ties, shuffled workers, unfinished requests,
anonymous starts and immutable inputs. Performance comparisons must also preserve
the complete report, including abstention reasons; a faster audit is not a claim
of faster inference or more certain attribution.

This measures evidence yield on ordinary traffic; it does not validate a cache
hit or upgrade a candidate into protocol identity. Exact attribution would still
require a stock DS4 protocol signal, such as safely propagating an opaque request
ID into a structured timing event. That is an upstream opportunity to investigate,
not a private server-patch requirement. Until then, cache acquisition remains
component evidence and every ambiguous join stays unknown.
