# Research studies

When evaluating a completed server change, Genie can include its saved operation
ID in `compare_hourglass_reports`. The comparison checks that the baseline and
candidate reports refer to the operation's worker and its previous and published
configuration revisions. Missing evidence, a failed or unfinished candidate, and
mismatched report associations remain explicit. Score arithmetic and methodology
checks are separate; matching associations do not prove that a patch caused a
speed improvement. This reads existing receipts and does not start a benchmark,
approve a change or make a keep/restore decision.

In **Gate Genie → Setup research**, choose **Research now** to ask Genie to
study the recorded setup against current public documentation and upstream work.
A study opens a normal saved chat, where you can follow sources, read the answer
and ask follow-up questions. It uses the installation's dedicated Hermes runtime,
SOUL and model connection. Connect web search and extraction through normal setup
before starting a study; without them ordinary chat remains available.

Schedules are **off by default**. Choose daily, weekly, every two weeks or every
30 days, then choose **Remind me first** or **Run automatically** and save.
Existing schedules remain reminders. The due reminder appears in the Genie tab and offers:

- **Start study**: start the requested research and open its conversation.
- **Ask tomorrow**: postpone this reminder by one day.
- **Skip this time**: move the next reminder one selected interval forward.
- **Research now**: run early even before the next reminder is due.

Automatic mode uses the existing dashboard's ten-second check to start a due
study in an ordinary saved conversation. It waits for existing Genie replies and
queued follow-ups to finish. The Public research capability must be on, web
research must be connected, and testing mode must be off. No OS cron service,
notification service or new background agent is installed. Reading status never
starts a study. After downtime, only one due study runs; missed intervals do not
accumulate jobs. The next date is measured from the accepted start. Turning the
schedule off does not cancel active work or revoke public web access in chat.
Submission failures appear in the research panel instead of retrying every tick.
Use Research now or save the schedule to clear a start failure. An accepted but
unfinished request is never replayed on restart; a later scheduled study is a
new conversation, with the prior completed evidence when available.

The research brief requests one short, supported recommendation at a time, with
an exact change, rationale, expected benefit, tradeoff, verification and dated
sources. It asks for approved configuration revisions; missing approvals are
labelled explicitly and observed records remain unapproved. Each answer saves
its configuration snapshot and source events. Expand **Setup used for this answer**
for record revisions and the research brief, or **Web research sources** for links.
Recommendations still need judgment; the UI cannot certify the model's claims.

A study now asks Genie to read full records and inspect the relevant running
servers before forming an upstream recommendation. Where supported, he compares
a candidate's affected source paths with installed source; build dates alone do
not establish whether a patch is present. Missing inspection/source support must
be reported rather than filled in by inference.

The next study receives a compact summary of the previous completed study's actual
inspection receipts, source hashes, public pages read and dated configuration
snapshot revisions. Completed follow-ups contribute their checks and the latest
completed answer is included verbatim as historical, unverified model advice, so
corrections are not lost. Failed or unfinished answers do not replace that answer.
The source summary keeps each path's latest receipt, including any returned text
window; it does not combine sections into a claim of complete source coverage.
It uses those as historical evidence and checks the current setup again. Ordinary chats do not receive this additional study context.
The Setup research panel shows recorded live checks, source reads, missing paths,
public pages read and failed checks for the last study and its follow-ups.
Search results are not counted as pages read, and selected-image inspection is not a current-server
check. Counts do not certify a recommendation or measured benefit. These summaries
are derived from existing private conversations; no extra database or scheduler
is introduced. Existing reminder and operation permissions remain unchanged.


Studies use the configured conversational toolset, including read-only server
inspection when connected. The study brief authorizes research, not benchmarking,
installation or server changes; the existing capability switches and action
permissions still apply. A research request does not approve its proposed
changes. Choosing automatic mode authorizes scheduled research; normal server
change and measurement controls remain unchanged.

Reminder settings and the last accepted study identifier live in
`research-plan.json` alongside this installation's private conversations. They
are local runtime data, excluded from GitHub. Full study history remains in the
conversation files. Updates use the existing chat endpoint's same-origin and CSRF
checks, with a revision check for stale browser controls. A repeated accepted
start returns its receipt. Restarting cannot replay an uncertain model request;
open any failed, interrupted or not-started study before explicitly starting again.
An unreadable reminder file is preserved and reported; other conversations work.

## Validation scope

Synthetic tests exercise due dates, automatic starts, busy-chat deferral,
legacy reminders, off controls, skip/postpone, persistence, duplicate requests,
stale edits, testing mode, write failures and restart without replay. Integration
checks use the installed Hermes runtime with synthetic model/search/extraction
responses to prove a study uses the existing tools and retains source evidence.
These checks do not establish the quality of a real-world recommendation or
qualify any model-server configuration change.

The automatic scheduling controls are deployed. Existing schedule settings were
preserved; deployment did not turn an off schedule on or convert reminders into
automatic studies. The controlled timer/browser and Hermes tests establish the
scheduling path; the complete live upstream-change trial remains separate.

## Model and runtime evidence during live inspection

For supported running `vllm serve` containers, `inspect_server` now reads a small
allowlisted summary of the launch model's `config.json`: architecture, model
type, attention dimensions and layer types, plus selected quantization fields.
It follows an explicit local `--hf-config-path` when present. It neither imports
model code nor resolves a remote model repository. Private and unknown fields
are omitted; the full file's hash identifies the observed bytes.

Missing files, symlinked config files, unsupported launch forms and a container
restart during the read produce an explicit unavailable result without hiding
the other inspection evidence. On-disk model configuration is not proof of the
loaded configuration or active kernel dispatch; command-line overrides are not
applied to this summary. Use this evidence with the relevant installed source
before claiming an upstream kernel applies. A registered operator name alone
does not establish that the model executes it.

The reader was exercised on an actual serving container without changing its
process, and against disposable JSON fixtures including config overrides,
private fields, malformed files and container changes. This establishes the
reader, not an upstream performance gain or a completed candidate trial.

The same inspection supplies `engine_runtime`: NVIDIA device names, reported
compute capability and driver version queried inside that container, installed
FlashInfer distribution metadata, and structured GDN prefill-selection messages
when present in its startup logs. It returns no raw logs. The log reader examines
at most the last 10,000 lines within the first 30 minutes of the current container
start; those bounds limit observation only, never server startup or inference.
A missing message is explicit and does not prove a backend absent. Logged kernel
initialization is distinct from tracing every request, and a driver/package
version alone does not establish loaded CUDA or kernel compatibility. A changed
container invalidates the combined runtime observation. None of these reads
imports the inference framework or changes the server.

## Live research exercise, 15 September 2026

The configured Genie/Hermes completed a focused, manually requested study through
production chat: one full configuration read, one live server inspection and
four official GitHub API reads. He identified the installed upstream build
commit, checked releases and merged PRs, then evaluated
[vLLM PR #55309](https://github.com/vllm-project/vllm/pull/55309).
He distinguished the PR's B200 kernel measurements from an unmeasured GB10
benefit and recommended no immediate configuration change. No benchmark,
proposal, recovery or queue move was performed.

Independent review confirmed the sources but found two answer defects: the
upstream commit date was blurred with the release publication date, and a claim
about every released image exceeded the inspected evidence. The original answer
was retained and a correction completed in the same conversation. It fixed those
two claims but then inferred patch absence from the base commit's date, despite
unexamined local repairs. That inference remains unsupported: dates and version
labels do not establish local patch contents. This exercise
proves live inspection and research integration, not consistently correct advice,
an automatic upstream watcher, candidate compatibility or measured improvement.

A subsequent read-only comparison of the installed source supplied stronger
evidence: the model-level PLE residual addition and QSA gate multiplication are
still separate, one upstream target file is absent, and the PR's runtime hunks
do not apply cleanly to the repaired implementation. Forward and reverse checks
ran against copied files in an isolated directory; no candidate code executed.
The dated comparison and raw evidence were attached to the existing private
configuration record and version-controlled locally. These findings describe
the inspected source paths, not every compiler optimization or a performance
result. The recommendation remains to retain the working build; this candidate
requires adaptation and separate qualification.


### Direct installed-source inspection

`inspect_server` accepts optional `source_files` with up to eight Python paths.
Configured Docker workers support installed `vllm/... .py` paths (256 KiB
combined). An enrolled local oMLX installation supports `omlx/... .py` paths in
its `omlx-src` checkout (512 KiB combined, enough for its large server module).
Local inspection also reports currently modified tracked and untracked runtime Python paths,
so a dated patch manifest is not the only way to choose relevant files.

Both return source bytes and SHA-256 hashes without importing or executing the
requested files. Missing paths are reported individually. The existing inspection
switch, private chat evidence and configured connection apply. Docker reads check
that the same container instance remains running. Local checkout bytes do not
prove which revision the running oMLX process loaded. Source reads are unavailable
with selected-image inspection. No service or model configuration changes occur.

Use actual relevant source when judging whether an upstream change is present;
a build date alone is insufficient. Keep private source contents out of public
search queries. Source presence is not proof of loaded code, compiler behavior,
patch compatibility or an improvement on this hardware. A candidate still needs
an appropriate trial and measured comparison before rollout.


For large files, supply `source_window: {"offset": 0, "length": 4000}` with one
`source_files` path, then follow the returned `next_offset` as needed. Offsets
count Unicode characters; the response labels the section and includes the hash
and byte count of the **whole file**. A final section is not a complete-file read
unless it also began at zero. Whole-file reads remain available without this
option, but Hermes may spill very large results into its private cache; this
profile does not provide a general cache-file reader. Use source windows to keep
code available in the conversation without changing model context or deadlines.
