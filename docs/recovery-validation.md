# Validate service recovery on your deployment

This is a reusable acceptance procedure, not a record of anyone's fleet or a
claim that recovery is enabled on a particular installation. Follow
[bounded worker recovery](worker-recovery.md) for enrollment and supported adapters.

## Before the test

1. Back up the private service/gateway configuration and current routing state.
   Record exact model, executable, configuration and service identities privately.
2. Confirm exclusive DSG ownership of the endpoint. Direct clients are not visible
   to the gateway and must not be interrupted by an uncoordinated restart.
3. Leave automatic recovery off initially. Drain the selected worker and wait for
   both its active request and queue to empty. Keep other workers available.
4. Confirm the enrolled helper reports the expected machine/profile and that the
   service PID owns the loopback listener. Unknown identities stop the test.

## Run the operator-only canary

```sh
node ds4-gateway/recovery-control.mjs status
node ds4-gateway/recovery-control.mjs canary WORKER_ID
node ds4-gateway/recovery-control.mjs status
```

The CLI uses `config.local.json`, or `DWARF_GATE_CONFIG`. Acceptance requires:

- Exactly one restart of the enrolled service and a verified new invocation.
- Unchanged model/settings and advertised context. No cache deletion or capability
  reduction to make the check pass.
- Two synthetic conversations starting cold, then two warm continuations, with
  exact requested answers, normal completion and numerical reused-token evidence.
- A durable verified receipt. An accepted request, new PID or model-list response
  alone is insufficient. Lost acknowledgment requires observation, not resubmission.
- The worker remains paused after the canary until the operator explicitly resumes
  it. Current routing state and the historical receipt are separate.

The built-in checks use approximately 2,200-token prompts, a 32-token response
allowance and disabled thinking **for these synthetic requests only**. They do
not change normal server/client defaults. The verifier requires cold usage near
zero and substantial reuse of each continuation's original prefix; see
[`recovery-verify.mjs`](../ds4-gateway/recovery-verify.mjs) for exact assertions.

## Finish the rollout

### Optional native lifecycle fixture (not a DS4 canary)

Before touching a model service, an agent can run this opt-in macOS smoke test
from a non-root GUI session with Node available:

```sh
python3 scripts/launchd-recovery-smoke.py --run
```

It accepts no existing worker, service label, port, config or launch command. It
creates a private temporary directory and one random-label, loopback-only nonce
server, exercises native stop evidence, proves the ordinary-stop veto, restores
the exact retained bytes in canary mode, verifies changed process/same profile,
and checks duplicate suppression. It unregisters its own job and checks port
release before reporting success. Normal CI never invokes this native exercise.

The private directory and receipt are retained for inspection. SIGTERM/SIGINT
exercise cleanup; a fixture-only five-minute process lifetime limits damage if
the runner is killed abruptly. SIGKILL or host failure can still prevent job
unregistration: inspect the private helper config and exact fixture label before
any manual cleanup. Never substitute a production label or delete a loaded plist.
`cleanup:review_required` is a failed test, not permission to repeat bootstrap.

A real native fixture run verified these lifecycle checks, including the
`exact_stop_request_observed` message format. Its receipt explicitly says
`ds4_certified:false`: a nonce response is not generation or cache proof. Every
DS4 installation still needs the approved cold/warm canary above, with its own
original launch bytes, enrollment, maintenance coordination and verification.

### Complete the installation rollout

After successful verification, resume the worker, test a real request through
DSG, and confirm the configured pool guarantee and existing session affinity.
Enable automatic recovery only after validating each enrolled service. Check
that policy, receipts and operator pauses survive an agreed idle gateway restart.
Canaries count toward the normal per-worker recovery cooldown; enabling the policy
does not bypass it. Unsupported installs remain manual recovery.

### Optional stopped-service canary

Do not infer stopped-service permission from a successful restart canary. After the
restart-only path passes, capture the helper's `service_profile` while healthy, add
`start_stopped:true` and that exact private hash, then restart DSG at an agreed window.
With the test worker drained and idle, deliberately stop **only the enrolled service**
using the deployment's normal service manager. Wait for DSG to report the stable stopped
identity, then run the same operator-only `canary WORKER_ID` command. Confirm it issues
exactly one `start`, waits through normal model load, runs the same context/generation/
cold-to-warm checks and leaves the worker paused. Ordinary automatic recovery never
overrides a pause; this exact operator canary is the only stopped-service action allowed
while drained. A changed unit/binary/profile file, missing unit, open listener, failed
verification, lost acknowledgment or controller restart must never produce a second
start for the same stopped epoch. Preserve the pre-test configuration and receipts.

This canary interrupts that worker and loses its RAM-resident caches. Run it only with
explicit operator approval; synthetic tests are not evidence that a particular remote
service has been enrolled correctly.

Keep detailed timestamps, machine identities, exact runtime measurements and
operator actions in private deployment notes, never in the published Git tree
(the ignored local `runtime/` directory is suitable).
Public contributions should describe the procedure, synthetic regression evidence
and known limitations. See the [publication policy](publication-policy.md).

## Limits of this evidence

Small cold/warm checks prove only the behavior exercised. They do not inject a
CUDA fault, certify full-context or vision stability, establish every cache tier,
fix an accelerator defect, or repair an already failed client stream. Validate
long-context work, disk restoration, cancellation, service-manager behavior and
fault handling separately before making stronger claims.
