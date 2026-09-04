# Fleet speed and energy pulse

The compact **Fleet speed** tile in the main status row is a quick feel for the
value the fleet is delivering. It shows decode and prefill on two calibrated
semicircular gauges, with a browser-local **1h / 12h / 24h** selector. Twelve
hours is the default: long enough to smooth one unusual request, short enough to
notice a real change in the fleet.

The large arc is a duration-weighted **active-phase mean**, not a mean of sampled
log lines. DSG first differences DS4's cumulative token and elapsed-time
counters, then divides total observed tokens by total active seconds. A long
request therefore contributes in proportion to real work instead of dominating
the metric merely because it emitted more telemetry rows.

The thin outer arc is a conservative activity-coverage indicator: observed phase
seconds divided by selected wall-clock capacity across the currently registered
devices. It answers “did the fleet actually spend much of this period doing this
kind of work?” It is a lower bound because missing telemetry remains unknown,
never idle.

Each gauge is calibrated to a padded 24-hour p95 of its own valid interval speeds,
rounded to a readable scale. Decode and prefill do not share a scale. The numeric
tokens/second value is authoritative; the arc is deliberately a feel-at-a-glance
display, not a hardware benchmark or utilization meter.

## Tokens, energy and efficiency

The footer reports observed generated tokens for the selected period. Once the
optional hardware lane supplies sufficiently dense, measured power for **every
current device**, it also reports:

- estimated kWh over the selected period;
- generated tokens per estimated kWh.

This makes additional Sparks legible as fleet value rather than just capacity:
more work, more energy, and the efficiency relating the two. DSG integrates
adjacent measured watt samples and refuses to bridge gaps longer than one minute.
It estimates a full-period total only when every current device has at least 80%
measured coverage; the tooltip discloses coverage and measured energy. Until
the optional [hardware adapters](hardware-telemetry.md) are configured and meet
that threshold, the UI says **energy awaiting power data**. It does not
substitute a device TDP, infer power from token speed, or present missing devices
as zero watts.

The token total covers observed decode intervals from DS4 engine timing evidence.
It is distinct from the older completion-time usage counters: unfinished but
observed generation can contribute here, while missing intervals can undercount.
Direct traffic appears only if it enters the same allowlisted engine metric lane.

## Reader and privacy boundaries

The dashboard reads only the two newest `metrics-YYYY-MM-DD.jsonl` files through
a bounded, incremental, read-only parser. It accepts a small allowlist of numeric
DS4 timing/power fields, caps lines and bytes per pass, handles rotation or
replacement by rebuilding, and publishes aggregate values only. Worker names,
session identifiers, prompt text, response text, vectors, endpoints and paths do
not enter the browser summary.

Malformed rows, counter regressions, engine-epoch changes, partial history,
collector gaps and unavailable files fail closed. Dashes or an explicit waiting
message replace misleading zeroes. The feature changes no model server, routing
decision, XGB input, Genie permission or client retry behavior.

## Verification and activation

`npm run data:test` covers cumulative-counter differencing, weighted means,
window boundaries, reader replacement, malformed input, bounded state and the
per-device measured-power coverage gate. `npm run ui:screenshots` verifies the
real selector, polling persistence, reload persistence, gauge labels, tooltip and
energy footer with synthetic data. Public screenshots are not live fleet
evidence.

Activation needs only a dashboard reload, not a gateway or DS4 restart. The
fleet pulse itself remains available when hardware collection is off.
