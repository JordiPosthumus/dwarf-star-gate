# Security policy

## Reporting a vulnerability

**Do not post exploitable details or secrets in a public issue.** Use GitHub's
private vulnerability reporting for this repository:
[report a vulnerability privately](https://github.com/JordiPosthumus/dwarf-star-gate/security/advisories/new).
Include a minimal reproduction, affected commit, impact and proposed mitigation.
Do not include live credentials or private conversation content.

This is an early-stage project. The current `main` branch is the maintained
development line; no long-term-support releases or response-time SLA are promised.

## Trust boundary

- The gateway is a trusted-operator, single-model tool, not multi-tenant isolation.
- Example listeners bind loopback. A LAN/internet deployment needs a deliberately
  configured authentication, network and transport-security boundary.
- Operator commands use a local private Unix socket. They must not be proxied
  into public worker-management endpoints.
- The dashboard binds loopback and validates Host/Origin. It is read-only by
  default. Explicit `ui_worker_management` enables four routing actions through
  the private Unix socket, requiring exact same-origin JSON requests and a
  per-process CSRF token. No model launch/stop/settings controls exist. Do not
  expose this operator UI through a public or LAN reverse proxy.
- The management view includes local endpoints/SSH aliases, but diagnostic exports
  exclude them and the CSRF token. Any process with the operator's local authority
  can use the socket; the browser checks are not isolation from that account.
- Journal followers and registered remote-worker tunnels use the operator's
  existing SSH authority. Registration does not install keys or modify SSH trust.
- Conversation affinity identifiers are routing hints, not authorization tokens.
- Config/state directories, SSH access and service accounts must be protected by
  the operator. A compromised local account is outside this gateway's isolation.

## Data handling

Prompt and answer bodies are forwarded, not deliberately stored by the gateway.
The requested-thinking observer transiently captures at most 8 MiB per active
upload for one JSON parse. It releases body references on completion, overflow or
cancellation and retains only allowlisted thinking-control scalars (not message
text, images or tools). This is not secure memory erasure; JavaScript garbage
collection owns reclamation. Larger/encoded uploads still pass through unchanged
with unknown thinking metadata. No body capture is written to disk.
Operational data is still sensitive: raw SSH errors can expose host details;
diagnostics contain request IDs, hashed session IDs, timings and token counts.
Review before sharing. Debug artifacts and runtime files are excluded from Git.
Logs have no automatic retention/deletion policy; the operator controls retention.

Source-level privacy checks catch common mistakes but cannot prove absence of all
secrets or identifying data. Treat screenshots and binary metadata as reviewable
data too. Published screenshots must use the isolated synthetic-data demo.

Upstream engine security issues belong with
[Antirez's original DS4 project](https://github.com/antirez/ds4), subject to its
reporting guidance. Defects introduced by this gateway are this project's responsibility.
