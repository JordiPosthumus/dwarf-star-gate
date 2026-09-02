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
| Context allocation | **153,600 tokens** (150 Ki tokens) |
| Server default output allowance | **153,600 tokens**, subject to remaining context and client request |
| Hot resident sessions | **2** |
| Active model requests | **1 per Spark**, including prefill and decode |
| Disk KV budget | **349,525 MiB** (about 341.3 GiB); target: 10 retained histories, not a slot-count limit |
| Prefill | 4,096-token chunks; mixed-prefill quantum 64 |
| Acceleration | Warm weights; no explicit Q8→F16 weight-cache size cap |
| Speculative decoding | Not enabled in this tested profile |
| Network | Server on loopback port 8000; gateway reaches it over SSH |

This is a **Spark-only recommendation**. Macs can join the same gateway with
different native context/cache settings; registering them does not apply this
profile. DSG's common pool context must fit every enabled server.

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
  --ctx 153600 \
  --tokens 153600 \
  --prefill-chunk 4096 \
  --kv-disk-dir /var/lib/ds4/vision-q2 \
  --kv-disk-space-mb 349525 \
  --kv-cache-cold-max-tokens 153600 \
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
  153,600 tokens. This is not 153,600 input **plus** 153,600 output, nor a 262K
  profile. Keep the full server allowance; clients must manage remaining context
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
  Cold histories can be checkpointed through 153,600 tokens, with continued
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
Our Spark B passed an actual reboot and subsequent text-cache/vision checks.
Spark A has an enabled service and lingering; we did not repeat its actual reboot
in the gateway acceptance suite.

In DSG, register each server **once**, through its SSH tunnel to port 8000. Use the
[UI/CLI registration instructions](../README.md#operator-controls), keep stable
server IDs, and send a stable per-conversation affinity header. Registration
checks compatibility and leaves the server paused until you enable it. It does
not install the profile or modify the server.

Our gateway model ID is `deepseek-v4-flash`, with `context_length: 153600` as the
common pool guarantee. The production routing settings are
`request_timeout_ms: 360000000` (100 hours), `queue_timeout_ms: 3600000` (1 hour),
and `max_queued_per_node: 128`. These are timeout/admission settings, not proof
of a 100-hour successful generation. Preserve reasoning, tools, vision and
output controls end-to-end; use real gateway credentials for your own deployment.
For Linux engine timings, set `telemetry_service: "ds4-vision-q2.service"` with
an SSH login able to read that user's journal. Direct clients bypass gateway
accounting and should not be mistaken for additional gateway capacity.

## Measured acceptance and limits

These are **recorded deployment tests**, not new benchmarks run while publishing
this page, and not promised speeds for every prompt. The verification date above
means we rechecked the live launch profile, source identity and public artifact
metadata. Dashboard screenshots elsewhere in the repo are synthetic, not evidence.

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
153,600-token continuous completion, every possible vision input, or every client.

**Memory is tight.** In measured Spark A requests, minimum available memory was
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
