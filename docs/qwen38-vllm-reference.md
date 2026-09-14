# Qwen3.8 NVFP4 settings reference

The [structured reference](../examples/server-profiles/qwen38-nvfp4-vllm.json)
records a Qwen3.8-Flash-Next configuration with context and native output default
262,144, one active sequence, xhigh preserved thinking, prefix caching and MTP 2.
It includes all 23 command flags and 14 explicit launcher environment entries,
plus the inherited CUDA compatibility and usage-source settings.

Gate Genie prepared the profile from actual read-only inspection tools. Codex
independently compared the command and environment, then corrected unsupported
build/dependency claims and removed private installation details. This is a
settings reference, not a measured recommendation or a new installation default.
The existing [DS4 reference](recommended-spark-profile.md) remains separate.

The model is `RadixArk/Qwen3.8-Flash-Next-NVFP4` at the recorded public revision
`7b719225242aacd3dbd3f9407468c2ee9a9d2594`. The server uses a custom image with a
vLLM 0.29.0 label. That label does not prove its ancestry or that stock vLLM
supports this exact configuration. The exact image recipe, custom deterministic
kernel, draft vocabulary, PLE mmap dependency and custom operators must be
resolved before this could become a complete installation recipe.

Placeholders replace host paths, artifact paths and the published loopback port.
The JSON flag map documents arguments; it is not an executable Docker command.
Do not omit required custom dependencies or silently substitute a stock image.
Installing Star Gate neither downloads this model nor applies these settings.

The inspection did not test effective generation limits, benchmark performance,
fresh weight hashes or restoration. A 262,144 output default is still bounded by
remaining context. Record and validate those properties on the intended build
before relying on them. Preserve the existing working setup during evaluation.
