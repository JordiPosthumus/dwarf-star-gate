# Optional upstream observability opportunities

Research note, checked 2026-09-04. No DS4 patch, PR submission, deployment or
required fork is implied. DSG must continue working with stock DS4.

## Bounded request correlation

At inspected upstream revision
[`b0a147a`](https://github.com/antirez/ds4/blob/b0a147a7fba6d1a104d047d5a140e9bb4bfc13cd/ds4_server.c#L13347),
the HTTP request structure retains method, path and body, but no client request
ID. The parser reads Content-Length and copies the body; it does not retain
`X-Request-Id`. DSG already sends a generated request ID, but that is not proof
that DS4 echoed it into engine telemetry.

A narrow proposal worth discussing is an **optional bounded opaque request ID**
carried from HTTP admission into existing start/finish diagnostics. This could
help any local client correlate its requests without enabling prompt tracing.
It is more targeted than changing the inference engine, scheduler or cache format.

Before a PR is ready:

- Agree on field format and lifecycle semantics with upstream. Keep omission
  backward compatible; preserve body, rendering, tokenization and model settings.
- Bound accepted IDs and handle malformed/duplicate headers explicitly without
  echoing attacker-controlled log text. Diagnostic IDs are neither credentials
  nor proof of uniqueness; DSG must still reject conflicting ownership evidence.
- Test admission, queued work, generation, rejection, cancellation and errors.
  Document what a terminal diagnostic proves about backend work, rather than
  treating a closed client connection as a completed job.
- Measure overhead using synthetic requests with correlation absent and present.
  Do not require verbose tracing or log prompts, output, image bytes or cache keys.
- Refresh issue/PR searches and bring a minimal reproducer and tested patch to
  the operator before submitting or installing anything.

This signal could improve attribution. It would **not** by itself establish cache
identity, authorize a cache transfer, or make post-dispatch retries idempotent.

## Related upstream work to follow, not duplicate

- [PR #752](https://github.com/antirez/ds4/pull/752), open and unmerged when checked,
  proposes server-local Responses IDs backed by retained KV prefixes, including
  restart handling. Its described benchmark is a token-only host-side fixture,
  not GPU inference validation. This may become a useful optional capability;
  it is not a cross-worker cache-transfer protocol or a guarantee for existing
  Chat Completions clients.
- [PR #67](https://github.com/antirez/ds4/pull/67), closed and unmerged when checked,
  proposed broader multi-session/pool controls. Search results mentioning request
  IDs are not evidence that the narrow telemetry feature already shipped.

The existing [integration boundary](ds4-integration.md) and
[attribution safeguards](request-attribution.md) remain unchanged. Review upstream
changes on their merits; do not adopt a broad patch merely to obtain one signal.
