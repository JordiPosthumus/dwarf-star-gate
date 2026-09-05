# Pi integration: first-class, never mandatory

Design direction agreed 2026-09-05. **The control and content capabilities below
are proposed, not installed or enabled.** Existing [Agent Watch](agent-watch.md)
is advisory. The withdrawn Pi image companion is not being reintroduced.

DSG should understand Pi particularly well while remaining a normal gateway for
other harnesses. The goal is fewer stranded tasks—not a second agent that does
the work, a mandatory sidecar, or unrestricted terminal control.

## Responsibilities

| Component | Knows and owns | Must not assume |
| --- | --- | --- |
| Pi harness | Session/turn identity, active tools, local retries, compaction, queued input, user stops and supported follow-up submission | Quiet work is safe to replay, or gateway advice grants new user permission |
| DSG core | Request receipt, queue/dispatch state, transport outcome, worker eligibility, holds and bounded action authorization | HTTP completion means the agent task finished; absent traffic means a hung session |
| Gate Genie | Reviews permitted evidence, explains a diagnosis, proposes a continuation or priority recommendation | His confidence overrides a client race, user stop, ambiguous execution or maintenance hold |

**Pi reports; Genie judges; fixed guards authorize; Pi performs the accepted
follow-up.** Inference continues when this optional integration or Genie is down.

## Independent permissions

| Capability | Default / scope | Purpose |
| --- | --- | --- |
| Agent Watch | Existing opt-in metadata-only reporting | Distinguish tools, queueing, active responses and settled failures |
| Task review | Proposed; off; separate consent to bounded task/last-turn context | Distinguish routine continuation check-ins from genuine human decisions |
| Session Rescue | Proposed; off; explicit client/session and authorized-task scope | Permit an eligible client-owned follow-up after a fresh independent check |
| Priority Lens | Proposed; off; persistent separate consent to bounded request snippets | Advise priority among undispatched requests under fairness and cache guards |

One capability never enables another. Status reporting grants neither transcript
access nor control. Priority Lens does not grant Session Rescue. Show the Genie
provider receiving permitted content, byte/retention bounds, consent, exclusions
and revocation controls. No system prompts, hidden reasoning, tool arguments,
images or full transcripts by default. Retain bounded numerical receipts, not
raw snippets in logs, notebooks, browser diagnostics or training data.

## Session Rescue: start with the easy case

The first action is **continue an existing settled session**, not restart the Pi
process, abort a request, replay a tool or recreate a lost session.

| Observed situation | Decision |
| --- | --- |
| Unfinished authorized task; only “should I keep going?”; user opted in; Pi settled | Propose one labelled continuation; automatic acceptance only after the guards below pass |
| Missing preference/fact, credentials, spending, destructive action, access or wider scope | Ask the human; never guess the answer |
| User paused/aborted, said to wait, or task complete | Leave it alone |
| Tool, stream, retry, compaction or queued follow-up active | Already working/waiting; no rescue |
| Stale heartbeat, restarted client or unresolved earlier dispatch | Unknown; reconcile or request human review |
| Settled failure | Later, separate recovery class requiring positive execution/transport evidence; not the easy check-in case |

There is no “question mark means yes” rule. Genie needs enough explicitly
permitted task context and a current enrollment scope to distinguish a courtesy
check-in from a real decision. Task text and model output are untrusted evidence,
not enrollment instructions. Without adequate evidence, abstain visibly.

Immediately before acceptance, the owning client must atomically verify:

- exact enrolled session, client epoch, settled-turn generation and task scope;
- current consent, no user stop/exclusion and no newer user activity;
- no outstanding tool/request/retry/compaction or already queued continuation;
- no unresolved execution, stale receipt or conflicting controller;
- no accepted rescue for that generation and no exhausted attempt budget.

Coordinate acceptance and durable idempotency at the client. Repeated delivery
returns the existing receipt, not another prompt. A crash with an uncertain
submission outcome requires reconciliation, not blind replay. Client restart
invalidates stale proposals; lost receipt state does not erase a possible action.

Attribute the cue visibly to Gate Genie: “Continue the already-authorized task.
This is not approval for a pending human decision or new scope.” Verify the
supported Pi submission mechanism and attribution display against the installed
version before implementing it. Do not forge a user message, inject terminal
keystrokes, patch provider/model settings or add a general shell endpoint.

The newest-first ledger distinguishes **proposed → blocked / accepted → progress
confirmed / failed / unknown**, with reason, freshness, pseudonymous target and
receipt. Acceptance alone is not recovery; progress is not task completion.
Repeated non-progress escalates to a human, not endless “proceed” messages.

## Priority Lens: a different decision

Rescue asks **“Should this settled agent continue?”** Lens asks **“Which waiting
request should run next?”** Keep permissions, receipts and success measures separate.

Current DSG placement precedes reading the request body. Pi could offer a
separately consented, bounded intent envelope correlated with an undispatched
request, without spooling or rewriting its inference body. This is a proposed
metadata path, not permission to read all prompts or put snippets in model headers
and routine HTTP logs. Missing/late intent uses ordinary scheduling; clients
without Pi support must not be starved or forced to install the integration.

Genie recommends; fixed code enforces eligible workers, maintenance, session
ordering/cache continuity, aging and maximum priority advantage. No interruption
of dispatched work. Show a concise coloured explanation. Operator feedback
becomes a reviewable, versioned policy—not arbitrary chat silently changing
scheduling. See the [full Lens plan](roadmap.md#future-opt-in-priority-lens).

## Contract and delivery checklist

Reuse the existing optional Pi integration where suitable. Define a versioned
capability contract other harnesses can implement; keep Pi event mapping in its
adapter. Unsupported versions remain advisory. Do not extend the strict current
heartbeat payload with commands without negotiation and compatibility tests.

- [x] Document the current boundary: coarse Agent Watch and scoped transport
  fixtures; no installed session control or snippet-reading capability.
- [ ] Verify supported Pi lifecycle/follow-up APIs and pin the tested contract,
  using disposable SDK sessions. Document capability/version negotiation.
- [ ] Design scoped local enrollment and separate control credentials. An
  inference key or watch UUID alone must not authorize session control. No new
  unauthenticated remote listener; make revocation prompt and explicit.
- [ ] Add observation-only review with content consent and useful “working /
  routine check-in / needs human / unknown” explanations.
- [ ] Prove operator-approved single-session continuation through real Pi and
  scripted backends, with unchanged provider capabilities and exactly-once tools.
- [ ] Test stale reviews, concurrent controllers, revocation, client/DSG restarts,
  queued input, completed tasks, stops, legitimate long work and adversarially
  similar human-approval questions.
- [ ] Offer separately opted-in automatic rescue for the proven easy class,
  bounded per generation/task with cooldown, budget and visible receipts.
- [ ] Implement Lens as a separate shadow-only experiment; measure waits,
  completions, fairness and cache costs before granting guarded authority.

Gateway-only image/compatibility continuity must still work without enrollment.
Cache-affecting visual windows retain their separate design, tradeoff/approval
and real-client validation gates. Pi integration supplements the gateway fixes;
it is not a workaround that makes them depend on a companion.
