# MiniMax H3 Spark build

Candidate reproducible ARM64 recipe for Star Gate's existing ComfyUI video
adapter. It pins the qualified NGC base, ComfyUI 0.30.0, the H3 launcher and the
Torchaudio source build that previously required a manual image commit.

```sh
python3 examples/spark-build/prepare-media.py h3 /tmp/stargate-h3-build
docker build --platform linux/arm64 -t stargate/h3:local /tmp/stargate-h3-build
python3 examples/spark-build/download-models.py h3 /path/to/models/h3
```

Use Python 3.12+, Docker and the NVIDIA Container Toolkit on a Spark. The build
does not launch a server. The pinned model set contains FL2VA pruned INT8, the
NVFP4 Qwen3-VL text encoder and both video/audio VAEs. Mount the model tree at
`/opt/ComfyUI/models` and a separate writable output folder at `/opt/ComfyUI/output`.
Expose container port 8188 on host loopback when enrolling it for gateway use.
Drain existing GPU work before starting a media container.

The entrypoint preserves the working recipe's reserve-VRAM, headroom, offload,
memory-mapping and cache defaults. `BUILD_JOBS=2` controls only Torchaudio
compilation CPU work; it is not a serving concurrency limit. NGC's Torch and
Torchvision are preserved. The constraints record the working Python package
versions; system package repositories remain external build inputs.

The public base's layers match the working image's base exactly. All 999 files
in the pinned ComfyUI archive matched the installed source. These facts establish
source provenance. The rebuilt image subsequently generated real video and
audio using a separate model/data tree. Both retained files decoded successfully,
and the existing runner automatically restored and readmitted the original LLM
after real response and cold-to-warm cache checks. New-host installation and
Genie-led provisioning acceptance remain outstanding.

The Docker recipe is adapted from
[Xplore-LAB/minimax-h3-dgx-spark](https://github.com/Xplore-LAB/minimax-h3-dgx-spark),
revision `88d0edf8644aa85846c1f93da46edce04de4441e`, under its MIT license.
The preparation preserves that source and license; the image retains its notice.
ComfyUI, Torchaudio, NGC and the selected weights retain their respective terms.
