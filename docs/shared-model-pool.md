# Shared and explicitly selected models

The default pool can contain compatible LLM endpoints with different native model names. Each member must meet the pool's context guarantee and support the request format used by its clients. Set `model_aliases` only when an engine requires translation of the client model name to its native ID. Translation currently streams the rewritten request using HTTP chunked transfer, so verify that the engine accepts that framing before enabling it.

Workers with `route_only: true` are reserved for explicit `x-dsg-model` routes. Omit that flag or set it to `false` to admit a compatible worker to the shared pool. This changes gateway eligibility, not the model's launch settings. Preserve each worker's configured `max_concurrent_requests`; a service spanning two machines still has one endpoint capacity, not that capacity per machine.

Default model discovery publishes the pool context guarantee. Explicit routes publish the minimum configured context of their member endpoints. A model with a larger context can therefore join a smaller-context pool while retaining its larger context through its explicit route.

Before admission, verify real requests in the existing client's format, including streaming tool calls. A health probe or a short arithmetic response alone does not establish image support, long-context behavior, cache reuse, or compatibility with every client API. Drain gateway work before changing saved worker definitions; keep the continuity front door and an existing usable LLM available. Model servers need not restart merely to join the pool.
