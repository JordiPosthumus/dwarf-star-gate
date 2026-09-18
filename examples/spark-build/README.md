# Star Gate Spark build

The build uses three independent engine images so each keeps its required Torch
and CUDA environment. Star Gate's existing media runner switches workloads on an
enrolled host, preserves at least one other serving LLM, and restores the host's
original LLM after media work.

| Engine | Recipe | Current qualification |
| --- | --- | --- |
| Chosen Qwen repaired v0.29 / MTP 2 | [LLM recipe](qwen38-repaired/README.md) | Uncached build, native text/tools/vision/cache/context/EOS checks and original-LLM restoration passed |
| MiniMax H3 | [H3 recipe](h3/README.md) | Standalone build, real video/audio generation and original-LLM restoration passed |
| ACE-Step XL SFT / 4B | [Music recipe](ace-step/README.md) | Standalone build, real music generation and original-LLM restoration passed |

Genie can now connect these recipes to preparation, media samples, LLM and
recovery qualification, and gateway registration. See [Genie setup for new
Sparks](../../docs/genie-spark-setup.md) for enrollment and the chat instruction.
The complete bundle has built and passed native checks in empty installation
and model directories on an existing Spark. A newly registered worker has also
completed a music-to-LLM return cycle. Installation on a pristine physical Spark
remains unverified; the existing machine supplied working drivers and Docker.

## Prepare all three engines on an idle new Spark

With Python 3.12+, Docker and NVIDIA Container Toolkit already installed, run:

```sh
python3 examples/spark-build/setup-spark.py /path/to/private-spark-setup
```

This runs the existing pinned source preparation, image builds, verified model
downloads and stopped-container creation for all three engines. It refuses a
busy GPU and never starts or stops a server. Allow about 227 GB (212 GiB) for models plus
substantial space for images, build layers and runtime caches. Use a private
directory outside the Git checkout, and one setup process per host.

`setup.json` shows the current engine, phase and any failure; `setup.log` records
command output. Run the same command again with unchanged recipes to resume.
Completed image builds are reused, model downloads resume and verify, and
existing containers or different model files are preserved. Partial source
preparations remain available for inspection. A changed recipe needs review
before resuming an existing setup; it is not silently applied over it.

The command alone produces three **stopped** containers with recorded image IDs.
When requested through Genie's full setup workflow, he continues with native
media samples, LLM/recovery qualification and registration. Preparation alone
does not start serving. A full run on pristine hardware remains unverified.

If preparation fails, inspect `setup.json` and `setup.log` in the same directory.
The CLI can resume unchanged recipes as described above. Genie can also resume
a confirmed failed preparation using its exact completion receipt, after
inspecting the cause. Remote resume uses the same directory and verified bundled
sources; it does not restart uncertain work or failed native qualification.
Older preparations without the source receipt still require inspection. An
uncertain SSH response is not proof of failure: read the same setup status before
considering a retry.

## Prepare an individual engine

To build and download only ACE-Step, use the same preparation command with an
engine selection:

```sh
python3 examples/spark-build/setup-spark.py /path/to/private-music-setup \
  --engine ace-step
```

For both media engines, add `--engine h3`. The default without `--engine` still
prepares all three engines. Selected preparation does not build, download or
create containers for unselected engines, so adding music does not prepare
another LLM. It still requires an idle GPU and creates only stopped containers;
draining, native generation checks, enrollment and LLM return belong to the
gateway's separate lifecycle. The existing-host setup action in the Media view now connects these steps in
production; native music and video setup have both completed with retained,
decoded results and verified return of the original LLM on an existing Spark.

Resume with exactly the same engines and directory. The receipt records that
selection, and a different selection is refused without changing existing files.
Use a separate directory for a later engine addition. Simulated build/download
tests cover media-only preparation and interrupted-download resume; they do not
prove a completed native installation.

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
