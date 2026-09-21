# Spark and oMLX contract observations

Recorded 10 September 2026. These are preliminary findings for the particular
installed Qwen3.8-Flash-Next backends, not reusable defaults for DS4, vLLM, oMLX
or LM Studio generally. Follow the [onboarding guide](server-setup-guide.md) to
produce a complete contract. No new live inference was run for these checks.

## Approved reasoning policy and corrected implementation status

The owner approved explicit supported reasoning choices and rejection of
unsupported selections on 10 September 2026. Hourglass owns preflight selection;
DSG must preserve the value and backend errors. No silent aliases or substitution
are approved. Intentional client aliases require explicit agreement and visible
selected-label/native-value recording. This decision does not implement changes
in Hourglass, DSG, Pi or the servers.

The audited Qwen templates support `low`, `medium` and `xhigh`; omission defaults
to `xhigh`. The earlier guide's “high/max: reject” entries described the desired
contract too broadly: **template rejection does not prove backend rejection**.

| Request, with thinking enabled | Spark installed request/template path, offline | M3/oMLX installed wrapper/template path, offline |
|---|---|---|
| `low`, `medium`, `xhigh` | Supported template values | Supported without retry |
| Effort omitted | Native/default kwargs resolve to `xhigh` | Native template default `xhigh` |
| `high` or `max` | Template raises an unsupported-effort error | Wrapper retries as `xhigh` |
| Unrecognized effort (`garbage`) | Not included in this Spark test matrix | Wrapper removes effort and uses native `xhigh` default |

The oMLX substitution contradicts the approved policy. These offline results do
not certify live HTTP error handling. Earlier
[M3 template-only evidence](../runtime/m3-parameter-audit/audit.md) remains useful
for template support, but is superseded on the question of whole-backend
rejection by the wrapper checks below.

## Current resolution findings

Native Spark API model: `qwen3.8-flash-next` on each separately identified worker.
Native M3 API model: `Qwen3.8-Flash-Next-MLX-8bit-MTP`.

| Area | Sparks | M3/oMLX |
|---|---|---|
| Omitted sampling | T1, top-p .95, top-k 20, min-p 0, repetition 1, presence/frequency 0 | Same resolved values; model top-k 20 overrides global top-k 0 |
| Explicit ordinary sampling, seed and stop | Tested values reach sampling parameters; seed 0 preserved; stop string becomes list | Tested values reach resolver/SamplingParams; seed 0 preserved; stop string becomes list |
| Temperature 0 | Greedy path normalizes top-p to 1 and top-k to 0 | Resolver preserves 0; this check does not establish final sampler normalization |
| Thinking off | Nested `chat_template_kwargs.enable_thinking=false` closes the thinking prefix | Same nested control works in the checked template path |
| Top-level `enable_thinking=false` | Does not change effective template mode | Dropped by request schema |
| `reasoning_effort=none` | Request builder sets thinking false | Wrapper retries as `low`; thinking remains on |
| History preservation | Nested `preserve_thinking=false` removes historical reasoning in synthetic template check | Same |
| Conflicting top-level/nested effort | Top-level wins in tested case | Nested wins in tested case |
| Both output-limit aliases supplied | `max_completion_tokens` wins | `max_tokens` wins |
| Context/output arithmetic | 262144 total context; prompt of 1000 leaves output 261144; prompt 262143 leaves 1; at/above full context, tested path errors | Validator accepts prompt through 262144 and separately retains output allowance 262144; rejects prompt 262145 |
| Invalid output 0, top-p 0 or repetition 0 | Checked sampling path rejects | Schema/resolver/SamplingParams accept; downstream live behaviour not established |
| Unknown synthetic sampling field | Retained but not consumed by checked sampling conversion | Dropped by schema |

The output findings establish a difference in the checked paths, not a live
context-overrun experiment. Valid numeric ranges beyond the tested cases,
mode-specific sampling recommendations, runtime error propagation and complete
application tests still belong in the eventual per-backend contracts. Off mode
is not a certified profile merely because its template control works.

## Evidence and readiness

Keep requested synthetic cases, server resolution and direct application
separate. The following receipts include the tested inputs and resolved outputs:

- [Spark1 identity, configuration, sampling and template checks](../runtime/backend-contract-audit/spark1.json)
- [Spark2 identity, configuration, sampling and template checks](../runtime/backend-contract-audit/spark2.json)
- [Spark1 request-template merging and context boundaries](../runtime/backend-contract-audit/spark1-boundaries.json)
- [Spark2 request-template merging and context boundaries](../runtime/backend-contract-audit/spark2-boundaries.json)
- [M3 live model/settings snapshot](../runtime/backend-contract-audit/omlx-live.json)
- [M3 offline parser, resolver, template-wrapper and context results](../runtime/backend-contract-audit/m3-offline-results.json)

These checks used installed code without model inference. They do not establish
seed reproducibility under concurrency, numerical MTP equivalence or fresh
cold-to-warm cache behaviour. Existing direct-test receipts and deployment
identities remain in the [deployment reference](server-deployment-reference.md).

**Full chain readiness is not established.** The backend owner must resolve or
clearly bound the parameter-handling defects and complete authorized application
tests. Hourglass owns supported-choice exposure and preflight validation; DSG
owns deployed route and forwarding verification. The
[DSG receipt](hourglass-dsg-contract.md) covers synthetic source tests and records
the unverified deployed routing and vision-recovery exception. This document
neither fixes those systems nor authorizes changes to them.
