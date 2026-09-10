# New-backend onboarding guide

Use this procedure when adding a backend such as DS4, a vLLM container, oMLX or
LM Studio to **Hourglass → DSG → backend**. The result is one concise contract
for the particular model and runtime: Hourglass can select a valid configuration,
DSG can forward it unchanged, and the backend accepts and honours it.

An OpenAI-compatible endpoint or a successful response is not proof of parameter
support. Do not infer capabilities from a server family or model name.

## Ownership and authorization

- **Backend owner:** establishes native model identity, supported settings,
  resolution and actual application, capacity behaviour and explicit errors.
- **Hourglass owner:** exposes supported choices, validates profiles before a
  run, records what was sent and owns scoring.
- **DSG owner:** owns transport, declared model aliases and fixed-worker routing;
  preserves parameter values, omission, inputs, responses and errors.

Onboarding documentation does not authorize changes to any of those systems or
to Pi. Start read-only. Live inference and benchmarks, restarts, configuration
changes, cache clearing, capability reductions and extension installation need
explicit approval for the concrete action. Prepare the reviewable delta first;
make a timestamped backup, preserve unrelated settings, prepare a rollback,
and wait for active work to finish before a restart. Offline synthetic
checks may establish preliminary evidence without exercising the live model.

## One onboarding procedure

1. **Identify the target.** Record the native API model ID, upstream alias if any,
   intended worker/route, model revision and quantization, runtime/build,
   template/tokenizer identity and inspection date. Distinguish the running
   service from saved configuration. Tie evidence to this identity.

2. **Write the contract below.** Inspect the installed parser, defaults,
   overrides, template and sampler. For every parameter exposed upstream,
   establish its exact wire location, type, valid values, default and behaviour
   when omitted, null, zero or false. Record forced settings and precedence.
   Separate thinking mode from reasoning effort and history preservation.
   Define precisely which client label sends which native value; unsupported
   choices must fail explicitly. No silent aliases, field removal or retries
   with substitute settings. An intentional client alias needs explicit owner
   agreement and a visible label-to-wire mapping.

3. **Verify resolution offline.** Use synthetic requests against the identified
   parser/resolver/template path, including wrappers and fallback handlers.
   Cover valid and invalid values, omission, zero/false, conflicting aliases,
   mode combinations, stop controls and context/output boundaries. Follow the
   value into the sampler or other consumer; parser acceptance alone is
   insufficient. Record documented native semantics such as greedy sampling
   normalization separately from the original request. An unsupported field
   that is ignored or replaced is a contract defect, even if the request succeeds.

4. **Verify application directly when authorized.** Prepare bounded synthetic
   tests for the advertised settings and supported combinations. Capture
   server-resolved values and evidence that the template, sampler, stopping or
   other relevant path consumed them. Check explicit failures for unsupported
   settings, including error status and message and absence of substitution.
   Exercise prompt-plus-output accounting and output stopping; distinguish
   configured limits from tested limits. If seed reproducibility, concurrency,
   cache reuse or speculative decoding is part of the advertised contract,
   test the relevant claim directly. A cache claim needs a real cold-to-warm
   hit; matching settings do not prove numerical equivalence. State what the
   tests cannot establish. Pending approval means this stage remains untested.

5. **Verify the chain and assign readiness.** With the respective owners and
   required authorization, compare the Hourglass request, DSG's forwarded
   request, selected backend identity, resolved settings and returned result
   or error. Parameters and inputs must survive unchanged; record declared
   model-ID routing separately. Source-only forwarding tests do not certify a
   deployed route. Any input transformation, fallback or retry must be exposed
   as a limitation, not included in an exact-forwarding claim. Record readiness
   for the named profile, route and tested scope only, with open limitations,
   their owners and the evidence still needed.

## Per-backend contract

Create one instance of this compact record for each distinct model/runtime
configuration. Link detailed receipts instead of copying logs or deployment
history into it. Use **unknown**, **unsupported** or **untested** explicitly;
never fill missing evidence with assumed defaults.

**Identity:** backend/native model ID; upstream model label and intended worker;
model revision/quantization; runtime/build; template/tokenizer identity; date.

**Status:** not ready / ready for the stated scope. Name the supported profile,
route, evidence date and unresolved limitations. Mark offline-only evidence.

| Wire parameter/path | Type and valid values | Default and omission/null behaviour | Overrides or interactions | Application evidence | Unsupported-value error / gap |
|---|---|---|---|---|---|
| One row per exposed parameter | Exact range, enum or sentinel | Keep omitted distinct from explicit zero/false | Precedence and forced values | Resolver and direct-test receipt links | Expected and observed result |

Account for temperature, top-p, top-k, min-p, repetition/presence/frequency
penalties, seed, stop strings/token controls, output limits and any additional
settings exposed by this backend. Mark unsupported controls rather than
advertising the union of several servers' capabilities. State total-context
semantics, prompt accounting and output-limit alias precedence.

**Thinking choices:** use a small mapping table for each exposed client label:
mode → exact wire fields → valid reasoning levels → omission/default → history
preservation → required sampling profile → evidence/status. State which settings
must be nested in template kwargs. Do not assume `off`, `none`, `high` or `max`
mean the same thing across backends, or that effort selects a token budget.

**Evidence:** keep these three records distinct for each tested case:

| Record | Required contents |
|---|---|
| Requested | Exact synthetic request at Hourglass and DSG egress, including zero, false and omitted fields; selected route/model |
| Server-resolved | Identified parser/default/template/sampler result; explicit offline or live provenance |
| Directly tested | Observed application or error, test conditions and limits; “not run” where applicable |

**Readiness decision:** all advertised choices have valid-value and omission
contracts, application evidence, explicit unsupported-setting failures and
verified forwarding to the intended deployed backend. An ignored or substituted
setting, unverified route or missing direct test leaves the affected scope not
ready. A narrower verified profile may be recorded separately, without implying
the defect is fixed or authorizing a production capability reduction. List each
remaining gap and its owner; do not call acceptance alone “honoured”.

## References

- [OpenAI-compatible worker configuration](openai-endpoints.md)
- [DSG forwarding contract and limitations](hourglass-dsg-contract.md)
- [Testing endpoint](testing-mode.md)

Keep per-installation observations, deployment history and backend audit handoffs
in private operational records, following the [publication policy](publication-policy.md).
