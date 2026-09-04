# KV transfer: evidence and next experiment

Research checked 2026-09-04 against upstream DS4 revision
[`b0a147a`](https://github.com/antirez/ds4/tree/b0a147a7fba6d1a104d047d5a140e9bb4bfc13cd).
No cache transfer, server change, enrollment or performance claim is implied.
Today's handover moves an undispatched request, not its KV data.

## Existing building blocks

- Disk entries contain a KVC header, a text-length field, **rendered prompt text**,
  session payload and potentially a protocol trailer. Saving writes a temporary
  file and renames it after closing it. This is sensitive session data, not an
  anonymous tensor-only artifact.
  [Storage path](https://github.com/antirez/ds4/blob/b0a147a7fba6d1a104d047d5a140e9bb4bfc13cd/ds4_kvstore.c#L1085).
- Prefix lookup refreshes the directory inventory. Loading checks the cached
  text against the requested prefix and invokes the session-payload loader.
  Discovery of a newly published disk entry is a promising existing mechanism,
  **not** an enrolled remote import API or proof that external copying is safe.
  [Lookup and restore](https://github.com/antirez/ds4/blob/b0a147a7fba6d1a104d047d5a140e9bb4bfc13cd/ds4_kvstore.c#L1190).
- The graph loader checks context, model dimensions, raw-window/ring layout and
  compressed-cache capacity. Prefill scratch capacity is explicitly distinct
  from durable KV layout. Matching a filename or outer header does not prove a
  correct restore or continuation across backends.
  [Graph checks](https://github.com/antirez/ds4/blob/b0a147a7fba6d1a104d047d5a140e9bb4bfc13cd/ds4.c#L57028).

DSG's inventory reads only the first 52 bytes, never prompt text or payload.
Its bounded header cohort is not a full model-weight identity or transfer
permission. At this upstream revision the header writer does not populate the
optional weight fingerprint bytes used by some builds; DSG treats zero as
unknown rather than assuming portable equivalence.
[Header writer](https://github.com/antirez/ds4/blob/b0a147a7fba6d1a104d047d5a140e9bb4bfc13cd/ds4_kvstore.c#L395).

## Proposed experiment, not enabled behavior

Start with explicitly available, identically provisioned workers and a synthetic
conversation in isolated test cache directories. Do not use reserved research
machines, displace warm sessions or change normal launch settings. Mac-to-Spark
and differing model/build combinations need separate canaries.

1. Prove complete model/vision identities, build and payload compatibility
   independently of the short header fingerprint. Establish exact prefix
   identity; semantic similarity and session affinity are not enough.
2. Select a completed disk checkpoint. Keep the source copy and ownership intact.
   Verify a stable file descriptor and full-byte integrity during staging;
   rename, truncation, mutation or eviction must not publish partial data.
3. Use enrolled authenticated transport and private temporary storage. Bound
   space and I/O, reject symlinks and unexpected destinations, check budgets and
   existing entries before atomic publication. Do not export prompt text, cache
   filenames or payload bytes in public receipts.
4. Prove a real restore and continuation against a cold reference, including
   tool/reasoning and vision identity where applicable. Verify unrelated warm
   sessions and the source checkpoint survived. Copy success is not inference
   correctness or cache-reuse proof.
5. Measure transfer, restore, suffix-prefill and generation, including contention.
   Compare total cost with waiting hot and cold prefill. Do not invent outcomes
   for the unchosen alternative.

Only then should an enrolled executor offer a bounded cache-acquire operation
to the scheduler or Genie. Failure must preserve the original undispatched
request and ownership; it never authorizes replay of active work.

See the [four-path contract](cache-continuity-shadow.md) and
[handover outcome audit](routing-shadow.md#applied-handover-outcome-audit).
An optional upstream identity/inspection hook may help, but needs a narrow,
mutually beneficial design and evidence before a PR is proposed.
