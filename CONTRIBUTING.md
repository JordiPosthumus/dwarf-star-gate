# Contributing to Dwarf Star Gate

Thank you for helping. Please also read [CREDITS.md](CREDITS.md): the inference
engine is [Antirez's DwarfStar](https://github.com/antirez/ds4), not this gateway.
Engine changes should follow [its own contribution guide](https://github.com/antirez/ds4/blob/main/CONTRIBUTING.md).

## Start with a small, reproducible change

1. Explain the problem and expected behavior in an issue or pull request.
2. Use Node 22.22.2 or newer. The gateway/dashboard need no dependency installation;
   the optional predictor uses its separate locked Python environment.
3. Install the local hook with `npm run hooks:install`. Run `npm run check`,
   `npm test`, `npm run privacy-check`, and `npm run privacy:test`.
4. Add a regression test for changed behavior; use fixture workers, not live GPUs.
5. Update the README when commands, guarantees or limitations change.
6. For a meaningful user-facing capability or reliability milestone, add one
   plain-language bullet to [WORKLOG.md](WORKLOG.md). Keep detailed technical
   history in [CHANGELOG.md](CHANGELOG.md); do not turn the work log into a commit dump.

The privacy check examines tracked/staged files and working copies. Stage newly
added files before running it so they are included. Review the complete staged
diff manually too. Follow the [publication policy](docs/publication-policy.md):
deployment histories and experiment reports stay private even if they contain no
password. CI is a guardrail, not proof that a change is safe in production.

## Preserve the contract

- Do not rewrite prompts, reasoning settings, sampling parameters or output limits.
- Do not replay requests automatically after ambiguous upstream failures.
- Preserve stable worker IDs, durable affinity and per-worker FIFO admission.
- Keep the dashboard read-only by default. Opt-in local server-routing controls
  must retain the same-origin/CSRF and private-socket boundary. Separately enrolled
  recovery permits only the independently guarded exact-service action, not
  arbitrary model launches, shell commands or setting changes.
- Missing measurements must remain unknown. Do not label a disk hit as a cold miss.
- Keep startup/update failures out of live inference. Test UI assets as a complete
  bundle and reload only the dashboard when promoting presentation changes.
- Avoid runtime dependencies unless their benefit justifies the extra surface.

## Test safely

`npm test` runs local HTTP fixtures and temporary state directories; it must not
connect to an operator's real workers. `npm run ui:demo` uses synthetic telemetry
on loopback port 30011 for screenshots and UI review. Normal monitoring uses 30010.
Do not mix benchmark settings or fixture configuration into production launchers.

Changing a real deployment requires its operator's authorization, a backup,
an explicit delta and validation. Drain and wait for idle work before an inference
gateway restart. The public repository contains no production deployment secrets.

## Reports and pull requests

Include the commit, Node/OS versions, expected/actual result and a minimal
reproduction. For model-dependent behavior, identify the DS4 revision too.
Prefer a diagnostic export over raw logs, and review it before posting: even
filtered snapshots contain request IDs, hashed session IDs, timings and counts.
Never attach keys, prompts, answers, images, private config or raw SSH logs.

Report gateway-specific bugs here. If a problem reproduces when talking directly
to an unmodified upstream DS4 server, discuss it upstream using their guidance.
Please be respectful of contributors and distinguish measurements from guesses.
