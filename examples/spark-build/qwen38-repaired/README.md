# Prepare the selected Qwen Spark build

This recipe assembles the retained repaired vLLM 0.29 build inputs used with the
selected Qwen NVFP4 / MTP 2 configuration. It downloads eight checksum-verified
files from one pinned public commit, pins the base image by digest, and applies
twelve retained repair files. Those twelve files were compared byte for byte
with the installed selected image. The upstream patch sources and draft
vocabulary were also compared with the public commit.

**Source preparation, a Docker `--no-cache` build and native serving checks have
passed on an existing ARM64 / GB10 host. Complete fresh-Spark installation remains
unverified.** A rebuilt image has its own identity and evidence; the checks do
not grant it the historical image's Hourglass score.
Keep the existing working image, container, launcher and cache.

The uncached build actually compiled the determinism kernel. All 2,518 compared
files matched the selected running installation: vLLM Python sources, the two
custom Python helpers, draft vocabulary and compiled kernel. vLLM, PyTorch and
Transformers versions also matched. The rebuilt kernel loaded and registered
its operation in a temporary container without model mounts or GPU access.
During that build comparison the existing model container was neither restarted
nor replaced. A later owned test drained it, started the rebuilt image with a
separate cache, and passed text, tool round-trip, vision, prefix-cache reuse,
full-context boundary/overflow and reasoning-EOS checks with no increase in
native abort/error/preemption counters. The original container then returned
automatically with real reply/cache proof and gateway readmission.

Both cold conversations reused zero tokens; both follow-ups reused 4,800. The
full-context request accepted 262,143 input tokens plus one output token. The
rebuilt engine reported 498,218 KV tokens, matching a prior original-image boot
and within its recorded 490,976–521,391 startup range. No memory setting changed.
These are functional checks, not a matched benchmark or exhaustive output-length
proof. Base layers and verified download caches were available; this was not a
blank-machine installation test.

## Prepare a separate directory

From a Star Gate checkout, using Python 3:

```sh
python3 examples/spark-build/qwen38-repaired/prepare.py /path/to/new-build-directory
```

The destination's parent must exist. Preparation refuses an existing destination
and verifies every downloaded and repaired source file before writing its final
`build-receipt.json`. A failed preparation leaves its partial directory for
inspection; use a different destination after resolving the error. This command
does not install Docker, download weights, build an image or alter a server.

The manifest records the public source revision, base-image digest, repair
hashes and architecture. Source notices and the Apache license are copied into
the context. The upstream Dockerfile contains checksum-pinned determinism-kernel
downloads; those are fetched later by Docker during the build.

## Build and qualify separately

On a suitable **idle ARM64 / GB10 build machine** with Docker and its normal
NVIDIA prerequisites, the separate build command is:

```sh
docker build --platform linux/arm64 -t stargate/qwen38-repaired:source /path/to/new-build-directory
```

The build uses the pinned upstream base image and compiles the custom kernel for
`121a`. It may consume substantial disk space and memory. It does not start a
model container or replace the existing selected image. Do not run a build over
active model work merely to verify this example.

Before serving the new image, supply and verify the recorded model revision,
model/cache mounts and full [Qwen settings reference](../../server-profiles/qwen38-nvfp4-vllm.json).
The selected checkpoint now has a pinned public `models.json` manifest covering
every indexed tensor shard and the tokenizer/vision/serving configuration:

```sh
python3 examples/spark-build/download-models.py qwen38-repaired /path/to/new-model-directory
```

Allow approximately 135.3 GB for these assets, separately from the image and
runtime caches. Downloads resume and verify SHA-256; existing different files
are preserved. After native qualification, all 217 serving files used by the
test were freshly hashed and matched this public manifest. That verifies those
model inputs; each newly installed server still needs its own qualification.

To create a stopped candidate from the selected settings reference:

```sh
python3 examples/spark-build/create-llm.py \
  --image stargate/qwen38-repaired:source --name stargate-qwen38 \
  --models /path/to/model-directory --data /path/to/new-private-data
```

The helper preserves the selected context, output, thinking, sampling, MTP,
kernel and cache settings and records the profile hash and resolved image ID.
It creates a separate cache and binds the API to host loopback (port 8001 by
default, configurable with `--port`). Rendered arguments and environment have
been compared with the established selected launcher. Its candidate completed
the native serving and original-container return checks described above.
Creating it does not start a server, change an existing container, register a
gateway worker or approve recovery. An owned drain must precede GPU allocation.

Record the new image identity and qualify text, tools and their follow-up,
vision, actual cold-to-warm cache reuse, context/overflow behavior and reasoning
EOS handling before adoption. Measure performance through Hourglass separately.
Follow the existing owned maintenance and retained rollback procedure when
eventually replacing a worker. Do not transfer the historical score to this
new image without a corresponding run.

The [source notices](NOTICE.md) identify upstream projects and local changes.
The preparation script uses only the Python standard library; it does not import
or execute the supplied vLLM repair files.
