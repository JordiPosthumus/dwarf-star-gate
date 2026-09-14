# Queue priority

Star Gate accepts three explicit classes for model requests:

| Priority | Waiting behavior |
| --- | --- |
| High | Ahead of lower-priority eligible work on compatible capacity. |
| Normal | Default when no priority is supplied. Ahead of idle-only work. |
| Idle only | Runs when no higher-priority eligible request is ahead of it on that worker. Once running, it finishes normally. |

In **Gate Genie → Current Jobs**, choose a priority beside a waiting request. Running
requests show their priority without an edit control. Controls must be enabled
for the installation. A request that starts, finishes or changes priority after
the page was read rejects a stale edit; refresh shows the current state.

Clients can supply `x-dsg-priority: high`, `normal` or `idle-only`. Omission means
normal. Other values are rejected with HTTP 400 before dispatch. The gateway
removes this header before forwarding to the model server. Request content,
reasoning and output settings are not used to infer priority or changed by it.
The choice applies to that request only; it is not a persistent conversation
preference. A retry submitted as a new request uses its supplied header again.

## Continuity and ordering

- Priority never cancels, pauses, restarts or migrates an active model request.
- Earlier requests in the same conversation remain ahead of later requests, even
  if the later request is high priority. Use stable conversation IDs for dependent
  turns and distinct IDs for independent work.
- Within a class, existing conversation-turn allowances and FIFO ordering apply.
  A higher-priority eligible request can displace a lower-priority turn reservation.
- Compatibility, conversation ownership, pauses, maintenance holds and existing
  affinity/handover checks still apply. Priority does not select another model,
  copy a cache or make unavailable capacity available.
- Waiting priority edits preserve the request body, queue deadline, original
  arrival time and conversation sequence. They do not grant an extra waiting period.
- Genie uses the same explicit classes. Its existing owner-question interruption
  of its own scheduled assessment remains a separate, unchanged behavior.
- An uninterrupted stream of higher-priority work can delay lower-priority work.
  There is no hidden automatic promotion or content classifier.

Each worker defaults to one active request. [Explicit concurrent capacity](concurrency.md)
can serve independent conversations in separate slots after qualification.
Priority itself does not change engine concurrency or qualify a server.

## Local control API

`GET /current-jobs` on the private control socket includes
`queue_priority_version: 1` and a `priority` field per request. The dashboard's
same-origin `GET /api/current-jobs` adds a CSRF token and
`priority_edit_enabled`. General inference status and diagnostics continue to
exclude request previews.

The local control socket accepts `POST /set-job-priority` with exactly:

```json
{
  "request_id": "the-current-request-id",
  "expected_priority": "normal",
  "priority": "high"
}
```

The dashboard's equivalent is `POST /api/current-jobs/priority`, requiring JSON,
the same-origin session and `x-dsg-csrf`. Neither route is exposed through the
inference endpoint. Existing scoped agent credentials do not grant this control.
A stale or running request returns a conflict from the core. Edits are never
replayed automatically after a lost control response; read the current state.

The retired Priority Lens classifier, weighted scheduling, saved preferences and
Proactive Resume are not used by this feature.
