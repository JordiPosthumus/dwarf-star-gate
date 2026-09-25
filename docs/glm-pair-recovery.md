# GLM pair recovery: transaction and verification

The pair transaction and GLM cache verifier are implemented components. Automatic
pair enrollment, the detached controller connection and native restart acceptance
are still incomplete. Enabling the existing recovery switch does not enroll a
GLM pair. A successful paired-media return is evidence for that operation, not
general service-recovery certification.

## Exact pair transaction

`recovery_pair.py` accepts a private enrollment with two distinct native machine
identities, exact container IDs, complete normalized Docker definitions, image
identities, mounted-file hashes and modes, and the head recipe files. Context and
concurrency must match the pinned head environment. The configured head port,
model and worker ID are part of the enrollment fingerprint. A rank without its
own recipe directory is supported; its mounted configuration remains pinned.

Restart requires current native fatal-accelerator evidence or an explicitly
authorized canary. Starting requires both exact containers to be stopped. An
initial partial pair, unknown state, paused/restarting container, changed machine,
changed image, changed command/environment/mount or changed file refuses. Recovery
does not recreate containers, download models, pull images or rewrite settings.

The transaction stops head then rank and starts rank then head. Every native
command follows a durable intent. A lost acknowledgement leaves an uncertain
operation. A subsequent observation may advance that same operation only when
the exact native state proves the pending step; it never repeats an uncertain
command. An ownership interruption waits under the same action ID. A conflicting
operation or external peer restart cannot be adopted silently.

`recovery_pair_native.py` supplies fixed SSH commands, strict host-key checks,
native listener ownership, timestamped CUDA evidence, bounded file snapshots,
private atomic/fsynced journals and an exclusive OS file lock. The controller must
provide current ownership checks and a detached runner; this module deliberately
does not expose a standalone mutation CLI. Transaction completion means the
containers returned, not that serving, cache reuse or routing admission passed.

## GLM generation and cache verification

The `glm53_vllm` recovery verifier checks the enrolled model's current context
metadata, then runs cold A, cold B, warm A and warm B. Each cold prompt must have
at least 16,384 tokens and zero cached tokens. Each warm result must retain a
nonshrinking history and reuse at least 4,096 tokens, with at most 8,192 tokens of
the original prefix uncached. Ordered usage samples are retained in a distinct
GLM proof; Qwen and DS4 receipts cannot substitute for it.

These synthetic requests retain the server's template/thinking defaults and the
actual returned assistant messages. `max_tokens=4096` applies only to the check
requests; it is not a production output cap. No cache is reset. The check does not
exercise maximum context, output or concurrent-request boundaries, certify
container identity, or measure an isolated performance benefit.

Actual Genie can run this verification independently of a restart using
`verify_serving` with `check="glm-cache"`, the configured worker ID and one action
UUID, then observe `admission_status`. The worker must already be healthy,
admitted and free of ownership holds. The diagnostic requires an exact configured
paired-media binding, served model and current context; it does not enroll
recovery or change routing. Existing action IDs retain their results and are not
replayed after dashboard interruption.

## Evidence and remaining acceptance

Tests exercise every lost-acknowledgement boundary, file/configuration drift,
ownership continuation, cross-process lock exclusion and abrupt process exit
after a simulated native transition. Those are fixture results, not a Spark
restart qualification. Native acceptance must additionally bind fresh identities,
demonstrate the actual detached runner and controller continuation, execute the
GLM verifier, and admit routing only after exact identity and owner-state checks.
