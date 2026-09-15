# Research studies

In **Gate Genie → Setup research**, choose **Research now** to ask Genie to
study the recorded setup against current public documentation and upstream work.
A study opens a normal saved chat, where you can follow sources, read the answer
and ask follow-up questions. It uses the installation's dedicated Hermes runtime,
SOUL and model connection. Connect web search and extraction through normal setup
before starting a study; without them ordinary chat remains available.

Reminders are **off by default**. Choose daily, weekly, every two weeks or every
30 days and save. The due reminder appears in the Genie tab and offers:

- **Start study**: start the requested research and open its conversation.
- **Ask tomorrow**: postpone this reminder by one day.
- **Skip this time**: move the next reminder one selected interval forward.
- **Research now**: run early even before the next reminder is due.

A reminder is a saved due date, not an unattended model job. No OS cron service,
notification service or new background agent is installed. The dashboard calculates
whether the reminder is due when it reads chat status. If it was offline, the
same reminder appears when it returns; missed intervals do not accumulate runs.
Starting a study schedules the next reminder from that start time. Turning
reminders off does not cancel active work or revoke public web access in chat.

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
changes. Ordinary chat's standing permission to read public sources is separate
from starting a periodic study.

Reminder settings and the last accepted study identifier live in
`research-plan.json` alongside this installation's private conversations. They
are local runtime data, excluded from GitHub. Full study history remains in the
conversation files. Updates use the existing chat endpoint's same-origin and CSRF
checks, with a revision check for stale browser controls. A repeated accepted
start returns its receipt. Restarting cannot replay an uncertain model request;
open any failed, interrupted or not-started study before explicitly starting again.
An unreadable reminder file is preserved and reported; other conversations work.

## Validation scope

Synthetic tests exercise due dates, skip/postpone, persistence, duplicate requests,
stale edits, testing mode, write failures and restart without replay. Integration
checks use the installed Hermes runtime with synthetic model/search/extraction
responses to prove a study uses the existing tools and retains source evidence.
These checks do not establish the quality of a real-world recommendation or
qualify any model-server configuration change.

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
