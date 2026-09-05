# Cache-continuity four-path shadow

**Implemented as a pure, offline comparison primitive. It has no routing or
cache authority and is not yet fed from live requests.** DSG can compare four
possible ways to finish a request without pretending that missing evidence is
free:

1. wait for the server with the hot cache;
2. restore a compatible local disk snapshot;
3. acquire and import a compatible snapshot from another server; or
4. prefill the prompt cold.

The implementation is deliberately separate from the scheduler. It accepts only
bounded numerical evidence and worker IDs, emits a shadow result, and cannot read
prompts, invoke a model, move a cache or change affinity.

## Critical-path arithmetic

For the same request and generation target, the comparator uses:

| Path | Estimated completion time |
| --- | --- |
| Wait hot | `wait + suffix prefill + generation` |
| Local restore | `wait + restore + suffix prefill + generation` |
| Remote acquisition, serial | `wait + transfer + import/restore + suffix prefill + generation` |
| Remote acquisition, verified staging overlap | `max(wait, transfer) + import/restore + suffix prefill + generation` |
| Cold prefill | `wait + cold prefill + generation` |

Transfer may overlap waiting only when that staging behavior has been
independently verified. Otherwise the serial expression is mandatory. A measured
component, a validated forecast and an unvalidated estimate retain distinct
labels; composing bounded components does not itself validate the end-to-end
forecast.

RAM residency does not eliminate the new prompt suffix. The hot path requires an
explicit `suffix_prefill` component, including an evidenced zero for no suffix;
omitting it makes the path unknown instead of silently treating that work as free.

Each path is `estimated`, `excluded` or `unknown`. Proven cache absence,
incompatibility or protocol unavailability can exclude a path. Missing or stale
evidence makes it unknown. Any unknown path suppresses `would_prefer`; DSG may
still report `best_known` for diagnostics, but that is not a scheduling decision.

## Snapshot evidence boundary

The helper can join a private installation-keyed HMAC snapshot reference against
a fresh private inventory. It never returns that reference. Presence requires a
fresh compatible header match. Absence requires a complete, uncapped scan with
zero rejected cache-shaped files. A stale, capped or partially unreadable scan,
or a legacy zero weights fingerprint, abstains.

Multiple entries with the same keyed snapshot reference are ambiguous, even if
the first header matches: entry ordering must not determine compatibility.
Absence also requires an explicit `capped: false`, not a missing or malformed
completeness flag. An unambiguous compatible match can still establish bounded
presence within an otherwise capped scan.

Inventory traversal is bounded to 16,384 directory entries and 4,096 cache
headers per scan. Unrelated files count toward the traversal budget. Hitting
either cap makes absence inconclusive; no cache files are changed or removed.

This is stronger than treating “not found” as absence and keeps a permissions or
filesystem problem from becoming a routing claim.

Both source and target profiles must fit the header's encoded field ranges:
an unsigned 8-bit model ID, unsigned 24-bit weights fingerprint, supported
quantization and positive unsigned 32-bit context. Matching invalid integers
cannot prove compatibility—or incompatibility. A zero weights fingerprint still
means legacy unknown weights. Valid cross-quantization comparisons retain DS4's
explicit policy. Even a valid bounded header match is not proof of full model,
vision or payload portability; it does not authorize a transfer or restore.

## Why it is not live yet

The [stock-cache feasibility note](cache-transfer-feasibility.md) records the
existing loading path, sensitive-data boundary and proposed isolated canary.
It does not enable copying or claim cross-backend compatibility.

Three inputs are still missing:

- Stock DS4 does not currently expose an exact privacy-safe rendered-prefix
  identity for the live request through DSG's existing protocol. Text similarity
  is not cache identity.
- No generic enrolled remote transfer/import protocol has been implemented or
  validated. Remote acquisition therefore remains unavailable in production.
- Queue, restore, transfer, suffix-prefill and generation components still need
  matched future validation by hardware, context and cache regime.

Until those gates are satisfied, this module is a testable decision contract—not
an automatic cache mover. The next safe step is to produce bounded live shadow
records only where all required identities and components can be proven, then
compare the forecast with the realized outcome before considering scheduler use.

The separate [cache-continuity audit](cache-continuity-audit.md) now supplies a
privacy-safe realized baseline: aggregate reuse ratios and exact abstention
reasons for consecutive same-session work. It deliberately does not manufacture
the missing snapshot identity, remote protocol or unchosen-path outcome needed to
feed this four-path comparator live.
