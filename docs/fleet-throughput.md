# Fleet throughput counters

One compact tile in the main gateway-status row. It replaces the former pool-
context headline: that setting remains available under **Manage DS4 servers**,
where it can be inspected or changed. The tile leads with last-hour output and
puts the other three values on one dense line; full definitions and evidence
coverage are available on hover or keyboard focus.

These are measured **completed request totals**, not predictions or instantaneous
GPU utilization. No Genie inference, extra model calls, new persistence or model-
server changes are needed.

| Counter | Definition |
| --- | --- |
| Output · last hour | Sum of valid server-reported `completion_tokens` for successful gateway responses ending in `(now − 60 minutes, now]`. Output includes thinking when counted by the server; input tokens are not added. |
| Peak rolling hour | Largest rolling 60-minute output sum among observed successful completions in the last 24 hours. Not a calendar-hour bucket, extrapolated burst or all-time record. |
| Completed · last hour | Successful gateway responses ending in that hour, including tool-call and output-limited responses. Requests are not sessions, agent tasks or completed projects. |
| Prompt tokens reused | Sum of valid `cached_tokens` for those completions. Reuse percentage is `sum(cached_tokens) / sum(prompt_tokens)` over the same known pairs—not the fraction of requests with a cache hit or an estimate of time saved. |

The whole usage total is credited at the **completion timestamp**. A response
running across an hour boundary can therefore appear as a large increase when it
finishes. Unfinished requests contribute nothing yet. Do not interpret these
counters as precisely how many tokens the GPUs generated during each hour.
Failed/cancelled/incomplete terminal outcomes are excluded, even if partial usage
was reported. All recorded DSG traffic is included, including Genie requests
using the normal pool; direct clients and a dedicated Genie endpoint are absent.

## Coverage and boundaries

The tile reuses the dashboard's read-only, bounded reader of the latest two daily
routing-evidence files. **Evidence collection must already be enabled.** It never
enables collection automatically or changes any private configuration. Disabling
collection, unreadable files and an incomplete reload produce dashes with a status,
not misleading zeroes. Existing collection/retention behavior is unchanged.

Each token counter shows its usage-report coverage. Missing, fractional, negative,
non-numeric and unsafe integer counts are unknown; a reported zero remains zero.
Cache counts larger than prompt counts are invalid. Sums beyond the safe integer
range remain unknown. Missing reports can make observed totals and peaks lower
than the fleet's true output; the UI never fills them with estimates.

At most 20,000 terminal records are indexed. Reader tail limits, malformed records,
conflicting duplicates and record-budget eviction are visible as partial history.
The most recent 24 hours of **observed records** are used; this is not a guarantee
that 24 hours were continuously recorded. No source data is deleted by these
in-memory display bounds. Peak windows at the oldest edge may have only partial
evidence. A dashboard restart reconstructs the counters from saved records.
File replacement/rotation rebuilds the display rather than adding old totals twice.

Deduplication uses gateway-run/request identity. Conflicting terminals invalidate
that request's contribution; different runs do not collide. Only scalar counts
leave the aggregator—no prompt text, embedding vectors or worker/session IDs.
The counters do not modify XGB inputs, validation gates, routing or client retries.

## Verification and activation

`npm run data:test` covers hourly boundaries, rolling peaks, missingness,
token-weighted reuse, duplicates, overflow, reader restart/replacement and UI
states. `npm run ui:screenshots` checks the real block with synthetic data at
desktop and mobile widths. The public screenshots are never live fleet evidence.

Activation needs **only a dashboard reload**, not a gateway or DS4 restart.
Coordinate that reload if a Genie review is active; private reports/settings may
need preservation under the normal dashboard-reload procedure.
