# OpenAI-compatible workers

DSG can forward its existing inference routes to OpenAI-compatible servers on
Macs, Sparks, or other hosts. Select **OpenAI-compatible** when registering a
worker in the dashboard, or use the CLI:

```sh
./workers.sh add local-mlx --backend openai --url http://127.0.0.1:8013/v1
./workers.sh add spark-vllm --backend openai --url http://127.0.0.1:38003/v1 \
  --ssh Spark --remote-port 8000 --context-length 262144
```

Registration checks availability and capacity and leaves the worker paused,
as before. Resume it when it should receive pool traffic. Direct HTTP and HTTPS
base URLs are supported; a base URL may contain a path such as `/api/v1`.
An SSH worker still uses a local loopback tunnel and the configured SSH aliases.
HTTPS uses the system/Node trust configuration and verifies certificates.

## Model handling

By default DSG forwards model names unchanged. An explicit worker setting such as
`"model_aliases": {"qwen3.8-flash-next": "Qwen3.8-Flash-Next-MLX-8bit-MTP"}`
lets clients use one pool name across differently named deployments. Configure the
same alias on every participating worker. Only the top-level model string is
rewritten; messages, tools, images, generation settings and streaming uploads
are preserved. Unknown or absent names remain unchanged. Health checks require
mapped model IDs to exist. Backend errors never trigger a retry on another model.
Aliases are visible under each endpoint in Manage Servers. Model-list metadata
includes aliases supported by the selected worker; response model IDs remain native.

Set `"model_agnostic": true` in the pool configuration to remove the legacy
configured-model identity check for all workers. Generic OpenAI-compatible
workers always use model-agnostic discovery. The existing `model` configuration
field remains a legacy pool label; it is not a model-routing rule in this mode.
Existing placement, per-worker queues, conversation affinity and continuity
behavior are unchanged.

`GET /v1/models` continues to proxy one available worker's model list. It is not
a fleet-wide catalogue, and advertising a model does not reserve a worker for
that model. Clients should use the backend conventions appropriate to the pool.

## Context

The pool retains one configured context guarantee. A worker must meet it before
becoming available. DSG recognizes `context_length`, oMLX/vLLM's `max_model_len`,
and `top_provider.context_length` in model-list entries. When an endpoint lists
several models, the smallest reported capacity is used.

OpenAI model lists are not required to report context capacity. Supply the
worker's verified serving limit with the **Context length** registration field
or `--context-length` when it is absent. That declaration cannot override a
smaller reported limit. Missing capacity remains unknown until supplied.
The value must describe the server's effective configuration, including all
models it may serve; model names alone do not establish that configuration.

The pool context is exposed consistently in `context_length` and, when present,
`max_model_len` and `top_provider`. DSG does not retokenize or truncate requests,
resize backend caches, change generation limits, or change client compaction.
Backend context-overflow errors remain backend errors.

## Authentication and management

For a protected endpoint, put its bearer token in a private file on the gateway
host (mode `600`), and register the absolute path using **API token file** or
`--api-key-file`. The file is read during health checks, so rotation does not
require persisting the token in the worker registry. The registry stores only
the path. Missing or invalid credentials make the worker unavailable.

DSG's client credential is never forwarded upstream. A worker receives only its
own configured bearer token. Token values are not included in status or logs.

Generic endpoints do not automatically inherit DS4 journal collection or
native service recovery. Existing DS4 recovery enrollment remains intact.
Generic inference, streaming, tool calls, cancellation and usage observation
work through the existing proxy; optional telemetry stays unknown when the
backend does not expose it. The backend must implement each requested API
route; DSG does not translate Chat Completions into Responses or Messages.

## Explicit Pi model routes

For per-model placement without buffering a large request before dispatch, Pi
model entries send `headers: {"x-dsg-model": "<model ID>"}`. Configure DSG with:

```json
{
  "model_routes": {
    "qwen3.8-flash-next": ["spark1", "spark2", "m3-studio"],
    "Qwen3.8-Flash-Next-MLX-8bit-MTP": ["m3-studio"]
  }
}
```

The header selects the route; the request body model still selects the native
model (with configured aliases). Pi's two model entries set both together.
These are placement preferences, not separate authentication permissions.
Requests without this header retain existing behavior; a body model alone does
not impose a worker restriction. An unknown header value is rejected before
upstream dispatch. DSG strips the header at the worker boundary.

Eligibility applies to initial placement, waiting, conversation-home changes,
and automatic/operator/Genie queue relocation. An M3-only request waits when
M3 is unavailable and retains the existing queue deadline and cancellation
behavior; it cannot fall back to a Spark. Changing a session's choice waits for
its outstanding turn before changing worker. Returning to the shared choice
can retain its M3 home for cache locality. No model settings or payload budgets
are changed by routing.

Install server configuration and restart only during an authorized maintenance
window, then install the matching Pi entries. Reload Pi or start a new session.

## Endpoint telemetry

The dashboard polls OpenAI-compatible workers read-only, independently of
DwarfStar's journal/file timing readers. vLLM uses `/metrics`; oMLX uses the
authenticated `/api/status` endpoint. Credentials stay in the existing private
token file. Polling never changes admission, starts models or issues inference.
Generic endpoints do not inherit DwarfStar log paths. Returning a worker to
backend `ds4` restores its existing configured DwarfStar telemetry source.

Endpoint cards label engine-session averages explicitly. vLLM prefill uses
computed KV-token totals divided by prefill seconds; decode uses generated-token
totals divided by decode seconds. vLLM also displays an interval generation
rate, which includes idle time in that polling interval. oMLX additionally reads `/admin/api/activity` for live prefill progress and
generation counts/rates (including reasoning). If needed it authenticates with
the existing endpoint credential; the session cookie stays only in dashboard
memory. Without live-activity access it labels the available session averages. These aggregates are
kept separate from DwarfStar's historical gauges and workload-matched performance
comparisons rather than being presented as equivalent samples.

Engine-reported active work can exist without a DSG request (direct clients or
cleanup); the card shows that separately without inflating DSG admission counts.

Live endpoint rate graphs retain up to 15 minutes in dashboard memory, with a
maximum of 1,024 points per worker. Only observed live rates enter these graphs;
engine-session averages do not. Gaps are compressed and are not proof of idle.
A dashboard restart clears this short live history. vLLM samples describe token
counter changes over the poll interval; oMLX rates are sums of the active
requests' reported average rates, not matching wall-clock interval measurements.
Mixed prefill and generation activity is displayed explicitly. The historical
fleet gauges remain DwarfStar-only and are labeled **DwarfStar history**.

Chat-template `enable_thinking` and `reasoning_effort` are observed as requested
settings. The UI does not claim these establish the engine's effective thinking
mode. This metadata observation requires the updated gateway code to be loaded;
restarting the dashboard alone cannot capture additional request fields.

Recent completed Chat Completions responses that report `stop` but contain no
observed answer or tool characters produce a dashboard warning. Reasoning-only
and entirely empty output are distinguished using saved character counts, with
no raw response text retained by this warning. Warnings cover a bounded recent
hour, depend on request-history recording, and are not a semantic-quality
assessment. They never trigger retries, quarantine, or admission changes.

Alias rewriting applies to unencoded JSON uploads. Identity aliases preserve
original bytes, including JSON escape spelling. Encoded uploads pass unchanged;
clients using compressed bodies must supply a native model name accepted by the
selected backend. Do not rely on body aliases to translate compressed payloads.
