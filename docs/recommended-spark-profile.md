# Recommended DGX Spark configuration

**Current recommendation, verified 2026-09-02.** This is the DS4 configuration
we run on both DGX Sparks behind Dwarf Star Gate. It remains this project's
recommended Spark baseline until we explicitly replace it with a newly tested
profile. Following a moving engine branch or swapping weights is not the same
profile. This is a measured deployment recommendation, not a claim of universal
optimality or an upstream certification.

The engine and model artifacts are the work of
[Salvatore “antirez” Sanfilippo and DS4 contributors](https://github.com/antirez/ds4).
Start with [their documentation](https://github.com/antirez/ds4/blob/main/README.md).
DSG supplies routing and observation, not inference kernels or model weights.
Our deployment uses the pinned downstream fork below; it is **not** an official
Antirez release or endorsement. See [credits](../CREDITS.md).

## At a glance

| Component | Recommended setting |
| --- | --- |
| Hardware | DGX Spark, NVIDIA GB10, 128 GB unified memory, local NVMe |
| Model | DeepSeek V4 Flash **Vision-Exp**, mixed IQ2_XXS/Q2_K with selected Q8 components |
| Vision | Matching separate vision encoder, enabled |
| Context allocation | **262,144 tokens** (256 Ki tokens) |
| Server default output allowance | **262,144 tokens**, subject to remaining context and client request |
| Hot resident sessions | **2** |
| Active model requests | **1 per Spark**, including prefill and decode |
| Disk KV budget | **349,525 MiB** (about 341.3 GiB); target: 10 retained histories, not a slot-count limit |
| Prefill | 2,048-token chunks; mixed-prefill quantum 64 |
| Acceleration | Warm weights; no explicit Q8→F16 weight-cache size cap |
| Speculative decoding | Not enabled in this tested profile |
| Network | Server on loopback port 8000; gateway reaches it over SSH |

This is a **Spark-only recommendation**. Macs can join the same gateway with
different native context/cache settings; registering them does not apply this
profile. DSG's common pool context must fit every enabled server.

This explicitly supersedes the earlier 153,600-context / 4,096-prefill profile.
The only engine-setting changes are context, default output allowance and cold
checkpoint maximum to 262,144, and prefill chunk size to 2,048. The smaller prefill
workspace makes room for the larger contexts without capping the acceleration
cache. No matched workload A/B test establishes identical or optimal prefill
speed. See the measurements and caveats below.

## Pinned engine and weights

Engine: [the deployed fork revision
`552f6b834ce0b5c53b25a89a8468df5fdd1804de`](https://github.com/JordiPosthumus/ds4/commit/552f6b834ce0b5c53b25a89a8468df5fdd1804de).
Both Sparks use this revision. Build with **`make -j8 cuda-spark`**: the pinned
[Makefile](https://github.com/JordiPosthumus/ds4/blob/552f6b834ce0b5c53b25a89a8468df5fdd1804de/Makefile)
selects the GB10 `sm_121` target with `sm_121a` code generation. Both installations
currently have CUDA 13.0, `nvcc` V13.0.88. Build prerequisites and platform setup
remain the engine's responsibility; this gateway does not install CUDA.

For a **new, separate checkout**, after installing the engine's build prerequisites:

```sh
git clone https://github.com/JordiPosthumus/ds4.git ds4-spark-profile
cd ds4-spark-profile
git checkout --detach 552f6b834ce0b5c53b25a89a8468df5fdd1804de
make -j8 cuda-spark
```

Do not rebuild over a running installation. Stage and test separately, retaining
your working launcher, binary, weights and cache for rollback.

Download the **two exact artifacts** from
[Antirez's model repository, pinned to the verified artifact revision](https://huggingface.co/antirez/deepseek-v4-gguf/tree/f71f23d552d664e523b422157b2befbf74040380).
Put them in the checkout's `gguf/` directory and verify SHA-256 before use:

- [Main Vision-Exp IQ2/Q2 model](https://huggingface.co/antirez/deepseek-v4-gguf/blob/f71f23d552d664e523b422157b2befbf74040380/DeepSeek-V4-Flash-Vision-Exp-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf)
  — `DeepSeek-V4-Flash-Vision-Exp-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf`,
  **86,720,111,776 bytes**.
  SHA-256: `8f2d42c0071ccf8a98f391cc2b835fd123f12330690b3059dbb7707920e5ad9e`.
- [Matching vision encoder](https://huggingface.co/antirez/deepseek-v4-gguf/blob/f71f23d552d664e523b422157b2befbf74040380/DeepSeek-V4-Flash-Vision-Encoder.gguf)
  — `DeepSeek-V4-Flash-Vision-Encoder.gguf`, **932,857,760 bytes**.
  SHA-256: `00cd4d81a435364967400a95c42703343e11da6b6f18c5143fe76e1d94d5035f`.

These hashes were verified during deployment and match public artifact metadata
checked on the verification date. We did not reread the large live weight files
while publishing this page. Respect the model's own license and usage terms.

The locally built, running `ds4-server` binaries have different SHA-256 values:

- Spark A: `c9e093f9e9095630999839926384b5679f4dc7c4f247c5e10de2238f2480069f`
- Spark B: `8890235e9339337c1eb6cfc706d9df1e0d0fcad2a293c06cca1b3aabb078a307`

They share the source pin; this is not a claim of bit-for-bit reproducible builds.
Record the hash of your own build and validate it on your machine.

## Exact server launch profile

The command below reproduces the effective options on both Sparks. Only filesystem
paths are generalized: replace `/opt/ds4` with your staged checkout and
`/var/lib/ds4/vision-q2` with a private, writable NVMe cache directory. Provision
those paths first. Use a clean service environment: our live processes have **no
`DS4_CUDA_WEIGHT_CACHE_MAX_*` override**, and no speculative-decoding flags.

```sh
DS4_KV_REWIND_REUSE=0 \
DS4_KV_REWIND_MIN_TOKENS=256 \
DS4_PREFILL_TIMING=1 \
/opt/ds4/ds4-server \
  --cuda \
  --model /opt/ds4/gguf/DeepSeek-V4-Flash-Vision-Exp-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf \
  --vision /opt/ds4/gguf/DeepSeek-V4-Flash-Vision-Encoder.gguf \
  --host 127.0.0.1 \
  --port 8000 \
  --ctx 262144 \
  --tokens 262144 \
  --prefill-chunk 2048 \
  --kv-disk-dir /var/lib/ds4/vision-q2 \
  --kv-disk-space-mb 349525 \
  --kv-cache-cold-max-tokens 262144 \
  --kv-cache-continued-interval-tokens 16384 \
  --warm-weights \
  --batched-session 2 \
  --max-active-requests 1 \
  --mixed-prefill-quantum 64
```

The production wrapper also checks for missing artifacts, an occupied port and
a conflicting GPU model container before starting; it refuses rather than
stopping another workload. Do the equivalent for your installation. This profile
was not validated alongside a second large model, video or music workload.

### What these settings mean

- **Context is a shared envelope.** Prompt, reasoning and answer must fit within
  262,144 tokens. This is not 262,144 input **plus** 262,144 output.
  Keep the full server allowance; clients must manage remaining context
  and compaction without introducing an unrelated small production output cap.
- **Two hot does not mean two generating.** Two sessions can retain resident KV
  state; only one request executes at a time. Further requests wait. The separate
  gateway limit is also one active request per registered server.
- **Disk capacity is byte-based.** Despite the option's `mb` spelling, this build
  multiplies by 1,048,576. The 10-history target is not a reservation or guarantee:
  retention depends on checkpoint sizes, checkpoint multiplicity, eviction and
  actual free disk space. Do not reduce the budget to a ten-file count. Keep
  weights, logs, temporary downloads and filesystem headroom outside that budget.
- **Normal exact-prefix reuse remains enabled.** Rewind reuse is deliberately off
  in this baseline. The `256` rewind threshold is retained but does not enable it.
  Cold histories can be checkpointed through 262,144 tokens, with continued
  checkpoints every 16,384 tokens. Gateway affinity improves locality; DS4 decides
  whether a resident or disk prefix is valid.
- **Reasoning is passed through, not forced by DSG.** In the pinned
  [server parser](https://github.com/JordiPosthumus/ds4/blob/552f6b834ce0b5c53b25a89a8468df5fdd1804de/ds4_server.c),
  `xhigh`, `high`, `medium`, `low` and `minimal` map to DS4's ordinary `HIGH`
  reasoning mode; `none` disables it. They are not five distinct budgets.
  The engine's separate `MAX` regime requires at least 393,216 allocated tokens;
  [`max` falls back to `HIGH` below that threshold](https://github.com/JordiPosthumus/ds4/blob/552f6b834ce0b5c53b25a89a8468df5fdd1804de/ds4.c).
  This Spark profile therefore does **not** provide Think Max.
- **The acceleration cache is not KV.** Its uncapped Q8→F16 growth is a deliberate
  speed choice and consumes unified memory. No artificial free-memory floor is
  imposed by this launcher; that does not mean memory pressure is impossible.

## Reboot persistence and gateway connection

Our deployments use a systemd **user** service named `ds4-vision-q2.service`,
enabled with user lingering so it can start without an interactive login. Its
operational settings are `Type=simple`, `Restart=on-failure`, `RestartSec=10`,
`TimeoutStopSec=300`, `KillSignal=SIGTERM`, `LimitNOFILE=1048576` and
`WantedBy=default.target`. `WorkingDirectory` and `ExecStart` point at the staged
installation and its checked launcher. Network-online ordering is configured;
the wrapper separately checks that conflicting workloads are absent.

Verify reboot recovery on your own machine, including a real disk-cache restore.
Our Spark B passed an actual reboot and subsequent text-cache/vision checks on
the previous 153,600 profile. The 262,144 rollout uses the same enabled service and
lingering mechanism. Service restarts are checked, but a fresh full-machine
reboot of this larger-context profile is not claimed for either machine.

In DSG, register each server **once**, through its SSH tunnel to port 8000. Use the
[UI/CLI registration instructions](../README.md#operator-controls), keep stable
server IDs, and send a stable per-conversation affinity header. Registration
checks compatibility and leaves the server paused until you enable it. It does
not install the profile or modify the server.

Our gateway model ID is `deepseek-v4-flash`. The common pool guarantee is configured
separately: apply `262144` in **Manage DS4 servers → Pool context limit** only after every enabled pool member
supports it. DSG refreshes native worker metadata automatically, but does not
automatically raise the configured pool guarantee. Follow
[Context limits and rolling upgrades](context-limits.md), including persistence
and separate client-metadata checks. The production routing settings are
`request_timeout_ms: 360000000` (100 hours), `queue_timeout_ms: 3600000` (1 hour),
and `max_queued_per_node: 128`. These are timeout/admission settings, not proof
of a 100-hour successful generation. Preserve reasoning, tools, vision and
output controls end-to-end; use real gateway credentials for your own deployment.
For Linux engine timings, set `telemetry_service: "ds4-vision-q2.service"` with
an SSH login able to read that user's journal. Direct clients bypass gateway
accounting and should not be mistaken for additional gateway capacity.

## Measured acceptance and limits

These are **recorded deployment tests**, not promised speeds for every prompt.
The larger-context rollout rechecked effective launch settings and binary identity;
the large model artifacts are unchanged from the earlier hash verification.
Dashboard screenshots elsewhere in the repo are synthetic, not evidence.

### 262,144-token profile

| Check | Observed result |
| --- | --- |
| Two resident near-limit histories on Spark A | 262,040 prompt tokens each; both returned the requested EDGE response |
| Resident switching at 260K on Spark A | 260,009 tokens reused in each history, with no disk reload; 852ms and 630ms end-to-end for one-token continuations |
| Almost-cold long prefill on Spark A | 257,960 newly processed tokens after 2,048 cached; 434.012s, 594.36t/s including checkpoint pauses |
| Long reasoning on Spark A | 250,029-token prompt; correct arithmetic/explanation; 219 output tokens at 10.49t/s decode |
| Thinking continuation on Spark A | 260,284 cached tokens, 26 new prompt tokens; correct answer to a different arithmetic question; 195 output tokens |
| Evicted 260K history on Spark A | 260,019 tokens reloaded from NVMe in 3,168ms; 9.968s total including eviction/save and generation |
| Oversize admission on Spark A | 265,008-token prompt rejected with context_length_exceeded |
| Spark A persistent-service checks | Reasoning and vision passed; an existing 143,360-token checkpoint restored after restart; a fresh 11,008-token prompt went from 13.416s cold to 1.396s with 10,240 tokens restored |
| Two resident near-limit histories on Spark B | 262,008 prompt tokens each; first reused 143,360 tokens from an older checkpoint, second was fully cold |
| Fully cold prefill on Spark B | 262,008 new tokens in 377.787s, about 693.5t/s; overall client time also included queueing behind the first request |
| Hot switching on Spark B | 262,009 cached tokens per history, eight new prompt tokens each; 611ms / 563ms end-to-end, no disk reload |
| Long reasoning on Spark B | 250,024 prompt / 115 output tokens; correct arithmetic; 245,760 tokens restored, 25.675s total |
| Spark B persistent-service checks | Vision passed all five fields; old 143,360-token checkpoint restored; oversize 265,008-token prompt rejected; service enabled with lingering |

The first long-context client used a five-minute HTTP headers timeout and
cancelled its requests. That client was corrected; those aborted attempts are
not successful boundary tests. The completed Spark A 260K runs reused 217,088 and
2,048 tokens respectively, so neither is labeled an entirely fresh cold 260K run.

**Semantic caveat:** short nonthinking continuations of extremely repetitive 260K
fixtures returned the previous OK instead of newly requested AGAIN/RESTORED.
Later longer extensions returned EDGE correctly, and long thinking continuations
answered new arithmetic correctly. The cause is unresolved. These capacity tests
do not establish unchanged reasoning quality on arbitrary long coding workloads.

**Memory remains tight and swap occurred.** Spark A's trial reported 9.10GiB of
context buffers and 1.97GiB shared prefill workspace. Minimum sampled available
memory after readiness was 4.896GiB. About 1,137MiB cumulative host swap-out and 957MiB
swap-in occurred through one observation point; these are transferred pages, not
unique bytes or exclusively model-process activity. No new runtime allocation
failure or unintended restart was observed in that trial. Do not call it swap-free
or infer long-duration stability from these checks.

### Previous 153,600-token baseline — historical evidence

The following older results establish the preceding deployment's behavior. They
are not 262,144 benchmarks or a controlled speed comparison against the new profile.

| Check | Observed result |
| --- | --- |
| Short warm text / reasoning on Spark A | About 17.7–17.8 generated tokens/s; complete xhigh stream with visible answer |
| Vision on Spark A | All five fixture fields correct; about 17.4 generated tokens/s; vision also passed on Spark B and through DSG |
| Near-limit cold prefill on Spark A | 145,009-token prompt; 181.23 s prefill, about 800 tokens/s |
| Oversize admission on Spark A | 160,009-token prompt rejected before model execution |
| Durable disk reuse | 143,360 cached tokens restored after resident churn and service restart; logs confirmed the disk tier |
| Cold long prompt through DSG | 145,041 tokens; 185.03 s on Spark A, 179.38 s on Spark B |
| Same-prompt repeats through DSG | 5.04 s / 4.35 s respectively, with 143,360 cached tokens |
| One-active-request admission | Overlapping requests serialized at the model server; two Sparks could serve concurrently |
| Gateway behavior | Affinity across gateway restart, tool round trip, vision, xhigh streams, cancellation and immediate recovery passed |

Small output allowances in near-limit and vision fixtures were **test controls**,
not settings promoted to the production launcher. These tests do not prove a
full-context continuous completion, every possible vision input, or every client.

**Historical memory observations:** in the preceding Spark A profile, minimum available memory was
roughly 5.3–5.8 GiB. Trials with three or more hot slots encountered severe memory
pressure/allocation failures, which is why the accepted profile uses two. Startup
NVRM `NV_ERR_NO_MEMORY` warnings were observed on both machines; their precise
allocator cause has not been established. The recorded gateway acceptance suite
observed no new inference failure or unintended DS4 restart. That is not a claim
of an error-free startup or an OOM-proof deployment.

Before treating another machine/build as equivalent, verify its effective
arguments/environment, artifact hashes, cold-to-warm **disk** hit, long-context
request, serialized admission, vision, tools, cancellation, warmed-cache memory
behavior and reboot recovery. Test changes separately; do not silently reduce
context, output allowance or cache capacity to make a check pass. Replace this
recommendation only with an explicit profile delta and new acceptance evidence.
