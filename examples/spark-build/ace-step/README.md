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

The pinned assets include the 4B tokenizer’s separate chat template, which is
required for generation. Use `create-media.py` as shown in the parent build guide
to create the writable cache and output directories under the private data mount.

The image defaults to eager initialization, XL SFT, 4B and one API worker. Mount
the model tree at `/models/ace-step` and a writable private data folder at `/data`.
The model tree must be writable for upstream's pinned model-code synchronization.
Expose container port 8002 on host loopback when creating an enrolled worker.
The gateway handles remote access through its existing transport. Preserve other
serving workloads and drain before allocating the GPU to this container.

The build adds explicit `sampler_mode` (`euler` or `heun`) and `dcw_enabled`
fields to the pinned HTTP request model and forwards them to `GenerationParams`.
Without this extension the pinned HTTP path does not forward those choices;
its core defaults are Euler and DCW enabled. Omitting the new fields preserves
those defaults. For an AceFarm request that explicitly selects Heun and DCW off,
send `sampler_mode: "heun"` and `dcw_enabled: false`, together with its unchanged
steps, CFG, duration, seed, thinking, model and language-model settings.

`apply-recipe-fields.py` requires exact source hashes before changing a new build
context. `verify-api-fields.py` runs in the image build and exercises the actual
pinned request parser, Pydantic model and generation parameter assembly. It
loads the real parameter dataclass definitions without importing GPU libraries,
checks omitted defaults and explicit overrides, and rejects invalid options.
This verifies API wiring, not native synthesis. Existing deployed images do not
gain this extension until separately rebuilt and natively qualified. Do not
patch running engines or claim old enrollment receipts verify the new fields.

The requirements lock is a clean Python 3.12/Linux ARM64 resolution based on the
working package versions; each downloaded artifact has a SHA-256 hash. The source
and base image are pinned. Ubuntu system packages still come from the base's
configured repositories, so this is not a byte-identical image claim.

Status: the standalone image has completed native generation using XL SFT and
the 4B nano-vLLM backend, retained a 10-second stereo 48 kHz FLAC that passed full
decode, and automatically restored the original LLM with verified replies and
cold-to-warm cache reuse before gateway readmission. This followed corrections
to a writable-output path and the missing tokenizer template. The run used a
separate model/data tree on an existing Spark; it does not establish complete
new-machine provisioning or subjective music quality. Automatic Genie dispatch
was previously verified with the installed engine. New-host setup and gateway
enrollment remain separate work.

ACE-Step and bundled nano-vLLM retain their upstream licenses in the downloaded
source. The selected weights and tokenizers retain the terms of the repositories
linked in `models.json`. No model weights or personal configuration are committed.
