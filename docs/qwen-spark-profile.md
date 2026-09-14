# Qwen Spark settings reference

The selected Spark build uses Qwen3.8-Flash-Next NVFP4 with a custom repaired
vLLM 0.29 image and MTP 2. Keep one qualified image identity in the installation's
configuration library and use that same image when adding another Spark.
The [complete settings reference](../examples/server-profiles/qwen38-nvfp4-vllm.json)
includes the command, environment, required custom resources and recreation gaps.

| Setting | Selected value |
| --- | --- |
| Context ceiling | 262,144 tokens |
| Native output allowance | 262,144 tokens, subject to remaining context |
| Active requests | 1 per model server |
| Prefill batch | 8,192 tokens, chunked prefill enabled |
| Prefix cache | Enabled, Mamba alignment mode |
| KV precision | `auto` |
| Speculative decoding | MTP, 2 tokens |
| Draft vocabulary | 65,536-entry custom artifact |
| GPU memory fraction | 0.80 |
| Compilation | PIECEWISE with the reference's complete splitting-op list |

Preserve existing per-worker thinking and sampling defaults when adopting the
shared image. An engine-default flag and a gateway/client default are different
sources of behavior; inspect both. The reference includes explicit preserved
thinking, xhigh effort and `min_p: 0`. Existing workers may supply those through
their request path instead. See [per-worker serving defaults](serving-profiles.md).

## What has been demonstrated

Two deployments of this selected image passed actual text, tool round-trip, image,
two interleaved cold-to-warm cache checks, the full context boundary and overflow
handling. All four warm conversations reused 4,800 tokens each after uncached prefixes.
The boundary accepted 262,143 input tokens plus one output token; this does not
demonstrate generating 262,144 output tokens. Separate constrained requests
verified the reasoning EOS repair and normal EOS stopping outside reasoning.
These are functional checks, not a new benchmark score or sustained-load proof.

## What a fresh installation gets

Star Gate setup installs its dedicated pinned Hermes runtime and connects Genie
to the model endpoint you configure. It does not install this custom Spark model
server, its weights, NVIDIA drivers, or the selected custom image. A version
label such as `vLLM 0.29.0` does not establish equivalence with that image.

Before provisioning another Spark, obtain the exact qualified image and its
custom resources, retain its immutable identity privately, prepare the model
and cache locations, and validate the new machine. A source/build recipe that
reproduces this custom image from a clean public checkout remains unfinished.
The JSON reference is documentation, not an automatically applied configuration.

## Rolling adoption

Use an owned maintenance hold for one worker and wait for both gateway work and
direct native requests to finish. Retain its previous container, image and
launcher. Start the selected image with the recorded per-worker settings, check
its actual behavior, then release only that hold. Keep the other workers serving.
Initial deployment and a retained rollback are not proof that rollback or a
fresh-machine rebuild has been exercised. Record each qualification separately.

The [earlier DeepSeek profile](recommended-spark-profile.md) retains its own
engine-specific settings and evidence. No server is changed by reading either
reference or registering it with Star Gate.
