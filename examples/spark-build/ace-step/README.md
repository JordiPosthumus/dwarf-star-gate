# ACE-Step XL / 4B Spark build

Candidate standalone ARM64 runtime for the Star Gate music adapter. It keeps the
tested XL SFT DiT, 4B language model, native nano-vLLM backend and result metadata.
Unlike the initial installed adapter, this image contains its own Python packages;
it needs no personal ACE environment or host source checkout.

From the Star Gate repository, with Python 3.12+ and Docker/NVIDIA Container Toolkit:

```sh
python3 examples/spark-build/prepare-media.py ace-step /tmp/stargate-ace-build
docker build --platform linux/arm64 -t stargate/ace-step:local /tmp/stargate-ace-build
python3 examples/spark-build/download-models.py ace-step /path/to/models/ace-step
```

Use a new build directory. Model downloads are pinned and verified; interrupted
downloads can resume. Existing different model files are preserved and reported.
`--cache /path/to/existing/checkpoints` can copy matching assets after verification.
The model tree is approximately 28.5 GB: the upstream startup check also requires
the bundled Turbo and 1.7B base assets, even when serving XL/4B.

The image defaults to eager initialization, XL SFT, 4B and one API worker. Mount
the model tree at `/models/ace-step` and a writable private data folder at `/data`.
The model tree must be writable for upstream's pinned model-code synchronization.
Expose container port 8002 on host loopback when creating an enrolled worker.
The gateway handles remote access through its existing transport. Preserve other
serving workloads and drain before allocating the GPU to this container.

The requirements lock is a clean Python 3.12/Linux ARM64 resolution based on the
working package versions; each downloaded artifact has a SHA-256 hash. The source
and base image are pinned. Ubuntu system packages still come from the base's
configured repositories, so this is not a byte-identical image claim.

Status: recipe and candidate build qualification are in progress. The existing
installation has completed real automatic Genie dispatch, generation, retained
download and LLM restoration. That does not yet qualify this rebuilt image or a
new Spark. Automatic new-host setup and gateway enrollment remain separate work.

ACE-Step and bundled nano-vLLM retain their upstream licenses in the downloaded
source. The selected weights and tokenizers retain the terms of the repositories
linked in `models.json`. No model weights or personal configuration are committed.
