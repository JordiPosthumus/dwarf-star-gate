# Prepare the selected Qwen Spark build

This recipe assembles the retained repaired vLLM 0.29 build inputs used with the
selected Qwen NVFP4 / MTP 2 configuration. It downloads eight checksum-verified
files from one pinned public commit, pins the base image by digest, and applies
twelve retained repair files. Those twelve files were compared byte for byte
with the installed selected image. The upstream patch sources and draft
vocabulary were also compared with the public commit.

**Source preparation has been verified. A clean GPU image rebuild and new-Spark
qualification have not.** A new image will have its own identity; neither the
version label nor this recipe grants it the old image's qualification or score.
Keep the existing working image, container, launcher and cache.

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
Preserve each worker's existing thinking and sampling defaults. This recipe
builds image contents only; it does not choose private paths, create a launcher,
register a gateway worker or approve a configuration record.

Record the new image identity and qualify text, tools and their follow-up,
vision, actual cold-to-warm cache reuse, context/overflow behavior and reasoning
EOS handling before adoption. Measure performance through Hourglass separately.
Follow the existing owned maintenance and retained rollback procedure when
eventually replacing a worker. Do not transfer the historical score to this
new image without a corresponding run.

The [source notices](NOTICE.md) identify upstream projects and local changes.
The preparation script uses only the Python standard library; it does not import
or execute the supplied vLLM repair files.
