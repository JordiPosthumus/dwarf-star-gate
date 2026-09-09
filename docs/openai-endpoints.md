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

DSG does not select, substitute, translate or rewrite models. The entire request
body, including a present or absent `model` field, reaches the selected worker
unchanged. The backend decides whether to accept it. Backend errors are returned
to the client; they do not cause a retry on another model.

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
