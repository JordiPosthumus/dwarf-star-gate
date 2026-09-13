# Fleet speed and energy history

The **Fleet history** tile shows observed decode and prefill speeds for a
browser-local **1h / 12h / 24h** selection (default 12h). Each gauge is an
observed, duration-weighted mean, not combined fleet throughput or a benchmark.

## Measurement sources

- **vLLM:** difference completed-request token and phase-duration histograms.
  Prefill excludes cached KV tokens. Decode includes thinking and answer tokens.
  Matching completion counts, monotonic counters, a stable engine epoch and
  adjacent successful polls are required. The entire observation belongs to the
  window in which completion was observed, even if the request began earlier.
  Concurrent completions contribute their summed request-seconds; those seconds
  must not be mistaken for a wall-clock interval or utilization.
- **Native engine logs:** difference cumulative token and elapsed-time counters.
  Clip token/time intervals proportionally at window boundaries.
- **oMLX:** integrate adjacent reported active-rate samples, only when both
  samples show the relevant phase. These remain sampled rate estimates, not
  measured token totals. Prefill uses reported chunk speed; decode uses the
  reported active-request average. Their scopes differ from vLLM engine timings.

Aggregate speed is total token/time contributions divided by contributing
seconds. oMLX samples weight reported rates by observed sample duration. It is
an operational summary of different workloads and measurement scopes, not a
comparison under identical conditions. Missing history contributes neither
zero speed nor idle time. A measured zero-token prefill displays **0**, while
missing measurements display **—**. Empty gauges have no colored zero-dot.

Endpoint measurements are appended as numeric `endpoint_phase` rows to the
existing daily metric files. History survives dashboard restarts, without
replaying old completions or importing lifetime averages into a shorter window.
Endpoint history begins with this collector's activation. Earlier endpoint
history cannot be reconstructed from the former 15-minute rate-only charts.

Gauge ceilings use the padded, rounded 24-hour 95th percentile of valid rates.
Thin outer activity arcs apply only to native timing intervals. They are hidden
for completed-request or sampled-rate evidence, which cannot establish honest
fleet phase occupancy. The footer counts servers with any valid selected-window
speed evidence; it does not claim complete coverage. Click it for phase-specific
server counts, measurement methods and energy details.

## Energy

The compact footer shows estimated kWh only when every current worker has at
least 80% measured-power coverage with one consistent measurement scope.
Otherwise **kWh*** means a measured subtotal, explained in the clickable details.
Without eligible power data it says **Energy unavailable**.

Adjacent power samples are integrated trapezoidally. Gaps over 60 seconds,
scope/sensor changes and engine restarts break adjacency. Window boundaries
clip the linear power curve. GPU-only readings are excluded from whole-device
energy; system and compute-module readings have different physical boundaries.
Removing a worker removes its energy from current-fleet totals. No TDP or token
speed is substituted for measured watts. Incomplete or sampled token evidence
is not presented as fleet energy efficiency.

## Retention, privacy and validation

The reader incrementally processes the two newest `metrics-YYYY-MM-DD.jsonl`
files with bounded lines, bytes and intervals. Rotation or replacement triggers
a rebuild; duplicate observations are rejected. Endpoint records contain only
worker ID, source, timing, counts, scope and a hashed sample ID. They contain no
URL, credential, prompt, response or request identifier. Other metric readers
ignore the new row kind. Existing native and energy measurements are preserved.

`fleet-speed.test.mjs` exercises histogram differencing, weighted means,
completion-window boundaries, counter resets, outages, source scopes, duplicate
replay, restart persistence and energy coverage. `request-history.test.mjs`
checks the rendered gauge values, zero/missing states and short footer.

Activation requires only a dashboard reload. Model servers, routing, caches,
context, concurrency and conversation-turn settings are unchanged.
