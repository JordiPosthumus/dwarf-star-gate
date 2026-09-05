# Maintenance review — 2026-09-02

Scope: source behavior, local fixture regressions, documentation, examples,
privacy checks, dependency/test configuration and deployment drift. This is not
an independent security certification, GPU-kernel audit or complete client soak.
Baseline reviewed: `1239bc0`. Changes below require deployment of the resulting
release; committing files does not upgrade an already running Node process.

## Reproduced and fixed in this maintenance change

| Priority | Finding | Correction and regression evidence |
| --- | --- | --- |
| P1 | Valid Messages/Responses streams were classified as incomplete because only Chat Completions' `[DONE]` was recognized; repeated requests could quarantine a healthy worker | Route-specific terminal events; repeated valid streams stay healthy; explicit failure events still isolate, and output limits remain censored |
| P2 | An oversized SSE line reset the buffer mid-line, allowing a suffix to masquerade as a new `[DONE]` event | Discard through the real newline, bounded chunk decoding, split UTF-8 and numeric-only usage tests |
| P2 | An oversized full Responses terminal could exceed observation bounds and produce a false inference-failure verdict | Explicit `sse_observation_limited` outcome; bytes preserved, no success label and no quarantine solely from missing observer evidence |
| P2 | Removing a quarantined worker made compatible re-registration fail, leaving no normal path to verified recovery | Re-register paused with quarantine retained; bad model still rejected; failed verification retains quarantine; successful verification enables |
| P2 | The operator client's reused Unix socket could produce EPIPE immediately after a gateway restart | Fresh sockets for infrequent control actions; repeated restart/control regression; no mutation replay |

The legacy drain/resume CLI now shares the tested worker-control client instead
of using its older five-second timeout, which was shorter than the verified
recovery check. Its explicit timeout still means inspect state before retrying;
no automatic mutation retry was added.

The primary defect reproductions failed before their corresponding fixes. Existing
byte-preservation, failure-isolation, admission, privacy and predictor tests remain
part of the release checks. Protocol fixtures are based on the DS4 server's
actual terminal-event implementations; they do not certify every client/version.

## Documentation corrected

- README distinguishes implemented collector/Genie features from future work;
  obsolete fixed test count removed. The optional predictor remains offline.
- Changelog includes context control, collection, activity, Genie, XGB and quarantine.
- Security/contribution/credit descriptions include opt-in local controls and the
  independent predictor; no claim that Genie already has operational tools.
- Example context matches the published 262,144-token Spark baseline. Operators
  must still configure the common capacity their own fleet supports; this changes
  neither existing private configs nor native model settings.
- Spark profile retains exact recommended settings and explicit CUDA/OOM and
  sustained-workload caveats; deployment-specific measurements remain private.
- Collector and recovery docs describe protocol-specific completion, unknown
  observation outcomes and quarantined re-registration accurately.

## Outstanding work, not hidden fixes

1. **Backend reliability:** CUDA execution faults and OOM conditions remain
   unresolved reliability risks. Process restart and small cache-hit checks do
   not establish the trigger or fix. Do not attribute a failure
   to a specific allocator, cancellation, cache corruption or another agent
   without correlated evidence. Preserve launcher/model/cache settings while
   investigating. Gateway isolation cannot repair the underlying model process.
2. **Sticky queues:** an idle eligible server alongside queued home-bound sessions
   is possible by design. No ETA predictor, global work stealing or cache transfer
   is deployed. Prioritize an explainable, shadow-tested overflow policy with
   explicit session ownership; don't migrate already-dispatched work blindly.
3. **Data coverage:** numerical collection works, but a growing convenience sample
   is not calibration. Current-request input length at prediction time, model
   process epoch, detailed cache residence and compaction metadata are missing.
   Non-streaming and Messages usage need dedicated instrumentation. Raw historical
   prompts were not retained; embeddings cannot be reconstructed for those rows.
4. **Embeddings/XGB:** no encoder or vector pipeline is installed by this release.
   The first XGB artifact remains a smoke test, not an automatically improving
   routing model. Collect bounded local embeddings, refit independently, then
   validate tree count and compare against a fixed baseline before live promotion.
5. **Operator/Genie UX:** ordinary pause/remove logs lack caller attribution and
   Genie assessments remain in memory. The later bounded recovery runner now
   provides durable receipts and dedicated controls; see [recovery](worker-recovery.md).
   Endpoint editing, persistent chat and feedback remain planned.
6. **Restart and cancellation:** closing a gateway connection is not proof that
   the backend stopped computing. Service restarts, unresolved work and cache
   ownership need explicit checks before automatic retries or session relocation.
   Never treat a successful model-list probe as a completed recovery test.
7. **Publication — resolved 2026-09-05:** the maintainer selected the
   [MIT License](../LICENSE), with copyright credit to Jordi Posthumus. The root
   license, README and package metadata now grant permissive reuse explicitly;
   upstream and dependency licenses remain separate.
   Existing synthetic screenshots are illustrative, not a complete feature tour.

## Release discipline

- Run `npm run check`, `npm test`, `npm run predictor:test`, and
  `npm run privacy-check`; inspect new files and the staged diff too.
- Confirm remote CI against the pushed commit. Keep operator data, private
  configs, hardware inventory, fitted artifacts and incident logs out of Git.
- Record deliberate deployment-local differences separately. A private
  service-manager launcher is not interchangeable with the generic public CLI;
  do not overwrite it merely to make directory hashes match.
- Preserve a versioned rollback copy and record source-versus-running versions.
  A busy live gateway can remain on the preceding tested release during review;
  call that pending activation, never silently call it current.

The [roadmap priority table](roadmap.md#prioritized-delivery-order)
is the canonical next-step order. Detailed future designs are not deployment claims.
