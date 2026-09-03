# Credits: Antirez, DwarfStar, and the work behind the gate

## Salvatore “antirez” Sanfilippo and the DwarfStar contributors

The central credit belongs to **[Salvatore “antirez” Sanfilippo](https://github.com/antirez)**
and **[DwarfStar, the original `antirez/ds4` project](https://github.com/antirez/ds4)**.
Dwarf Star Gate is a companion to that work. It would not exist in this form
without it.

The original project provides the native inference engine and its hardware
backends, prompt handling, model-serving implementation and cache machinery.
DSG sends requests to those servers and observes their results; it does
not create the intelligence or implement their token-generation kernels.
The performance numbers shown in our UI are measurements of the worker engine,
not a claim that Dwarf Star Gate invented that performance.

Thank you, Salvatore, for building and sharing the engine, for making its source
available to study, and for encouraging people to understand and adapt their
local systems. We want every reader of this repository to know where the real
inference work lives. Please explore the original, give it a star if it helps
you, and direct credit for its accomplishments to its authors.

## Upstream reading list

- [Original DwarfStar / DS4 repository](https://github.com/antirez/ds4)
- [Main README: supported models, installation and operation](https://github.com/antirez/ds4/blob/main/README.md)
- [Model card](https://github.com/antirez/ds4/blob/main/MODEL_CARD.md)
- [Native engine source](https://github.com/antirez/ds4/blob/main/ds4.c)
- [HTTP serving and request handling](https://github.com/antirez/ds4/blob/main/ds4_server.c)
- [Persistent KV store](https://github.com/antirez/ds4/blob/main/ds4_kvstore.c)
- [NVIDIA CUDA backend](https://github.com/antirez/ds4/blob/main/ds4_cuda.cu)
- [Apple Metal backend](https://github.com/antirez/ds4/blob/main/ds4_metal.m)
- [ROCm backend](https://github.com/antirez/ds4/blob/main/ds4_rocm.cu)
- [GGUF and quantization tooling](https://github.com/antirez/ds4/tree/main/gguf-tools)
- [Speed benchmarks](https://github.com/antirez/ds4/tree/main/speed-bench)
- [Tests](https://github.com/antirez/ds4/tree/main/tests)
- [Contributor guide](https://github.com/antirez/ds4/blob/main/CONTRIBUTING.md)
- [Release-quality checks](https://github.com/antirez/ds4/blob/main/QA_BEFORE_RELEASES.md)
- [Upstream license and copyright notices](https://github.com/antirez/ds4/blob/main/LICENSE)
- [Antirez's GitHub profile](https://github.com/antirez) and [personal writing](https://antirez.com/)

These links point to upstream, not to a renamed copy of its work. Upstream evolves;
a particular deployment can be pinned to an older revision or contain downstream
patches. The gateway's tests do not certify every upstream version or model.

## Credit beyond this project

Antirez's [own acknowledgements](https://github.com/antirez/ds4/blob/main/README.md)
explicitly credit **Georgi Gerganov, llama.cpp, GGML and their contributors**.
We echo that acknowledgement and encourage readers to visit
[llama.cpp](https://github.com/ggml-org/llama.cpp) and read the original notices.
The model families and weights are the work of their respective model authors;
an inference engine and a gateway must not claim to have created them.

The optional CPU encoder uses [Sentence Transformers' all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2),
with inference by [ONNX Runtime](https://onnxruntime.ai/) and tokenization by
[Hugging Face Tokenizers](https://github.com/huggingface/tokenizers). The offline
predictor uses [XGBoost](https://xgboost.readthedocs.io/). These projects and their
contributors deserve credit for that machinery; DSG supplies the bounded
extraction, evidence collection and evaluation integration. Their dependencies
and model artifacts retain their own upstream licenses and notices.

## What this repository contributes

Dwarf Star Gate contributes session-affinity routing, per-worker admission and
drain controls, a dashboard with opt-in local routing controls, operational
telemetry filtering, an optional observer/offline predictor, and tests
for that gateway layer. Credit for the original inference engine remains with
Antirez and the upstream contributors. Errors introduced in this gateway are our
responsibility, not theirs; gateway-specific bugs belong in this repository.

No affiliation or endorsement is claimed. DwarfStar's MIT license applies to
that upstream project; this repository does not relicense it or its dependencies.
Our separate artwork is replaceable branding, not an upstream logo or an official
Antirez product mark.
