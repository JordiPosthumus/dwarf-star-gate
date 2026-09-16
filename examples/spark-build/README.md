# Star Gate Spark build

The build uses three independent engine images so each keeps its required Torch
and CUDA environment. Star Gate's existing media runner switches workloads on an
enrolled host, preserves at least one other serving LLM, and restores the host's
original LLM after media work.

| Engine | Recipe | Current qualification |
| --- | --- | --- |
| Chosen Qwen repaired v0.29 / MTP 2 | [LLM recipe](qwen38-repaired/README.md) | Uncached image build and source comparison passed; rebuilt-image serving pending |
| MiniMax H3 | [H3 recipe](h3/README.md) | Standalone build, real video/audio generation and original-LLM restoration passed |
| ACE-Step XL SFT / 4B | [Music recipe](ace-step/README.md) | Standalone build, real music generation and original-LLM restoration passed |

These recipes are implementation work toward the official new-Spark setup.
They do not yet provide completed Genie-led host installation or automatically
register a new machine with the gateway. The installed media adapters have
already generated real downloadable results and restored an existing LLM; that
is separate evidence from these rebuilt candidates.

After preparing an image and verifying its model directory, create a stopped
candidate with a new name and a new private data directory. For example:

```sh
python3 examples/spark-build/create-media.py h3 \
  --image stargate/h3:local --name stargate-h3 \
  --models /path/to/models/h3 --data /path/to/new-h3-data
```

For music, use `ace-step` and its image/model/data paths. Creation prints the
resolved image and container IDs needed for enrollment. It never starts the
container, stops another service or changes gateway configuration. The existing
gateway operation must own the drain and switching sequence; do not start a
second large GPU workload alongside a serving LLM on the same Spark.

The LLM recipe also provides `create-llm.py`, which creates a stopped candidate
with the selected serving settings and its own cache. Its arguments and complete
environment have been compared with the established selected container. Native
serving qualification and new-host enrollment remain separate from creation.

The setup tools preserve existing model assets. A different existing file is
reported instead of replaced. Downloads are checked against the pinned manifest;
an interrupted download can resume. Private keys, addresses, SSH targets and
deployment records belong to the installation, outside this repository.
