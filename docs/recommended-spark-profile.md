# Recommended DGX Spark configuration

**Experimental recommended baseline.** These exact settings remain this project's
Spark recommendation until explicitly superseded by a newly tested profile.
Following a moving engine branch or swapping weights is not the same profile.
This is reusable configuration guidance, not a description of a particular fleet,
a claim of universal optimality or an upstream certification.

**Known reliability limits:** fatal CUDA execution errors and OOM conditions have
been observed with this baseline; their precise causes remain unresolved. Passing
boundary checks is **not evidence that the profile is OOM-proof or long-context
stable**. No configuration reductions are implied by this documentation. Diagnose
faults and validate representative sustained work before relying on stronger
guarantees; see the
[maintenance review](maintenance-review-2026-09-02.md).

The engine and model artifacts are the work of
[Salvatore “antirez” Sanfilippo and DS4 contributors](https://github.com/antirez/ds4).
Start with [their documentation](https://github.com/antirez/ds4/blob/main/README.md).
DSG supplies routing and observation, not inference kernels or model weights.
This baseline uses the pinned downstream fork below; it is **not** an official
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
The differences are context, default output allowance and cold
checkpoint maximum to 262,144, and prefill chunk size to 2,048. The smaller prefill
workspace makes room for the larger contexts without capping the acceleration
cache. No matched workload A/B test establishes identical or optimal prefill
speed. See the acceptance requirements and caveats below.

## Pinned engine and weights

Engine: [the pinned fork revision
`552f6b834ce0b5c53b25a89a8468df5fdd1804de`](https://github.com/JordiPosthumus/ds4/commit/552f6b834ce0b5c53b25a89a8468df5fdd1804de).
Build with **`make -j8 cuda-spark`**: the pinned
[Makefile](https://github.com/JordiPosthumus/ds4/blob/552f6b834ce0b5c53b25a89a8468df5fdd1804de/Makefile)
selects the GB10 `sm_121` target with `sm_121a` code generation. The reference
toolchain is CUDA 13.0, `nvcc` V13.0.88. Build prerequisites and platform setup
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

The hashes identify the pinned public artifacts, not private service enrollment.
Respect the model's own license and usage terms. A source pin does not guarantee
bit-for-bit reproducible binaries; record your own build fingerprint privately
and validate it on your machine.

## Exact server launch profile

The command below specifies the recommended options. Replace `/opt/ds4` with your staged checkout and
`/var/lib/ds4/vision-q2` with a private, writable NVMe cache directory. Provision
those paths first. This baseline uses a clean service environment with **no
`DS4_CUDA_WEIGHT_CACHE_MAX_*` override** and no speculative-decoding flags.

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

Use a wrapper that checks for missing artifacts, an occupied port and conflicting
GPU workloads before starting. It should refuse rather than stop another workload.
Coexistence with another large model, video or music workload requires separate
memory and contention validation.

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

A systemd **user** service can run this profile; `ds4-vision-q2.service` is the
example service name. Enable it with user lingering if it must start without an
interactive login. Reference settings are `Type=simple`, `Restart=on-failure`, `RestartSec=10`,
`TimeoutStopSec=300`, `KillSignal=SIGTERM`, `LimitNOFILE=1048576` and
`WantedBy=default.target`. `WorkingDirectory` and `ExecStart` point at the staged
installation and its checked launcher. Configure appropriate network-online
ordering; separately check that conflicting workloads are absent.

Verify reboot recovery on your own machine, including a real disk-cache restore.
Passing a service restart does not certify a full-machine reboot. Repeat the
checks after context, model, engine or service-manager changes.

In DSG, register each server **once**, through its SSH tunnel to port 8000. Use the
[UI/CLI registration instructions](../README.md#operator-controls), keep stable
server IDs, and send a stable per-conversation affinity header. Registration
checks compatibility and leaves the server paused until you enable it. It does
not install the profile or modify the server.

Use model ID `deepseek-v4-flash` for this profile. The common pool guarantee is configured
separately: apply `262144` in **Manage DS4 servers → Pool context limit** only after every enabled pool member
supports it. DSG refreshes native worker metadata automatically, but does not
automatically raise the configured pool guarantee. Follow
[Context limits and rolling upgrades](context-limits.md), including persistence
and separate client-metadata checks. Compatible example routing settings are
`request_timeout_ms: 360000000` (100 hours), `queue_timeout_ms: 3600000` (1 hour),
and `max_queued_per_node: 128`. These are timeout/admission settings, not proof
of a 100-hour successful generation. Preserve reasoning, tools, vision and
output controls end-to-end; use real gateway credentials for your own deployment.
For Linux engine timings, set `telemetry_service: "ds4-vision-q2.service"` with
an SSH login able to read that user's journal. Direct clients bypass gateway
accounting and should not be mistaken for additional gateway capacity.

## Acceptance requirements and limits

Validate the exact build and hardware before enabling it for normal traffic.
Keep detailed results privately; synthetic dashboard screenshots are not evidence.

| Check | Required evidence |
| --- | --- |
| Context and resident capacity | Two independent near-limit histories, correct changed continuations and actual reused-token counts when switching |
| Cold prefill | Explicitly measured reused versus newly processed tokens; enough client timeout for the complete request |
| Disk reuse | A real evicted history restored from disk after churn/restart, with correct continuation and an observed disk-tier event |
| Reasoning, vision and tools | Representative semantic checks, including new questions after reuse, not just a successful HTTP response |
| Admission and cancellation | Native serialization, oversize rejection and verified backend behavior after client disconnect |
| Memory and persistence | Warmed acceleration/KV memory behavior, swap/pressure observations, service restart and full reboot recovery |

The baseline has been exercised with real inference and cache reuse, but it is
not a portable speed or reliability guarantee. Near-limit repetitive fixtures can
produce an old marker instead of a changed instruction; successful allocation or
cached-token counts alone do not establish semantic correctness. This behavior
requires targeted diagnosis rather than assuming every cache hit is correct.

Memory pressure, swap, startup allocation warnings such as `NV_ERR_NO_MEMORY`, and fatal execution failures
remain relevant risks. Do not infer swap-free operation or sustained reliability
from readiness or a short successful canary. Increasing hot slots or colocating
another model requires separate validation. No arbitrary capacity reductions are
part of this guide.

Before treating another machine/build as equivalent, verify its effective
arguments/environment, artifact hashes, cold-to-warm **disk** hit, long-context
request, serialized admission, vision, tools, cancellation, warmed-cache memory
behavior and reboot recovery. Test changes separately; do not silently reduce
context, output allowance or cache capacity to make a check pass. Replace this
recommendation only with an explicit profile delta and new acceptance evidence.
