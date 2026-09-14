# Per-worker gateway concurrency

A worker has an explicit `max_concurrent_requests` capacity, defaulting to 1.
This is the number of model requests Star Gate may dispatch to that endpoint
at once. It does not change the engine's batching, memory, context, output,
thinking, cache or launch settings. A healthy endpoint alone does not prove it
can generate concurrently.

Independent conversations can fill separate slots. Dependent turns in one
conversation remain ordered, including when a later turn has higher priority.
Each occupied slot retains its own conversation-turn allowance. Waiting work
uses the same High/Normal/Idle-only rules, and no priority change interrupts an
active stream. Drain, recovery and removal checks account for every active
request. The dashboard counts request slots rather than treating each worker
as exactly one slot.

Health probes use a separate HTTP connection, so occupied inference connections
cannot prevent a responsive backend from receiving its health check. Existing
health deadlines and compatibility checks still apply.

For a newly registered or file-configured worker, the capacity is an optional
worker field. Saved worker registrations take precedence over initial config.
For an existing worker, pause it, let all admitted work finish, and use
**Settings → Manage servers → Capacity**. Saving leaves it paused. Resume
it separately after the intended server setup and capacity are verified.
The operation backs up saved state, checks the expected old value and persists
only that worker's gateway capacity. It does not restart an engine.

The private control socket accepts `POST /set-worker-concurrency`:

```json
{
  "id": "worker-a",
  "expected_max_concurrent_requests": 1,
  "max_concurrent_requests": 2
}
```

The dashboard equivalent is `/api/workers/concurrency` with the existing
same-origin/CSRF controls. General inference and scoped agent credentials do
not grant this operation. After an ambiguous reply, read the current value;
do not replay an edit blindly.

## Qualification and current scope

Gateway tests use synthetic endpoints to prove concurrent dispatch, exact
payload forwarding, conversation ordering, priority, cancellation isolation,
capacity accounting, state preservation and the absence of a hidden 16-socket
limit. This establishes gateway behavior, not a model server's capacity.

Before enabling additional capacity on a real worker, verify its actual engine
configuration and ability to handle the overlapping requests with established
context, output, thinking and cache behavior preserved. Retain the approved
configuration and a rollback path before changing an engine.
No real worker has been qualified or enabled by these synthetic tests.

The existing passive serial timing estimator retains observations but does not
invent a completion-time estimate for concurrent workers. Model/engine metrics
still need evidence of their scope: a single observed token rate is not a
per-request measurement when requests overlap. No new predictor is added here.

The integrated request-progress checks also cover two running Genie replies and
one queued reply on a two-slot synthetic worker. Each reply keeps its own gateway
request identity as a slot becomes free. These checks exercise gateway scheduling
and observation; they do not qualify a real model server for concurrent inference.
