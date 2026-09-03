# Gate Genie memory — implementation plan

Status: **planned, not implemented**. A small, private, DSG-owned operational
notebook, not a replacement for the collector, predictor or permission checks.
It survives dashboard restarts and changing Genie's model or device. It needs
neither Pi/Hermes nor a permanently warm DS4 session.

## Purpose and ownership

Genie should recognize recurring incidents, show what helped last time, avoid
fruitless repeated experiments and follow up on unresolved issues. Example:
“This worker repeated the accelerator failure. The previous enrolled restart
restored service; generation has not yet been verified this time.” Each factual
part needs an evidence reference. An old remedy is not automatically safe now.

| Owner | Authoritative material | Genie's use |
| --- | --- | --- |
| Collector and numerical summaries | Timestamped observations, outcomes, provenance and coverage | Measured facts, not remembered speeds |
| Predictor lifecycle | Frozen data/artifacts, CV, independent gates, baseline/champion state and receipts | Forecasts and actual experiment results |
| Genie notebook | Evidence-linked incidents, hypotheses, lessons, open questions and operator notes | Context, investigation priorities and explanations |

Link existing durable records rather than copying all telemetry, vectors or
model reports. Deterministic code produces numerical rollups; Genie cannot write
training labels. Executors independently recheck current action offers. A memory
never creates authority. Genie/memory failures must not block routing, collection,
forecasting or the fixed fallback.

## What to remember and think about

1. **Incidents/recovery:** worker and known process/config epoch, allowlisted
   error signature, first/last occurrence, observed symptoms, action receipt,
   subsequent observations and outstanding follow-up. Distinguish endpoint health
   from successful generation, and mitigation from fixing the underlying bug.
2. **Performance:** references to prefill/decode and service-time distributions
   by worker *and* hardware class, context range, observed cache regime and
   requested thinking when known. Show sample counts, time window, dispersion and
   missingness. “This Mac is slow” without workload context is not a useful fact.
3. **Availability:** observed reachable/eligible/paused/quarantined time,
   failures, recoveries and monitoring gaps. OS uptime, DS4 process uptime and
   DSG observation age are distinct; unknown stays unknown. A log reconnect is
   not a restart. Operator pauses are not outages. Never claim availability for
   periods when monitoring was absent.
4. **Cache health:** suspected misses with prefix/usage/log evidence and
   attribution confidence. Compaction, conditioning changes, worker/profile
   changes and cold starts can explain misses. Similar text proves neither
   reusable KV nor a cache bug. Heuristics are not ground-truth labels.
5. **Experiments:** recipe/window, immutable snapshot/model IDs, CV and independent
   validation results, training cost and receipt; why a candidate lost/regressed.
   Reconsider after hardware/traffic changes. Keep synthetic/production evidence
   distinct. Repeated searches on one holdout are not independent confirmation.
6. **Operator intent:** explicitly saved notes about intentional pauses,
   investigation priorities and preserving warm caches. Live config wins;
   neither recalled preferences nor chat can grant a restart, resume, migration,
   DS4 setting change or weaker promotion gate.
7. **Open questions/upstream opportunities:** evidence needed, cheapest safe
   next check, last review date, and links to the
   [contribution policy](ds4-integration.md#upstream-contributions).

Do not store inference prompts, tool results, reasoning traces, keys, raw logs
or full operator-chat transcripts. The operator can explicitly save a concise
operational note. Predictor embeddings stay in their separate private dataset;
they are sensitive and not needed to search a few hundred operational notes.

## Small storage contract

Private `runtime/genie/memory/`, directory 0700/files 0600, excluded from Git,
screenshots and diagnostic exports by default. One append-only event journal is
durable; a rebuildable index supports retrieval. No new database/vector service.
The dashboard is the single writer: serialize writes, write/fsync before success,
reject symlinks, preserve incomplete/corrupt tails for investigation. Disk failure
stops memory writes visibly and leaves stateless reviews/inference available.

Each versioned record carries:

- ID/revision/type, bounded title/body, created/updated/last-verified timestamps.
- Fleet/worker scope, hardware class and known process/config/cache-profile
  identity. Endpoint/model name alone is not process or cache identity.
- Provenance (operator, deterministic extractor, Genie hypothesis), exact source
  IDs/time range, and action/experiment receipt IDs where applicable.
- State (open/resolved/superseded/archived), verification
  (observed/hypothesis/stale/disputed), review-after and superseded-by references.

Genie proposes structured incident summaries/hypotheses with existing evidence
IDs. The writer validates ID existence, scope, epoch, lengths and current source
availability. That does not certify a causal conclusion: generated prose stays
labelled a hypothesis. Extractors own numerical facts; only operators pin their
preferences. Updates are revisions; repeated incidents are deduplicated by
signature/scope without losing occurrence counts. No receipt means no verified
action, however confidently a report claims success.

## Retrieval and review

Every review combines current fleet evidence and allowed actions with relevant
open incidents, recent changes, a few comparable past episodes/experiments and
pinned intent. Use exact worker/epoch/type matching, recency and simple text
search first. Initial notebook budget: 12 notes and 16 KiB, smaller if the model
requires it. Never drop current control rules to fit history; disclose truncation.
Memory is labelled untrusted data, never system instructions or tool definitions.

Fresh verified state outranks old notes. Changed epochs invalidate claims about
*current* cache residence/health, while old incidents remain comparable history.
Unknown epoch means no continuity claim. Expose conflicts and require new evidence
before repeating stale diagnoses. Ask: What changed? Has this happened before?
Did the last action actually help? Which workload regime is prediction failing
on? What is missing? What is the cheapest safe check? Cite evidence when accusing.

## Retention and UI

Bounded retrieval is not silent deletion. Start with no automatic deletion of
existing source data. Proposed review defaults: incident notes review-due after
7 days without new evidence; speed summaries refreshed from their stated window;
cache-residence assertions expire with source validity/epoch, not an invented
TTL. Resolved incidents remain history. Pins cannot make measurements current.
Before deployment choose an explicit storage ceiling/retention setting. At the
ceiling pause writes visibly, never silently evict. “Forget” must specify notebook
content versus separately retained source evidence; erasing one is not both.

Add a compact **Memory** section: enable switch, state/count, last successful
write, open/review-due incidents and storage health. Memory retrieval/writes are
independent of Genie inference and predictor controls. Off retains records and
changes no permissions. Show notes used by each report and actual save receipts.
Allow view/search, explicit “Remember this operational note,” correction, archive
and scoped forget. Show age, evidence, worker/epoch and hypothesis/stale labels.
Health-wire live claims still require fresh evidence. Existing sticky learning
milestones remain separate. Public examples use synthetic identities/data only.

## Delivery and tests

1. Read-only numerical summaries with supported joins and explicit missingness;
   no claimed process uptime without a supported measurement source.
2. Durable notebook: schema, serialized writer, idempotent revisions, bounded
   retrieval/recovery. Import existing receipts only where linkage is exact;
   do not invent old Genie reports.
3. Opt-in, observation-only review/UI integration and hypothesis save receipts.
   No extra recovery, migration, server-mutation or deployment authority.
4. Evaluate recurrence recall, fewer repeated unsupported suggestions, correct
   worker/epoch attribution and bounded review overhead in actual use. Do not
   label anecdotes as measured routing gains.

Test restart/model-source continuity, concurrent/idempotent writes, disk-full and
corruption, retrieval limits, missing/expired sources, worker remove/re-add,
process changes/unknown epochs, monitoring gaps, pause versus failure, null versus
zero, hostile stored instructions, no authority escalation, privacy-safe exports,
UI polling preserving open notes, and unaffected gateway/baseline with memory off
or broken. Memory is a failure-tolerant aid, not a dependency of safe operation.

## Next learning slices

Planning memory need not delay early client metadata, reviewed bounded XGB
recipes and cache-preserving calibration preflight. Memory explains experiments;
it never supplies labels or grades a model. Calibration may stay skipped until a
non-displacing path is proved; organic traffic needs no synthetic generation.
