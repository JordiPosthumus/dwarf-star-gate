# Genie proposes new models (the "would have liked the Genie to approach me" flow)
When a new model appears (server dir, HF cache, M3 checkpoint), Genie notices and asks:
"Admit GLM-5.3-Flash-oQ8e-mtp to the gate?" with recipe/context/concurrency summary.
- Scan known model roots (DS4-GLM/models, SparkSetup, HF caches) for unknown checkpoints
- Prepare an admit proposal (worker id, url, aliases, context, max_concurrent) as a draft
- Ask-first via chat/Telegram; never self-admit without a yes
Depends on 006 for the reaching-out channel (dashboard chat works first).

## PARTIAL 2026-09-22 — proposal/ask-first flow delivered by card 028
- Done: admission_inspect drafts the admit proposal (worker id, aliases,
  context, route, dead-worker conflicts, staged plan) from a loopback endpoint;
  every mutating stage is ask-first in dashboard chat with the owner's explicit
  approval; verify reports honestly. Card 007 itself scoped dashboard chat as
  the first channel (Telegram stays optional in 006).
- Remaining: proactive DISCOVERY — scanning known model roots (DS4-GLM/models,
  SparkSetup enrollments, HF caches) for unknown checkpoints and prompting the
  owner unprompted. The current flow starts from a named endpoint.