# Enrolled recipe trials through Genie

`fleet_recipe_trial` accepts an operator-enrolled profile ID, a trial UUID and a
`prepare` or `run` stage. Chat cannot supply commands, paths, hosts or settings.
The private `recipe_trials` configuration maps each profile to an absolute
`plan_file` and its SHA-256. Its worker/SSH/recipe path must match the existing
inspection binding. The executors support the GLM Spark pair long
coding reference profile and a local oMLX MTP depth 3 → 5 → 3 comparison. Enrollment is not permission to adopt the candidate.
Use the owner's explicit approval for the temporary profile and its tradeoffs.

For your own GLM pair names, configure `machine_groups` with the pair's two
physical machine IDs and groups for independently serving workers. Include a
nonempty `separate_workers` list of those worker IDs in the hashed plan. For
example, groups `{"my-pair":["gpu-a","gpu-b"],"my-spare":["gpu-c"]}` and plan
`"separate_workers":["my-spare"]` provide an explicit serving floor. Overlapping
groups are rejected, active operations reserve every route on the same hardware,
and the native executor checks a listed spare is healthy and admitted before the
transition. These are configurable names; no private fleet hostname is required.
An existing inspected GLM pair is required: this workflow does not provision an
unconfigured tensor-parallel cluster or qualify unsupported model families.

Spark preparation verifies the pinned original revision, launcher, environment and
image on both ranks. It archives the original source and launcher files, retains
original image tags, builds a separate pinned source archive and transfers only
the candidate image. It preserves existing extra launch arguments and gives the
candidate separate kernel cache directories. Only candidate CUDA compilation
parallelism changes from the upstream build recipe (8 jobs to 1); this is recorded
in the receipt and does not alter serving parameters. Resource checks stop the
build if host headroom becomes too small. No model is stopped during preparation. Before the measured run, the candidate
launcher is checked against the pinned archive and its 49 host-side worker
staging references move from shared `/tmp` to the isolated trial directory.
Container-side paths and model flags stay unchanged. Original worker bind-file
bytes and modes are backed up and compared before restoration is accepted.

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
mounts and recipe bytes and runs native checks again. Readmission requires the restored quality probes,
near-context-limit acceptance, and two-active-request observation to pass; it
does not require a cache benefit the original never had. Only verified restoration
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


The local oMLX trial pins the source revision and original launcher/global/model
settings hashes. Preparation backs up those bytes and checks the authenticated
engine-pool settings. A run acquires the same owned maintenance hold, waits for
native/gateway idle, changes only `mtp_num_draft_tokens` from 3 to 5, reloads the
existing model, compares it, restores the exact original bytes and reloads depth
3. Context, output, thinking, concurrency, weights, memory and persistent cache
settings are unchanged. Reloads necessarily replace the in-memory engine; no
cache directory is cleared. A2 includes native cold-to-warm reuse proof.

The coding samples are retained for review and checked for basic structure;
that alone does not prove functional code correctness. The tool exchange and
cache assertions use actual native results. All request output budgets belong
only to these synthetic measurements. Neither a completed Spark run nor a
completed MTP run authorizes adopting the candidate as a production default.

The optional enrolled `candidate_profile: baseline-cache-400k` comparison uses
that same pinned updated source with compact draft pages and retention 14336/0.
It copies the original serving knobs, including 400k context, two requests,
7168 prefill batch, 0.85 memory utilization, dense FP8 off, BF16 large-M off,
MoE fast kernels off, stock spinwait, output defaults and loader choice. It
checks those fields in both candidate containers before measurements. This is
a combined source/cache experiment, not causal proof for one retention flag.
It also restores the original containers and does not authorize adoption.


After explicit owner authorization, `fleet_recipe_rollout` deploys a separately
enrolled permanent plan with its own UUID. It reuses the exact image from the
completed, capacity-preserving qualification, keeps the original containers,
waits for idle under an owned maintenance hold and checks native readiness.
Successful publication changes only that worker's normal recipe path and its
inspection binding plus a matching paired-media recipe binding; all other
settings and an owner's later pause are preserved.
It runs no new benchmark. Full original publication bytes and deployment receipts
remain private. A failure restores the originals; uncertainty keeps the hold.

Image preparation first reuses an exact existing ARM64 image. Otherwise it tries
direct transfer between the enrolled hosts, pinning the target public host key
and machine identity observed through the existing trusted connection. Temporary
host-key files are removed; permanent SSH trust files are unchanged. If the
peer SSH login is unavailable, it can stream the image directly over a temporary
TLS listener. That listener's certificate and random token arrive through the
existing trusted target SSH connection; the source verifies the certificate and
exact machine before sending bytes. It checks the loaded image identity, closes
on owner disconnect or completion, and installs no persistent credentials or
trust entries. If direct transport is unavailable before copying starts, it
uses a compressed local relay. Compression applies only to this image
transfer; it changes no persistent SSH or model settings. Once a
copy starts, its failure is reported rather than starting a second transfer.

Only a confirmed failure in `copying_qualified_image`, before any preparation
result or maintenance intent, can be resumed with the same rollout ID and its
exact `expected_finished_at` timestamp. Address the cause first. The original
failure is archived, pinned source bytes and publication files are rechecked,
and the original target baseline is verified again. Duplicate delivery observes
the existing attempt. Running work, uncertain state and later deployment stages
cannot use this resume path.

For the capacity-preserving profile, `qualification_mode: "candidate-only"`
avoids repeating an earlier baseline comparison. It still requires all ten
candidate checks, genuine cold and warm cache evidence, the context boundary,
two observed active requests, exact original restoration and a native readiness
response. Diagnostic request budgets never change production limits. A later
upgrade of a published recipe can use `baseline_kind: "published-rollout"` with
the SHA-256 of its retained deployment receipt in `baseline_deployment_sha256`;
the executor verifies the image, source receipt and complete backed-up recipe
manifest instead of pretending that a published archive is a Git checkout.
