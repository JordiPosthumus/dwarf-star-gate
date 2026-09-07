# Operational evidence

The dashboard’s Evidence tab shows collection status and cache-cost evidence.
Fleet and Genie retain measured throughput, hardware telemetry, energy coverage,
request outcomes, queued handovers and action receipts.

`GET /api/request-history` is a same-origin, read-only endpoint. Its bounded
reader joins operational request events from `runtime/requests/` beside the
configured state file. It reports missing or incomplete evidence explicitly.
The journal does not store raw prompts, answers or tool arguments. Existing
`dataset_enabled` controls collection. Engine measurements remain separately
retained under `runtime/dashboard/`.

XGB models, numerical model features, embeddings, training, promotion, prediction
charts and predicted completion times were retired on 2026-09-07. Retired
`runtime/training/` data is not migrated into the operational journal.

Cache timing and reuse evidence do not prove residency or a backend cache hit
without attributable engine evidence. The passive historical routing observer
is still an unvalidated observation; it cannot choose a worker or move a request.

The cache audit uses `npm run cache-continuity:audit`. It reads the operational
journal and never submits inference, moves affinity or changes model settings.
See [cache continuity](cache-continuity-audit.md), [hardware telemetry](hardware-telemetry.md)
and [fleet throughput](fleet-throughput.md) for measurement limits.
