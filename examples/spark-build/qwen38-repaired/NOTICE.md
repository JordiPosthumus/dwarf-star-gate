# Source notices

The build downloads pinned sources from blazux/qwen3.8-Flash-DGX, copyright 2026
blazux, licensed under Apache-2.0. Its original LICENSE is retained in the build
context. The Dockerfile also obtains checksum-pinned determinism-kernel sources
from jschmied/qwen38-flash-next-gb10; the upstream recipe retains their attribution.

The repair directory contains modified vLLM files and additional local
reasoning/parser repairs under Apache-2.0. Original SPDX and copyright notices
remain in those files. The retained repaired files are copied without rewriting
headers so their hashes can be compared with the qualified installation. Local
changes cover the reasoning budget/parser contract, Qwen tool-call handling and
reasoning EOS suppression. No upstream endorsement is implied.

Star Gate's preparation script and manifest assemble these inputs. They do not
supply model weights or change the licenses of vLLM, its dependencies, NVIDIA
components or the selected model. See LICENSE-APACHE-2.0 for the license text.
