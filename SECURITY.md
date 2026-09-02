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
- The dashboard binds loopback, validates Host/Origin and accepts read-only GETs.
  It reads journal events through the operator's existing SSH authority.
- Conversation affinity identifiers are routing hints, not authorization tokens.
- Config/state directories, SSH access and service accounts must be protected by
  the operator. A compromised local account is outside this gateway's isolation.

## Data handling

Prompt and answer bodies are forwarded, not deliberately stored by the gateway.
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
