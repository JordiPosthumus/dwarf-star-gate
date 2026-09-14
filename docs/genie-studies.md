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

Studies have no benchmark, installation, server-control or approval tools. A
research request does not approve its proposed changes. Ordinary chat's standing
permission to read public sources is separate from starting a periodic study.

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
