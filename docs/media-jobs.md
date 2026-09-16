# Media jobs — implementation in progress

These endpoints currently provide the durable queue and retained downloads,
not a complete media service. Production has not enabled them. Engine
allocation, actual generation qualification and Genie controls remain to be
connected before normal use.

For an isolated development installation, `"media_jobs": {"enabled": true}`
enables a private `media-jobs.json` beside the gateway state file. The existing
gateway process lock owns both stores; no additional service or database is
needed. The normal gateway bearer key protects every endpoint.

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/music/jobs` | Queue native ACE-Step JSON parameters. |
| `POST /v1/video/jobs` | Queue a native ComfyUI JSON workflow envelope. |
| `GET /v1/music/jobs` or `/v1/video/jobs` | List recorded job status. |
| `GET /v1/music/jobs/{id}` or `/v1/video/jobs/{id}` | Read a saved job and any native result metadata. |
| `GET /v1/{music\|video}/jobs/{id}/files/{file_id}` | Download a retained output using the normal gateway bearer key. |

Each POST needs `Content-Type: application/json` and an `Idempotency-Key` of
1–200 printable characters. Reuse the same key when reconnecting or retrying a
submission whose response was lost. The same request returns the original job;
different content or priority with that key returns HTTP 409. A new job returns
HTTP 202 with its ID and status URL. Keys apply across both media routes.
The existing `x-dsg-priority` header accepts `high`, `normal` or `idle-only`;
priority orders waiting jobs only and never cancels active generation.
JSON submissions may be up to 2 MiB; binary asset upload is not implemented.

Status distinguishes gateway `queued`, native `submitting`/`submitted`,
`pending`/`running`, `completed`, `failed` and `uncertain`. ACE-Step's native
pending status does not distinguish queued from running. A completed native
job may contain result metadata before its files are retained. The coordinator
must call output collection and require `outputs.state: ready` before releasing
that engine. Files are streamed into private storage with size and SHA-256
receipts; status includes gateway download URLs. They remain downloadable after
the native engine stops and the gateway restarts. Failed copying is separately
visible as `outputs.state: failed`, and retrying collection fetches the original
result without repeating generation. No automatic file deletion is performed.
These behaviors are verified against HTTP fixtures; real engine qualification
is still pending.

Before a native submission, the queue saves its intent and selected worker.
The future allocator must first acquire that host through the existing
maintenance path, preserve at least one healthy serving LLM, and verify the
media engine is ready. The queue itself has no host shutdown authority.
If acknowledgement is lost, it does not resubmit. A known native ID can be
observed on the original engine; missing history is not proof of completion.
Prompts and receipts remain private runtime data, and status responses omit
the submitted payload. No automatic deadline cancels accepted media jobs.
