# Enrolled recipe trials through Genie

`fleet_recipe_trial` accepts an operator-enrolled profile ID, a trial UUID and a
`prepare` or `run` stage. Chat cannot supply commands, paths, hosts or settings.
The private `recipe_trials` configuration maps each profile to an absolute
`plan_file` and its SHA-256. Its worker/SSH/recipe path must match the existing
inspection binding. The executor currently supports the GLM Spark pair long
coding reference profile. Enrollment is not permission to adopt the candidate.
Use the owner's explicit approval for the temporary profile and its tradeoffs.

Preparation verifies the pinned original revision, launcher, environment and
image on both ranks. It archives the original source and launcher files, retains
original image tags, builds a separate pinned source archive and transfers only
the candidate image. It preserves existing extra launch arguments and gives the
candidate separate kernel cache directories. Only candidate CUDA compilation
parallelism changes from the upstream build recipe (8 jobs to 1); this is recorded
in the receipt and does not alter serving parameters. Resource checks stop the
build if host headroom becomes too small. No model is stopped during preparation.

A run uses the existing owned maintenance controls, requiring another LLM, and
waits for gateway and native requests to finish. It measures the original,
retains the exact original Docker containers under temporary names, starts the
candidate, measures it, then restores the original containers and rank launcher.
Original images, writable layers, configuration, mounts, weights and cache files
are preserved. Candidate containers and images remain available for inspection.
Checks include arithmetic, a real tool-result exchange, two interleaved 128k
histories, append/edit/branch behavior, near-context-limit input acceptance and
two simultaneous requests. Diagnostic token budgets never become production
settings. Synthetic measurements do not establish general model quality.

Restoration compares original container identities, images, full environment,
mounts and recipe bytes and runs native checks again. Only verified restoration
can release this operation's maintenance hold; conditional readmission preserves
a subsequent owner pause. A failed or uncertain restoration remains visible and
keeps the hardware reserved. Never retry an uncertain run under a new UUID.

Receipts survive dashboard reloads, mark the physical pair busy, and block
conflicting power operations or a routine dashboard restart. Read
`fleet_power_status.recipe_trials` for compact observations. Full measurements
and private diagnostics are retained under the runtime recipe-trials directory
and the enrolled remote trial directory. A lost SSH reply is uncertainty, not a
successful restore: inspect the existing remote `run-result.json` and current
native state before reconciling the owned hold. The remote process ignores SSH
hangup, but host/process failures still require explicit recovery; this is not a
host-level transaction or a guarantee against all external interference.
