# Per-worker serving defaults

`config.local.json` can opt workers into `serving_profiles`, keyed by worker ID.
The profile follows the selected worker on both pinned routes and pool dispatch.
It does not change endpoints or the server's model, kernel, MTP or concurrency.
The gateway status includes the loaded profiles; model metadata publishes input,
reasoning and output capabilities.

The current Qwen Spark profile uses context/output ceilings of 262144, text and
image input, and reasoning support. Its `defaults` contains temperature 1,
top_p 0.95, top_k 20, min_p 0, presence_penalty 0, repetition_penalty 1, and
`chat_template_kwargs` with enable_thinking true, preserve_thinking true and
reasoning_effort xhigh.

For unencoded `/v1/chat/completions` JSON requests, DSG fills omitted sampling
and thinking fields. Explicit values, including zero, false and null, survive.
An explicit top-level reasoning_effort is preserved without adding a competing
nested effort. Thinking disabled requests do not acquire a default effort.
Explicit invalid or conflicting options remain the backend's responsibility.
No output allowance is injected or clamped: max_tokens/max_completion_tokens
remain per-request values, subject to the server's actual remaining context.

Message, image and tool values stream without whole-request buffering. Only
small thinking metadata is retained for merging. Encoded bodies, other API
routes, and unusually large thinking metadata (over 64 KiB) pass through without
profile merging on that opaque content. Unprofiled workers retain passthrough.

This is a DSG default policy, not a Pi installation. Pi compaction, retries,
idle timeouts and client compatibility settings stay in the client. Applying
configuration requires a gateway core restart; the continuity door waits for
existing work to finish. Worker pauses are preserved.
