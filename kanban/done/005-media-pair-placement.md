# Media placement at machine granularity (Jordi decision: pair goes down together)
Today media hosts = gateway workers (TP=2 pairs). Jordi decided: for a media call, BOTH
sparks of a pair come down and both are used (media models are single-spark).
- Model physical machines vs LLM workers in the media host registry
- Eligibility: media may borrow a whole pair (drain worker, use both machines) but must
  keep the OTHER pair serving (the "another serving LLM" check stays, at machine level)
- Genie flow: drain glm53f-sparksXY (other pair continues serving) -> run media on both
  sparks -> restore LLM
- Update media-host cards to show the pair, not individual workers

Reuse #030's shared power operations and #033's physical-machine mapping. The
Continuity Door is for necessary core reloads, not a fleet-wide hold throughout
media generation. Preserve direct work and report actual engine state.

## LANDED 2026-09-22 ~21:00
- Shared physical-machine table `ds4-gateway/fleet-machines.mjs` (single source
  of truth; power-scripts and media-hosts both read it; unlisted worker id = its
  own machine).
- media-hosts: every host row carries `machines` + `pair`; the "another serving
  LLM" check is machine-level — a borrow is ready only when a healthy worker
  serves on machines that do NOT overlap the borrowed host's machines (owner
  decision: a Spark pair goes down together, the other pair / M3 stays up).
- Media host cards show the machine pair (e.g. "spark3 + spark4
  (glm53f-sparks34)").
- This delivers the machine mapping, eligibility and host cards. It does not
  establish pair execution: the checked-in media executor still requires a
  Docker/Qwen recovery binding and manages one host/container. Draining and
  restoring a GLM pair and using both physical machines needs a separate
  implementation and native acceptance evidence. The flow above remains the
  intended behavior, not a completed execution claim.
- Tests: machine-overlap refusal + separate-machine ready; suite 1105 pass.
