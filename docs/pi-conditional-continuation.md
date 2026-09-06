# Pi conditional continuation contract

This is the proposed client API needed by [Proactive Resume](pi-integration-plan.md).
It is not implemented by Pi 0.84.4 and does not enable automatic continuation.
The API belongs inside the client that owns input, queues, session storage and
execution. An extension cannot reproduce it by polling idle state or wrapping
only its own send calls.

### Experimental reviewer source

The separate `proactive-resume-reviewer.mjs` component implements bounded Genie
advice, not a live integration or an enrollment endpoint. It reuses configured
Genie provider selection and transport. The caller must provide the exact
disclosed provider URL and model; a free pool cannot receive context merely
because it is available. This parameter is not authentication or proof of user
consent. The eventual local enrollment and authenticated controller must supply it.

The review carries one scope/ticket identity, the authorized user task reference
and at most 24 text messages totaling 32 KiB. Oversized input is rejected rather
than silently losing task constraints. The model returns only a fixed verdict,
reason code and existing message references. A continue verdict must cite the
task and latest assistant. It cannot provide a command, new scope or enrollment.
Only the client may turn valid advice into its fixed attributed cue.

The new advisory call has a sixty-second ceiling and no automatic retry or
post-dispatch fallback. If cancellation returns before the transport settles,
new reviews remain blocked until that outstanding transport finishes; settlement
does not itself trigger another review. Context and free-form model output are not stored in
reviewer status. Tests use scripted responses to verify disclosure, parsing,
binding, cancellation and transport behavior; they do not prove a real model
correctly distinguishes courtesy from owner decisions or completed work.
The reviewer is not connected to dashboard routes or the installed Pi adapter.

### Experimental native bridge source

`proactive-resume-pi.mjs` now connects that reviewer to an already-enrolled
native Pi capability inside the owning process. It requires an existing user
task, matching scope and explicit text/provider consent from the trusted host.
It subscribes only when started. No dashboard route or inference credential
grants this capability, and no real session is enrolled by loading this module.

The bridge reviews the complete supported effective text context within the
reviewer's bounds. It preserves tool-call arguments and attributed tool/custom
results, excludes private thinking, and rejects images, unsupported message
types and oversized context. It does not silently truncate task constraints.
New user messages invalidate the task binding and require fresh enrollment.
Completed advice revokes it; other non-continuation verdicts cannot submit a cue.
The same settled response is not repeatedly reviewed after failure or uncertainty.

Valid courtesy advice goes through native ticket acceptance, including its
post-persistence race check. Lost acknowledgments reconcile the same proposal;
they do not issue another one. A separate metadata receipt remains available
when subsequent inspection reports unverified progress. Acceptance still does
not prove progress. The candidate now has a separate receipt-bound progress
review; outage policy remains unfinished.

A local fixture joining the actual DSG reviewer/bridge with the Pi source
candidate passes eight tests using faux Pi generation and scripted Genie replies:
one attributed cue/one synthetic tool effect, non-continuation verdicts, held
native input, revocation, lost acknowledgment and input during durable reservation.
These are local integration checks, not installed-Pi compatibility or real-model
classification evidence. The portable default suite covers context conversion
and reviewer transport; the source-candidate integration fixture is separate.
Installed command wiring, supported lifecycle certification and deployment remain
unfinished. The installed adapter still must not advertise this capability.

### Experimental local enrollment selector

`proactive-resume-enrollment.mjs` provides an opt-in selector for a trusted Pi
host. It displays a labelled task preview, exact review providers, the text
boundary, enrollment expiry and attempt budget. The default selection keeps the
feature disabled. Receipt creation and review start only after explicit approval.
The returned enrollment has a close operation that revokes it and closes its
receipt owner; an installed command and visible opt-out control are still needed.

Pi's candidate `prepareContinuationEnrollment()` captures the admission revision,
settlement, session and model after the selector establishes its own input hold.
Its single-use approval expires after sixty seconds. It rechecks at activation,
after any asynchronous receipt creation, so intervening input or a stop cannot
turn a stale choice into authority. The prepared operation itself grants no
continuation capability. A cancelled selector creates no receipts or inference.

Four local tests use Pi's initialized terminal selector and the actual reviewer
transport component with scripted replies. They cover default decline, explicit
enable and programmatic close, human input during approval, and a stop during
receipt creation. Separate native tests cover single use, cloned scope options,
cancellation, expiry and input revision changes. This remains staged source;
real-user enrollment and the installed adapter have not been enabled.

## Evidence driving the contract

The real-Pi contract fixture holds a human prompt inside an asynchronous `input`
handler. During that interval Pi reports `isIdle: true`, zero pending messages,
no new transcript entry and no model request. After release the human prompt runs
exactly once. A fence updated only at `agent_start`, transcript append or the
next heartbeat would therefore miss input already admitted by the client.

The same fixture separately proves that deferred custom `nextTurn` messages are
absent from the public pending count and that identical custom proposal details
can trigger another turn. All three require client-owned state.

## Proposed API

Names below are a versioned proposal, not callable APIs in the installed SDK.

| Operation | Result and authority |
| --- | --- |
| `getContinuationCapability()` | Protocol version and supported guard classes; absence means advisory only |
| `inspectContinuation(enrollmentId)` | An opaque short-lived review ticket bound to the current settled state; no ticket if input preparation or any other work is pending |
| `acceptContinuation(ticket, proposal)` | A durable accepted, rejected or unknown receipt; retries with the same proposal ID return its receipt |
| `getContinuationReceipt(proposalId)` | Reconcile acknowledgement loss without issuing a new continuation |
| `revokeContinuation(enrollmentId)` | Revoke new acceptance immediately and invalidate outstanding tickets |

Enrollment is local, off by default, and separate from inference credentials,
Agent Watch and Priority Lens. It identifies the controller, DSG endpoint,
session and already-authorized task scope. It explicitly grants bounded context
review and names the Genie provider. Revocation does not abort ordinary work or
silently change native retry, model, thinking, output or cache settings.

The client owns ticket fields: process epoch, session/branch identity, settlement
generation, admission revision, enrollment revision, task-scope revision,
expiration and attempt budget. A model cannot supply or alter these values.
Tickets contain no raw transcript. Task text and Genie output never create
consent or expand authority.

A proposal contains a unique ID, ticket reference, bounded explanation and one
supported class: `courtesy_check_in` or `settled_outage`. The client constructs
the fixed visible Gate Genie cue; free-form model output is never executed as a
command. Outage proposals additionally require positive execution evidence;
unknown dispatch, outstanding tools or unresolved native retry cannot pass.

## Acceptance boundary

1. Advance the admission revision synchronously at every input entry point,
   before any awaited command, extension hook, template or provider preparation.
   Count preparation until that operation exits, including errors and handled
   commands. Human input, stops, queue writes, deferred custom context, bash,
   compaction, retry, session switches and competing controllers invalidate
   outstanding tickets. Existing input must continue normally.
2. Check current enrollment, task scope, expiry, epoch and revisions. Check all
   queues and preparations owned by the client, not just the displayed steering
   and follow-up count. Active work, completed tasks, human decisions, user stops
   and unresolved execution produce a visible rejection reason.
3. Reserve the proposal and generation in the client's durable journal. Repeated
   delivery cannot claim another attempt; a different controller or proposal for
   that generation cannot claim it either. Journal failure rejects acceptance.
4. Recheck revisions after awaited persistence. New human input must not wait
   behind journal I/O. A pending reservation is not permission to disregard a
   stop or input that arrived during that I/O.
5. In the same client-owned serialized admission operation, record the durable
   execution intent and claim the turn. No await or external callback may occur
   between the final state comparison and the turn claim. If durable intent must
   precede an asynchronous step, recheck afterward and persist a rejected receipt
   when invalidated. A restart with unresolved intent is `unknown`; never replay
   automatically. A new process epoch invalidates old review tickets.
6. Submit exactly one labelled custom cue through the owning session. Attribute
   Gate Genie in both rendered history and model context. The cue permits only
   continuation of the enrolled task, not approval of a human decision.

A synchronous turn claim is not a global lock on user interaction. Input or a
stop arriving afterward retains the normal client semantics. No extra retry,
queue draining, input dropping, history replacement or process restart is part
of this API. An implementation must audit direct SDK and agent access as well
as extension entry points; unsupported mutation paths prevent certification.

## Receipt and progress contract

Use `reserved → rejected | accepted → progress_confirmed | failed | unknown`.
Retain one durable receipt per proposal and consumed generation. A receipt binds
the custom cue to the resulting turn and subsequent execution evidence. Starting
a request proves acceptance, not useful progress or completion. A lost
acknowledgement is resolved by receipt lookup. A crash between intent and a
provable result remains unknown and blocks automatic replay. Bound attempts per
authorized task so a fresh settlement generation cannot create an endless loop.

The dashboard shows proposed, blocked, accepted and outcome records with reason,
freshness and provider disclosure. Raw task excerpts are transient and excluded
from notebooks, transport logs, training and receipt storage.

## Required implementation acceptance tests

Use real Pi with disposable sessions and a scripted backend. The existing
primitive fixture is evidence of the gap, not a passing implementation of this
contract. The future client implementation must pass:

- Input, stop and revocation during both review and journal persistence; held
  asynchronous input hooks must invalidate the ticket before any model request.
- Deferred custom messages, command handling, queued follow-ups, long tools,
  compaction and native retries; none may be inferred absent from idle alone.
- Duplicate proposals, competing controllers, lost acknowledgements and crashes
  around every journal/turn-claim boundary; no repeated tool or automatic replay.
- Session switches, forks, process restarts, expired tickets and missing/corrupt
  journal state; old authority must not cross identities or erase uncertainty.
- Courtesy check-ins versus actual human decisions, completed work and stops;
  adverse or injected task text cannot grant enrollment or action authority.
- Settled outage with positive safe-continuation evidence versus ambiguous
  dispatch; preserve native retry capabilities and prevent a second owner.
- Visible custom attribution, verified renewed progress, opt-out, content consent
  and unchanged model/provider/tool capabilities.

Only after those tests and interactive rendering checks pass should the optional
DSG adapter advertise this capability or enroll a real session.


## Candidate trusted-host commands

`registerProactiveResumeHost` supplies `/proactive-resume` and `/proactive-resume-off` to a trusted host that owns the native session and receipt factory. Enrollment names the task and review providers, requires an explicit selector choice, and remains task-local and bounded. The host starts review after the command releases its input hold. Switching, forking, shutdown and opt-out revoke the bridge; pending reviews are aborted and late results cannot restore authority. Cleanup is idempotent.

The candidate Pi runtime passes the real selector and command integration fixture: explicit approval produces one attributed continuation, and `/proactive-resume-off` displays confirmation. Thirteen bridge/enrollment integration checks pass, plus three isolated host cancellation checks. This does not establish that the installed Pi runtime supports native enrollment: these commands remain a candidate trusted-host integration, with no automatic installation or production enrollment.

### Candidate normal CLI wiring

`proactiveResumeMainOptions({getEnrollmentOptions})` now supplies the host extension factories and the candidate CLI's synchronous `onRuntimeCreated` callback. A trusted launcher can pass these options to Pi's normal `main(args, options)`. The host reads `runtime.session` for each command, so replacing a session cannot leave the command bound to the previous session. The existing lifecycle handlers revoke enrollment when switching, forking or shutting down. Without the native runtime callback, enrollment remains unavailable.

The caller still supplies the disclosed review provider, gateway, expiry, attempt budget and local receipt factory through `getEnrollmentOptions`. Loading the options does not enable review or alter model selection, CLI arguments, tools, settings, launchers or credentials. No default provider or production launcher is installed by this helper.

Three candidate CLI tests cover real faux generation through the ordinary print runner, native session replacement with the selected model and thinking level retained, and cleanup without a prompt when host setup throws. Four host tests include refusing pre-runtime enrollment and binding later commands to the current session. The thirteen native bridge/enrollment checks pass using this options helper for command registration. Candidate static, type, dependency and browser smoke checks pass. Packaged installation and live enrollment remain unverified.

### Local launcher assembly

`proactiveResumeLocalOptions` joins the candidate CLI host, existing reviewer and native receipt store. It requires an explicit loopback DSG gateway, private receipt root, review-state reader, enrollment duration and attempt budget. The caller's state reader must honor its abort signal. The selector discloses the configured providers; each later review refreshes availability and still requires the original provider/model disclosure. Metadata refresh is bounded separately and shares the review's absolute sixty-second deadline. New occupied capacity, a changed provider and opt-out prevent dispatch.

Declining creates no receipt directory. Approval creates a session-specific native store or reopens its existing store. It never removes a prior record to regain an attempt: reopening a prior acceptance becomes unknown and blocks further automatic work. A stopped refresh cannot later start inference.

The local source launcher passed version and help initialization in a disposable Pi directory. Its normal invocation supplies no diagnostic offline, model, thinking, tool or capacity overrides. Portable tests verify provider/capacity refresh and opt-out. Private integration checks include native receipt reopen behavior and attributed cues through the assembled local host after actual terminal-selector approval. These use faux Pi generation and scripted Genie responses; live judgment, installation and outage continuation remain outstanding.

### Receipt-bound progress confirmation

The enrollment selector now also discloses result review. After an accepted cue's own native run settles, `inspectProgress` issues a ticket bound to that receipt, generation and admission revision. The reviewer compares the existing task with evidence after the exact attributed cue. Positive advice must cite the task, cue and a later result; an acknowledgment, repeated pause, real owner decision or uncertain outcome cannot become confirmed progress.

`confirmProgress` validates the ticket before persistence and the native boundary afterward. Automatic cue admission stays closed throughout that write. If input races persistence, the saved verdict is historical only and the controller is revoked. A real journal failure retains unverified evidence and blocks new cues. Successful native settlement alone never promotes a receipt.

The bridge confirms progress, stops after completion, and closes enrollment on no progress, a human decision or uncertainty. Verified unfinished work can receive the next courtesy check-in within its existing attempt budget. The terminal distinguishes checking the result, verified work, owner decisions and uncertainty. Receipt metadata contains no task text or free-form model explanation.

If compatible pool capacity is occupied, a still-undispatched review can refresh availability within the same sixty-second advisory deadline. It never queues inference behind normal work or retries a dispatched model request. Opt-out aborts the wait.

Validation: 39 candidate native receipt/continuation/CLI checks, 24 private integration checks and 33 portable reviewer/host/context checks pass, along with the candidate repository check and DSG syntax checks. Fixtures cover two successive authorized synthetic steps, completion, acknowledgments, owner decisions, uncertainty, lost acceptance acknowledgment, input before transcript append, active tools and an actual progress-journal write failure. Model advice is scripted, so these tests establish the protocol and execution behavior rather than real-model judgment accuracy. The installed Pi runtime is unchanged.

### Actual process-kill evidence

Six private candidate fixtures now kill an actual Pi source process with SIGKILL: before reservation, after durable reservation, after one synthetic tool effect but before the acceptance write, after acceptance, and immediately before/after the progress-confirmation write. Each barrier is acknowledged by the owning process before the test kills it. A separate fresh process then attempts both open and create on the same receipt directory. Both operations refuse the abandoned owner; all directory entries remain byte-identical and the effect count remains zero or one as appropriate.

The tests use Pi's real session admission and receipt implementations with in-memory session history, a faux model, and a disposable filesystem effect. The progress verdict is supplied by the fixture. They prove process-crash refusal and preservation at these six boundaries, including the effect-before-acceptance gap. They do not prove disk-session restoration, power-loss durability, crash timing inside filesystem operations, automatic reconciliation of an abandoned owner, or model judgment. No owner file is removed to obtain a passing retry. The optional candidate remains uninstalled.

### Native session replacement during review

The assembled local host now passes two additional initialized-terminal tests: successful native session replacement and replacement-factory failure while a Genie request is pending. Both use the actual enrollment selector, runtime lifecycle hooks, host and reviewer. Replacement aborts the review; a deliberately late continue response is disposed before assertions, with zero cues in the old or new session. The prior receipt store reopens empty after normal lifecycle cleanup. On successful replacement, ordinary new task input still completes and the opt-out command remains available without another review.

All three assembled command tests pass. These tests use a disposable replacement factory and faux generation, so they establish host revocation through native replacement and its failure path, not persistent-session restoration or real-model judgment. No installed runtime or live enrollment changed.

### Failed-turn execution evidence

Three source-Pi/bridge fixtures now distinguish a partial tool call carried by an errored assistant response, a completed tool result followed by an assistant error, and a tool that produces an effect before throwing followed by an assistant error. The partial call executes zero times; each prior effect executes once and its result remains recorded, including the error result. Although Pi is idle with no retry pending, the native guard rejects review with `unsettled_execution`. Repeated bridge checks neither call the reviewer nor add a cue, and fresh owner input still runs without repeating the effect.

These synthetic terminal failures test refusal, not automatic outage recovery or real DSG failure classification. A recorded error result does not prove that a tool had no effect. The positive outage path still requires request-bound transport evidence, native execution accounting and a fresh task review; the clean-stop admission rule has not been relaxed.

### Isolated distribution build

The candidate now builds through Pi's offline workspace release path. Packaging exposed a missing public receipt-store export; the candidate root SDK now additionally exports `ContinuationReceipts` and its receipt/outcome types. Nine local package tarballs installed successfully with cached dependencies into a separate directory. The installed entry points were verified to resolve inside that directory, with no source-checkout imports.

The installed SDK fixture produces one attributed native continuation and one tool effect, returns the same receipt on duplicate acceptance, confirms progress and preserves that confirmation when the store reopens. It preserves the fixture's selected thinking and model metadata, including text/image support and the configured context/output fields. The bundled CLI passes version/help initialization; the candidate repository check passes. These checks use a faux model and disposable settings. They do not exercise those context/output limits, live model judgment, assembled interactive enrollment from the package, or safe outage continuation. The user's installed Pi and launchers are unchanged, and the tarballs remain private candidate artifacts.

### Packaged interactive host acceptance

An initialized terminal fixture now joins the current DSG local host with the isolated installed Pi/TUI packages. The default selector choice declines with zero model reviews and no receipt directory. Explicit approval produces one native attributed cue and one synthetic tool effect, followed by a scripted result review and visible verified-completion status. The off command remains visible and closes receipts; reopening retains confirmed progress. History, model metadata and thinking remain unchanged.

A separate private packaged launcher requires explicit candidate-install and DSG-configuration paths. It resolves the selected package's ESM import entry, requires the native receipt API, and mirrors that pinned package's CLI initialization, including its HTTP dispatcher. Its configuration and host body matches the existing source launcher. Version/help checks pass with disposable settings and create no production receipts. No existing launcher was replaced. The terminal helper is a bundled test utility, generation/advice remain synthetic, and live model validation plus positive outage continuation are still open.

### Certified no-dispatch outage flow in the source candidate

The source candidate now joins native execution evidence, explicit task
approval, fresh service readiness, a distinct outage review and progress
confirmation for a run that never reached a worker. This is experimental source
and synthetic integration evidence. A rebuilt isolated package also passes the
assembled flow; ordinary installed Pi does not contain this native path, and no
production enrollment is implied.
Outages after tool activity still require separate outcome reconciliation.

`proactiveResumeLocalOptions({outageResume: true, ...})` explicitly enables
session-start observation for the selected DSG endpoint. The default is false.
Observation alone creates no receipt directory and grants no continuation. Its
startup notice distinguishes observation from task approval. The real
`/proactive-resume` selector discloses the content/provider boundary and outage
policy; `/proactive-resume-off` closes observation and the controller. Model and
session changes close the old observation; switching models does not undo opt-out.

The passive `createContinuityAttemptObserver` still preserves fetch arguments,
response ownership and SDK retry behavior. The separately selected
`createCorrelatedContinuityAttemptObserver` adds only a missing `x-dsg-call-id`
for supported requests to the exact DSG endpoint. It preserves caller-owned IDs,
body bytes, signals and options. Closing stops further header decoration. Neither
adapter retries inference or changes context, output or thinking settings.
Validated error-envelope inspection remains bounded and asynchronous. Unknown,
pending, redirected, oversized, unsealed or exhausted observations cannot certify
execution.

Native evidence binds every observed attempt to its session and generation.
No-dispatch admission additionally requires empty error responses and no native
tool activity in that run. A transcript digest lets explicit enrollment advance
its administrative revision only when the observed transcript and generation
still match. Admission checks the digest again and preserves draft/dialog/input
fences and durable duplicate prevention. Only this alternate native boundary
issues an `undispatched_outage` ticket; its trigger is part of ticket freshness.
No transcript is persisted by the observation adapter.

The bridge requires separate outage consent and fresh readiness before review
and again before acceptance. Readiness requires recent gateway observations,
no Door hold or gateway drain, and healthy compatible pool capacity. Native
routing still owns conversation affinity and actual dispatch; readiness is not
a promise of immediate execution. A started controller polls unavailable service
without sending inference, and closes its timer on opt-out. Native expiration or
changed task state ends eligibility. Genie reviews unfinished authorized work
using `continue/outage_recovery`, independently of courtesy-check-in advice.
Empty failed assistant responses are represented as native response metadata;
error strings are not passed off as assistant statements. Completion still needs
a separate receipt-bound progress review.

The assembled fixture uses the real Pi SDK, initialized terminal and task
selector with synthetic network responses. It observes one certified failed
request before enrollment, sends zero reviews or new inference while unavailable,
then confirms exactly one attributed continuation and one tool effect after
restoration. Receipt reopen retains verified progress. Ordinary input after
opt-out carries no added correlation ID. Other fixtures reject unknown attempts,
changed transcripts, partial output, tool effects, stale input, stops, closed
observers and a second outage after review. Tests preserve history and model
metadata; they do not measure full context/output boundaries, runtime hashing
cost, real-model judgment or real failure classification. Live
validation and broader outage reconciliation remain unfinished.

### Rebuilt isolated package verification

The changed native package now builds against the existing workspace dependency
artifacts and installs offline in a new isolated directory. The previous archive
set is preserved. Source hashes match before and after building. Installed entry
points resolve inside that new directory, without native source-checkout imports.
Three smoke programs cover CLI/export/receipt behavior, the existing courtesy
terminal flow, and the new terminal outage flow described above. The outage case
uses actual installed SDK/TUI code with synthetic HTTP and Genie replies; it
includes observation before task approval and ordinary input after opt-out.
These artifacts remain optional candidates, with no normal Pi installation,
model configuration or production launcher replacement.

### Accepted cue rejected before dispatch

The source candidate can reconcile its own accepted continuation when that exact
run subsequently settles with complete no-dispatch evidence. Its progress ticket
carries the outage trigger. Native `reconcileUndispatched` checks ownership,
freshness and evidence before and after the journal write, retaining the receipt
as `failed`. It neither deletes the attempt nor refunds its budget. Unknown or
reopened ambiguous receipts cannot use this path, and an outage ticket cannot be
confirmed as successful progress. The bridge then requests fresh outage advice
before a new attempt. Tests cover a second failure, one eventual tool effect,
budget exhaustion and input during the write. This follow-up is not yet included
in the previously verified package and remains untested against a live outage.
