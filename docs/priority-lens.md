# Priority Lens

Priority Lens shows **Current Jobs | Priority | Reason** in the Genie tab.
The local source includes manual controls, guarded queue selection, an optional
Pi intent handoff and asynchronous Genie classification. This is source and
fixture validation; it does not claim that an existing fleet has been upgraded,
or that real-model classification quality has been measured.

## Scheduling and controls

The visible Lens switch defaults on. Queue priority remains inactive until an
operator agrees and saves an eligible-wait backstop in Settings; there is no
silently chosen production threshold. The UI identifies that pending state.
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

## Optional Pi content boundary

Agent Watch and the existing client metadata adapter remain metadata-only.
Separately opt into content handoff with `DSG_PRIORITY_LENS=1` when explicitly
loading `examples/pi-dsg-continuity.ts` for an existing DSG provider. This does
not edit Pi's models or settings and does not enable session continuation.

The opted-in adapter takes at most **1,024 UTF-8 bytes** from the most recent
genuine Pi user message and at most **256 bytes** of task title. It excludes
custom continuation messages, system prompts, model reasoning, tool messages and
image data. The configured dedicated Genie or configured DSG pool receives this
short excerpt plus the intentionally saved priority preferences. Do not enable
this handoff for a provider that should not receive that content.

The handoff requires Pi's existing serializer to supply a conversation-affinity
header matching its session ID. It never enables affinity or invents ownership.
Without that matching header, the optional handoff is omitted. A separate
bounded JSON POST goes to `/gateway/priority-intent`; the inference request gains
only an opaque correlation ID that DSG strips before forwarding to DS4. Its
inference body, reasoning, context and output options are unchanged. Content is
never put in HTTP headers. Submission is asynchronous and is not retried after
an ambiguous failure.

The core correlates either arrival order using its own admission sequence.
Newer user intent and manual/settings changes invalidate stale advisory replies.
A subsequent request with no valid intent drops old automatic advice. The
in-memory store holds at most 1,024 entries, expires idle entries after ten
minutes, and clears an excerpt when its review completes, fails, expires or is
revoked. Titles appear only in the dedicated local jobs endpoint, not public
inference status. Excerpts never enter dashboard snapshots, diagnostic exports,
training rows, logs, notebook entries or durable affinity state. The client drops
its excerpt after forming its one disposable submission.

Turning the core switch off rejects new content and clears retained excerpts;
the opted-in client may still make its disposable submission. Remove the Pi
opt-in to stop client-side capture/transmission entirely.

## Asynchronous Genie review

The dashboard classifier requires local management capability and enabled Genie.
It checks fresh available pool capacity before claiming work. A busy dedicated
Genie or a recent measured dedicated failure/long review can select the free
compatible pool for this new advisory request. A core admission check refuses
pool classification if the slot has become busy in the meantime. The review is
not placed behind user work and is never replayed on another provider after an
ambiguous dispatched attempt.

A core-owned lease rejects replies at **60 seconds**, independently of the
classifier's own deadline. Inference adds **zero normal wait** for this advice.
Normal Genie review deadlines, model settings and fallback behavior are not
changed by this separate classifier. Its status keeps bounded outcome/timing
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
Richer client task lifecycle coverage and measured classification quality remain
unfinished. The jobs table covers observed DSG requests; unobserved local tools and
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
