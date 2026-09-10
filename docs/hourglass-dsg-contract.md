# Hourglass → DSG forwarding contract

Use DSG's public Continuity Door for inference, or its [Testing endpoint](testing-mode.md) when Testing is enabled. The synthetic regression suite exercises the Door, gateway and mock OpenAI backends together. It does not certify a particular deployed backend's parameter resolution or model quality.

## Connection

- Base URL from the gateway host: `http://127.0.0.1:30000/v1`, or `http://127.0.0.1:30000/testing/v1`. Remote clients need an authorized connection to the gateway host.
- Authentication: the existing DSG ingress credential, supplied privately.
- Fixed worker selection: configure a single-worker `model_routes` entry and send `x-dsg-model: <route-name>` on every request, continuation and client retry.
- Conversation identity: send a stable `x-session-affinity` value across the conversation's requests, distinct from other conversations. This enables the [consecutive-turn allowance](conversation-turns.md).
- Body `model`: a native backend identifier or explicitly configured alias. The route header selects eligible workers; the body selects the model.
- Encoding: use ordinary uncompressed JSON for model alias translation. Encoded bodies pass unchanged and must use a native identifier accepted by the backend.

Routes retain worker health, pauses and queue deadlines. A missing route header uses ordinary pool routing; a body model alone does not pin a worker. Record `x-ds4-node` from actual responses to verify the serving worker. Validate the route map and deployed source before relying on a fixed-worker experiment.

## Synthetic forwarding coverage

`ds4-gateway/hourglass-forwarding.test.mjs`, included in `npm test`, verifies:

- Request bytes survive except for an explicitly configured top-level model alias. Whitespace, Unicode, zero/false settings, nested thinking controls, tools, output budgets and omitted fields survive.
- Incremental uploads reach the backend before upload completion.
- JSON and SSE bodies, reasoning, tool-call content, backend status and response headers are preserved.
- Continuation messages remain on the declared route. A single-worker route does not escape to the pool through pauses or conflicting old affinity.
- Unsupported-parameter errors remain errors. An ambiguous disconnect does not trigger a second upstream execution.
- DSG ingress authentication is stripped, backend authentication is applied, and the routing header does not leak upstream.
- Testing uses the same forwarding path after removing its endpoint prefix.

## Limits

DSG does not establish whether sampling settings are scientifically appropriate or actually consumed by a backend. Follow the [backend onboarding guide](server-setup-guide.md) to distinguish requested values, server-resolved values and directly exercised behavior.

Existing vision recovery can transcode JPEG, remove GIF images, trim excess images or retry a transformed request; some failures become guidance responses. A run that triggers those protections must not be described as unchanged input forwarding. Testing does not disable them. Any proposed opt-out needs a separately reviewed configuration change.

Backend errors do not authorize dropping settings. Ambiguous transport failure does not authorize replaying a benchmark turn. Keep real deployment receipts, measurements and client configuration in private operational records.
