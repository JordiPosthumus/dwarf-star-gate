# Priority Lens

Priority Lens shows **Current Jobs | Priority | Reason** in the Genie tab.
The local source includes manual controls, guarded queue selection, an optional
Pi intent handoff and asynchronous Genie task naming/classification. Ordinary
DSG requests now provide the default excerpt path without a Pi extension. The
new request-based naming path still requires live activation; the earlier real-model
classification sample below did not test generated titles. Source and fixture
validation is complemented by one private deployment activation and six synthetic
classification cases on one real DS4 host. All six returned the expected priority;
this small sample does not establish broad classification accuracy or routing
benefit. Other installations still require their own activation and validation.

## Scheduling and controls

The visible Lens switch defaults on with a **one-hour eligible-wait backstop**.
Change its duration in Settings → Priority Lens scheduling, in minutes. Existing
saved durations and opt-outs are preserved; legacy states with an explicitly
unset threshold remain pending until their operator saves a duration.
Turning Lens off restores ordinary scheduling and invalidates transient advice.
Manual priorities and intentionally saved preferences survive that switch.

Each eligible conversation has one lottery entry: default weights are High 3,
Medium 1 and Low 0.5. These are relative chances at a selection, not guaranteed
compute shares. A longest eligible wait that reaches the agreed backstop takes
precedence at the next compatible free slot. Time behind an observed hold or
unavailable worker does not count as eligible waiting time. Weights are bounded
between 0.1 and 10; the backstop must be between 1 second and 24 hours.

Only undispatched conversation heads participate. Running requests, per-chat
order, ownership, maintenance holds, cache affinity and the existing drain
contract remain authoritative. A manual High/Medium/Low override persists for
the conversation until **Return to automatic**. Settings and manual changes use
revision checks and an atomic state write with a pre-change backup. Corrupt
optional priority state is preserved and visibly reported; ordinary inference
continues.

Genie supplies allowlisted priority/reason metadata. Missing advice defaults to
Medium and ordinary scheduling when all eligible entries lack advice. Uncertain
advice must be Medium. The scheduler never calls or waits for a model. Metadata
receipts retain at most 32 selections and at most 128 candidate rows each; request
bodies, titles, excerpts and free-text model explanations are excluded.

## Task titles and the content boundary

Genie generates a concise task title from at most **1,024 UTF-8 bytes** of the
latest user-role text in a request passing through DSG. No Pi extension is needed.
Only text blocks from that user message are selected; system messages, assistant
reasoning, tool messages and image data are excluded. User-role text remains
untrusted data, including any client-generated continuation serialized with that
role. Genie returns a bounded single-line title and typed priority/reason.
An explicitly supplied client title is retained instead of replacing that name.

While a title is pending, the local job row shows a **Request:** preview of up to
160 Unicode characters from the existing excerpt. It uses plain text and wraps
inside the job column. A queued row using the last observed conversation excerpt
is labelled **Previous request:**. This preview needs no Genie inference and
creates no additional retained copy: it disappears when the existing excerpt is
cleared or a title becomes available. Unsupported or still-unread requests are
labelled **Request not yet identified**, without guessing a task name.

Capture uses the already parsed body from DSG's existing passive request observer.
It does not read queued uploads early, buffer additional request bodies, change
upload/context limits or delay dispatch. The existing 8 MiB observation budget
and unsupported/encoded-body exclusions still apply; lack of observed text leaves
the title unavailable. A new queued conversation can therefore remain unnamed
until its request body has passed through DSG. Later calls in an identified
conversation reuse the last observed title; the UI tooltip marks that scope while
the new request body remains unread. Observing a different user excerpt replaces
the old intent; repeated tool-loop requests with the same excerpt reuse its review.

The configured dedicated Genie or configured DSG pool receives only the short
excerpt and intentionally saved priority preferences. The in-memory store holds
at most 1,024 intents with a ten-minute idle lifetime. Review completion, failure,
expiry, policy change or opt-out clears disposable excerpts. Generated titles
appear in the local jobs view and private correction context. Titles and excerpts
are excluded from public inference status, selection receipts, training data,
logs, diagnostic exports, notebook storage and durable affinity state.

Turning the visible Lens switch off stops new request-text capture and invalidates
pending review authority. A client may also send `x-dsg-priority-intent: off` to
skip naming and priority excerpts for its requests. DSG strips this private
header before forwarding. Ordinary Genie observer requests are excluded from
naming, preventing recursive title reviews.

### Optional early Pi handoff

`examples/pi-dsg-priority.ts` can supply a genuine Pi user excerpt before the
inference body is observed. An existing session name is optional; Pi no longer
turns the first user line into a task title. Genie names unnamed tasks. Explicitly
load the entry with `DSG_PI_PROVIDER` and `DSG_PI_BASE_URL` identifying the existing
DSG provider. It uses Pi's exported OpenAI serializer factory and preserves model,
reasoning, context, output and inference transport settings.

This optional entry announces its content boundary. `DSG_PRIORITY_LENS=0` starts
it off; `/priority-lens off` stops its handoff and sends the request-level opt-out
so the gateway also skips new excerpts. `/priority-lens on` enables handoff again.
Agent Watch and client metadata remain separate. The continuity entry's
`DSG_PRIORITY_LENS=1` explicitly enables its optional content handoff.

Schema-1 envelopes retain existing session-affinity binding. Schema-2 envelopes
can omit a title and bind to the core's existing request identity, without adding
or changing affinity headers. A request without a conversation key can still get
a generated title but cannot receive a conversation-level priority or override.
The separate JSON handoff is asynchronous and never retried after an ambiguous
failure. No raw content is placed in inference headers.

## Asynchronous Genie review

The dashboard classifier requires local management capability and enabled Genie.
It checks fresh available pool capacity before claiming work. A busy dedicated
Genie or a measured dedicated failure/long review within 30 minutes can select the free
compatible pool for this new advisory request. A core admission check refuses
pool classification if the slot has become busy in the meantime. The review is
not placed behind user work and is never replayed on another provider after an
ambiguous dispatched attempt.

A core-owned lease rejects replies at **60 seconds**, independently of the
classifier's own deadline. Inference adds **zero normal wait** for this advice.
Normal Genie review deadlines and model settings are not changed by this separate
classifier. Ordinary Genie now has its own [fast assignment](observer.md) path
for new reviews; ambiguous dispatched failures are not replayed. Its status keeps bounded outcome/timing
metadata, never its model input or response.

The preference editor stores up to 30 explicitly saved single-line rules, each
at most 256 bytes. Genie chat now accepts correction requests and returns a reviewable proposal.
A one-conversation proposal sets only that conversation's manual priority. A
general proposal lists every removed rule and every added rule, plus the count
of untouched rules, so consolidation cannot silently discard distinct preferences.
Ambiguous scope or conversation identity calls for a clarification. A bounded
clarification context is supplied with the next chat reply.

Only **Apply to this conversation** or **Confirm these preference changes** saves
the displayed proposal. Each proposal expires after five minutes; revision checks
reject intervening policy changes. Confirmation is consumed before awaiting the
core response, preventing duplicate clicks from applying twice. An ambiguous
control response is never replayed. Proposals and clarification context are
transient and separate from notebook records and fleet report metadata.

Manual Genie questions receive up to 32 current conversation identities/titles
and the confirmed rules through the private local control path. Scheduled fleet
reviews do not receive this priority context. No recent Pi excerpt is included
in this chat-correction context. Existing Genie model options and deadlines
remain unchanged. An ordinary Genie chat does not silently change this memory.
Richer client task lifecycle coverage and broader classification-quality
evaluation remain unfinished. The jobs table covers observed DSG requests; unobserved local tools and
direct-provider activity remain unknown.

## Validation

Policy tests exercise weighted distribution, many-request conversation fairness,
eligibility aging, manual races, opt-out and malformed state. HTTP fixtures prove
actual dispatch order, unchanged request bytes, active-work preservation,
no-wait classifier admission, local-only controls and content exclusion. A
clock-controlled test proves the independent 60-second deadline even when a
provider ignores cancellation.

Correction fixtures also verify scoped application, explicit rule replacement,
clarification follow-ups, stale revisions, expiry, Unicode, unknown conversations
and duplicate/ambiguous confirmations. Browser checks exercise the actual Genie
chat and review buttons; scripted model responses do not establish real-model
interpretation quality.

An optional installed Pi 0.84.4 SDK fixture uses disposable local providers and
in-memory sessions. It verifies unchanged model capabilities and `xhigh`, one
intent across a real tool loop, exact serializer affinity, and rejection of an
old lease after new user input. It neither installs nor changes a live Pi setup.

The installed Pi contract also loads both example files through the actual
extension loader, with and without affinity headers. This catches import alias
failures that inline extension factories alone cannot expose. File loading,
title handoff, capability preservation and request-level opt-out are covered;
the fixture does not install or reload any live client.
