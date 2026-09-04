# Cache acquisition: measured component baseline

**Implemented, read-only, unvalidated. No routing or cache mutation.** The
Analytics panel includes a cache-cost calculator for one hypothetical server,
cache tier, cached-prefix length and total prompt length. It uses the existing
DS4 timing feed; it does not call an LLM, copy a cache, or run a benchmark.

The useful decision is eventually: **wait for the hot server, restore a local
snapshot, fetch a remote snapshot, or prefill cold**. Choose the safe feasible
option with the shortest expected completion time, not merely the highest
decode speed. This first calculator supplies measured components of that decision.

## What is measured

| Component | Evidence and current estimate |
| --- | --- |
| Local disk payload load | DS4 `kv cache hit ... tokens=... load=... ms`; mean of comparable recent observations on this server |
| Suffix or cold prefill | A matching observed `prompt start` / `prompt done` pair, including cached, total and new-token counts |
| Hot lookup / synchronization | Unknown; not silently assumed free |
| Remote transfer and import | Unknown; no transfer calibration or compatible-cache inventory yet |
| Queue and generation | Separate costs, not included in this calculator |

The disk timer in [Antirez's KV implementation](https://github.com/antirez/ds4/blob/main/ds4_kvstore.c)
starts after prefix search. It includes file opening, validation/payload loading
and related work inside that function; it does not prove that later engine
synchronization is covered. Consequently `total_acquisition_ms` remains null.
`measured_components_ms`, when present, sums only the observed load/prefill parts.
Do not add those parts to an end-to-end service estimate that already includes them.

Per server, retain at most 128 samples from the last hour. Estimates require at
least three observations in the same power-of-two token-size bucket. Prefill
also matches the total-prompt bucket and whether any prefix was reused; warm
prefill observations are not cold-prefill labels. The arithmetic mean and
observed min/max are descriptive estimates, **not confidence intervals**. No
cross-server pooling, rate extrapolation or semantic-similarity lookup occurs.
Restarting the dashboard rebuilds observations from its available log tail.

## Important limitations

- A scenario does **not** establish that its cache exists, is resident, is
  compatible, or belongs to that request. Similar text is not KV identity.
- Systemd journal timing events now carry a privacy-safe backend process epoch.
  A local stock DS4 log may carry a weaker, bounded epoch when its timestamped
  listen marker is present in the latest bounded startup scan. A proven epoch
  change clears component samples, so those observations do not mix process
  lifetimes. Missing service/marker evidence remains unknown. Timing events still
  lack a protocol request ID; the separate correlator can only produce bounded
  candidates, so these remain component observations rather than cache-hit labels.
- Missing, sparse or stale measurements produce **unknown**, never a zero cost.
  A disconnected feed, unhealthy server or stale gateway snapshot rejects the
  calculation. Scenarios cannot exceed a known worker context capacity.
- Direct traffic may also appear in engine logs. The estimator does not attribute
  it to DSG or accuse a particular route of causing a miss.

For local integrations, `GET /api/cache-cost` on the dashboard takes `worker`,
`tier` (`local_disk`, `cold`, `hot`, `remote`), `cached_tokens`, `prompt_tokens`.
It is same-origin/read-only and exports numerical component evidence, not paths
or request text. Deployment data remains private even when this API is local.

## Next evidence, not another speculative model

Follow the [stock DS4 integration boundary](ds4-integration.md): extract existing
API/log/OS evidence, without editing the engine. If attribution cannot be proved,
keep the component estimate and the uncertainty; do not force a guessed join.

1. Measure the implemented shadow correlator's yield across real backend process
   epochs, preserving every ambiguity and direct-traffic conflict as an
   abstention. Exact protocol identity remains unavailable.
2. Inventory compatible snapshot identity and measure lookup/restore/import
   boundaries, including real cold-to-warm verification.
3. Evaluate estimates against later observations; add uncertainty and abstention
   by hardware, context and cache regime.
4. Compose acquisition, residual busy time and generation costs in shadow.
   Only then consider a cache-aware handover policy.

Unit tests exercise span matching, freshness, sample bounds, distinct cold/warm
regimes, unknown tiers, API validation and unchanged read-only authority.

## Privacy-safe snapshot inventory

**Implemented as an opt-in local/mounted-directory foundation; it does not route
or transfer caches.** Stock DS4 disk-KV files begin with a 48-byte compatibility
header and four-byte rendered-text length. Verbatim prompt bytes follow. DSG opens
only regular 40-hex cache files with no-follow semantics and reads exactly those
first 52 bytes. It validates magic/version/payload ABI, quantization, token count,
file bounds and numerical metadata before accepting an entry.

The filename is a SHA-1 of a rendered prompt prefix and is therefore sensitive to
dictionary guessing. DSG never exports it. A private installation key converts it
to an HMAC pseudonym that is comparable across explicitly inventoried directories
inside one DSG installation but useless to another installation. Local
diagnostics expose only aggregate cohort count, byte and maximum-token summaries;
paths, raw names, pseudonymous snapshot references and prompt bytes remain absent.

Compatibility follows DS4's conservative header gates: model shape, target
context capacity, quantization policy and same-quant weights fingerprint. A legacy
zero weights fingerprint is **unknown**, never compatible. Header agreement is
still bounded evidence: it does not prove a cache is currently resident, that a
request matches the byte prefix, or that a remote transfer/import path is safe.

Configure only a directory already readable on the dashboard host:

```json
"cache_directories": { "worker-a": "/srv/ds4/cache" }
```

Scans run no more than once per minute and examine at most 4,096 cache-shaped
files. Missing, symlinked, unreadable, oversized or invalid inputs abstain. The
scanner performs no inference and no writes to the DS4 directory. The next stage
now has a pure [four-path shadow comparator](cache-continuity-shadow.md). It
compares wait-hot, local-restore, remote-acquisition and cold-prefill critical
paths while preserving unknown evidence. It is not yet fed from live requests;
no remote command, copy protocol or automatic routing is claimed.
