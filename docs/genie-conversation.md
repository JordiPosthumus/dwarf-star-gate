# Conversational Genie

Normal Star Gate setup includes a persistent conversation in the gateway's Genie tab.
Follow-up questions carry their conversation history, and each answer receives a
fresh, selected dashboard setup snapshot. The chat has no server-changing tools.
Existing background reviews and their handling of direct questions are unchanged.

## Try the interface without a model

With Node 22.22.2 or later:

```sh
npm run genie:demo
```

Open the printed loopback URL. The example fleet and answers are explicitly
labelled rehearsal data. They exercise the interface; they do not demonstrate
model intelligence or inspect an actual installation. The demo never discovers
your gateway configuration or contacts an engine.

## Install and connect Genie

Run `npm run setup -- --controls` from a fresh checkout. Setup asks for an
OpenAI-compatible model API URL and, if needed, a key and model name. It installs
Star Gate's own Hermes, Python and dependencies, then checks a real reply before
saving the completed configuration. You do not need Hermes, Python or uv installed
already. You do need Node 22.22.2+, Git, tar, internet access and a reachable model;
Star Gate does not download model weights or provision a model server.

The dedicated runtime uses Hermes revision
`2237be355906fbe6065ce1815711eee52b2d646e` and its frozen dependency lock.
A checksum-verified uv 0.11.8 installs managed Python 3.12 inside the ignored
`runtime/genie-runtime/` directory. No personal Hermes, shell startup file,
global Python environment or globally installed uv is modified. Hermes retains
its upstream license. Supported installer targets are macOS and glibc Linux,
on ARM64 and x64; release evidence must identify which were actually exercised.

For unattended setup:

```sh
npm run setup -- --controls --model-url http://localhost:8000/v1 --model YOUR_MODEL
```

For an authenticated provider, pass `--connection /path/to/private-connection.json`
with `url`, `model` and `api_key` fields. Keep that file private; do not put keys
in shell arguments or URLs. Interactive keys are hidden. Optional `--reasoning`
and `--max-tokens` select the provider's supported request settings. Fresh setup
uses the model's default reasoning behavior and an 8192-token reply allowance;
it does not modify any engine settings. Existing chat configurations retain their
explicit settings, including the earlier default `xhigh`.

Setup preserves an existing configured Genie. When adding Genie to an existing
gateway, it backs up the private config and adds only `genie_chat` after a successful
connection check. It never starts or restarts existing services. A failed download
or connection check does not claim setup completed; rerun setup to retry.
`--gateway-only` explicitly skips Genie for installations that want routing alone.

### Genie's soul

The versioned [SOUL.md](../genie/SOUL.md) defines Genie's identity, including its
loving prime directive: the smooth operation of Star Gate. [AGENTS.md](../genie/AGENTS.md)
contains the separate operating instructions. Setup seeds both into this installation's
private `runtime/genie/chat/hermes-home/` (relative to its configured state directory).
Existing identity files are never overwritten. Edit the private SOUL.md to personalize
Genie; the next message loads it through Hermes's native primary identity slot.
An empty soul fails the chat rather than silently becoming a different assistant.

Ordinary unrelated working-directory instruction files and personal Hermes homes
are excluded. The explicit installation AGENTS.md supplies operational guidance;
tools enforce available capabilities separately; public web reading has standing permission.
This does not yet enable the separate planned long-term memory system.

For a standalone preview, provide the installed `source` and `python` paths from
private `genie_chat` configuration, plus `url` and `model`, to:

```sh
npm run genie:demo -- runtime/genie-chat.local.json
```

This runs real Hermes against your selected model with an example fleet.

### Preview against your actual local gateway

To try real conversation with observed gateway status without replacing the
running dashboard, create an ignored private configuration containing:

```json
{
  "gateway_config": "/absolute/path/to/DSG/config.local.json",
  "python": "/absolute/path/to/dedicated-hermes/.venv/bin/python",
  "source": "/absolute/path/to/dedicated-hermes",
  "model": "YOUR_APPROVED_MODEL_ID"
}
```

```sh
node examples/genie-chat-local.mjs runtime/genie-chat-preview.local.json
```

This starts a separate loopback dashboard. It reads the selected gateway's normal
inline credential internally and does not copy it into the preview configuration.
It polls `/gateway/status` every five seconds and sends chat through the normal
`/v1` queue. No management connection, background review or telemetry collector is
started. Unavailable observations are labelled stale. Chat history uses its own
ignored `runtime/genie-chat-local` directory. The optional `directory`,
`max_tokens` and `reasoning_effort` settings select this preview's private storage
and model request settings. Other dashboard panels may have unavailable metrics;
this preview only connects gateway status and chat.

For integration with an existing dashboard, add the same object as `genie_chat`
from the **dedicated Hermes runtime** example (with explicit provider `url`, not
`gateway_config`) in its private configuration and start that dashboard through the normal,
approved deployment process. Its existing snapshot supplier then provides the
observed setup. When the URL is exactly this installation's local pool
(`http://127.0.0.1:<configured port>/v1`), an omitted `api_key` reuses the gateway's
inline credential in memory. Credentials are never inherited for other URLs.
Merely editing a configuration does not deploy this worktree.

## What is kept, and where

- Conversation files live under the dashboard's private runtime `genie/chat`
  directory; the standalone example uses `runtime/genie-chat-demo`.
- Each chat has its own history. A refresh or dashboard restart preserves saved
  turns. New conversation does not erase older conversations.
- A dedicated `hermes-home` lives beneath that private directory. Personal Hermes
  config, memory, environment variables and plugins are not imported intentionally.
  Use a source checkout without a project `.env` file; the bridge refuses one.
- When research services are configured, Genie has standing permission to use
  the two web-reading tools whenever useful. Their exact tool set is verified
  before inference. Without those services, chat still works without web tools.
  No server-changing tools are exposed. Other Hermes profiles are unchanged.
- Model errors do not cause automatic replay. An interrupted reply is marked as
  such; the saved user message remains. The user can ask again explicitly.
- Partial replies are visible during generation. Completed replies are saved;
  a hard process/power failure may lose the unsaved partial output.
- Drafts live in the browser's session storage. Transcript files and setup
  snapshots are private, contain potentially sensitive discussion, and are never
  included in general diagnostics or the operational notebook.

### Research public developments

Optional `genie_chat.research` configuration selects your existing SearXNG and
Firecrawl services, using `search_url` and `extract_url` respectively. Configure
their base URLs without credentials or query parameters. Star Gate adds no cloud
fallback and does not install or modify either service.

Genie can search and read public sources when they help answer a question, without
asking first or requiring a checkbox. Ordinary conversation does not require a
search. The optional API `research: false` field can suppress web tools for a
specific request; omitted uses the installation's available research services.
Reusing an accepted message identifier never starts another model call.

Research uses Hermes' existing web tool names with two small installation-specific
backends: SearXNG JSON search and Firecrawl page extraction. Public GitHub API GETs
are read directly through Hermes' URL-safe HTTP client so PR creation, update and
merge dates can be inspected. Search services can lag and a new upstream change
may already be included in local patches; the answer must state those limits.

Search queries and source URLs necessarily leave the installation for upstream
search engines and websites. Use public software topics. Credentials, local paths
and known private worker names are rejected in tool inputs; this is a practical
guard, not a general data-loss prevention system. Private configuration recipes
and raw requests are not supplied to these tools. Selected server observations
still go to the configured chat model as described above.

The conversation keeps the web-access mode, source links, access times, fetch hashes
and tool failures with the answer. Search hits are labelled separately from pages
actually read. Page excerpts above 60,000 characters are explicitly marked truncated;
conversation history is not trimmed by this feature. Source text is untrusted data,
and no tool executes commands or applies a recommendation.

This increment provides research during conversations. Public web reading has
standing permission, including for future background research once that is
implemented. It does not by itself create a schedule. Background work tied to the
new conversational Genie, its cadence and run-now/postpone controls remain work
to do. Benchmarks, installations and server changes retain their separate rules.

The UI is the existing same-origin loopback dashboard. This feature does not
introduce a public chat service, authentication platform or separate database.
It does not silently compact or trim the stored conversation; long-context
behaviour still depends on the configured Hermes/model capabilities.

## Waiting and long conversations

A turn's deadline follows the observed gateway queue allowance plus its active
request allowance. If no gateway allowances are available, the existing gateway
defaults apply (20,000 queue hours plus 100 active hours). An explicit private
`timeout_ms` can set a different deadline. A deadline terminates only that chat's
Hermes process, keeps its saved question and does not replay uncertain execution.
It is deliberately not a short timeout for a busy home fleet. Underlying provider
or Hermes timeouts may fail earlier; this deadline does not override those.

Idle conversations are fetched again only when their saved timestamp or busy
state changes; active replies still poll for output. Complete history is retained
and supplied to Hermes. Context exhaustion remains a visible model error, not
silent removal of earlier turns. Corrupt conversation files stay unchanged on disk
and are listed by filename in the chat status; healthy conversations remain usable.

Chat requests use `x-dsg-observer: gate-genie`. The gateway excludes this traffic
from request-content previews (`job.previewFromRequest`) and records it as Genie
traffic in operational counters. This header does not give queue priority or
permission to move or interrupt work.

## Checks

```sh
npm run genie:test
node --test examples/genie-chat-local.test.mjs
DSG_TEST_HERMES_SOURCE=/absolute/hermes \
DSG_TEST_HERMES_PYTHON=/absolute/hermes/.venv/bin/python \
node --test ds4-gateway/genie-hermes.test.mjs
```

The second check runs the actual Hermes runtime against a temporary scripted
provider, proving the bridge, history, setup injection and handling of a rejected
provider request without engine traffic. Failed Hermes turns are not presented
as successful answers, and raw provider errors are not copied into transcripts.
It is skipped unless the two explicit runtime paths are provided.

The optional browser proof follows the repository's existing Playwright setup:

```sh
DSG_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs npm run genie:browser
```

Browser proof covers follow-ups, reload, separate chats, draft and connection
recovery, and narrow screens using synthetic data. Screenshots stay under ignored
`runtime/`.

## Sharing

Share the code, this guide and synthetic tests. Do not commit configuration,
conversation files, Hermes homes, real setup captures or screenshots of private
conversations. Run the repository's privacy checks and review the exact staged
files before publication. GitHub publication is a separate owner-approved step.


## Handoff when chat needs help

Open **Handoff to another agent** below the chat composer, review the status
snapshot, and choose **Copy handoff**. Paste it into the agent you want to help.
Opening or copying it makes no model call, sends nothing to another agent and
does not retry, cancel or restart anything. It remains usable with the last
observed state when the dashboard connection fails.

The snapshot includes capture/observation times, configured model when it has a
simple identifier, local conversation/reply IDs, saved reply state and an
unacknowledged-submission warning when applicable. It excludes conversation
text, drafts, arbitrary error bodies, endpoints, credentials and notebook prose.
Local reference IDs are still private installation metadata; review before sharing.
The configured model is not proof of the worker used, and cached working state is
not proof that inference is still running. Close and reopen the disclosure to
capture a newer snapshot. Clipboard failure selects the text for manual copying.

The handoff asks the receiving agent to inspect the saved receipt and actual
request/process state, preserve current capabilities/history, avoid ambiguous
replay, and verify the smallest repair. It does not grant new server authority.


## Share the operational notebook with chat (explicit opt-in)

The existing notebook can supply conversation context when both its memory toggle
and the private `genie_chat.operational_notebook` setting are enabled. The latter
defaults to off. Enabling it authorizes sending the selected notebook records,
including operator-note prose, to the configured chat model provider. If that
connection uses the gateway pool, its eligible model workers may receive them.
Choose the provider accordingly; this is separate from enabling notebook storage.

After deciding that sharing is appropriate, add `"operational_notebook": true`
inside the existing private `genie_chat` object. Preserve every other connection
setting. Restart only the dashboard after its chat/review work is idle. The chat
footnote shows access, and each answer's **Setup used for this answer** disclosure
lists the exact records and revisions supplied. The ordinary notebook controls
still provide correction and archiving. This adds no model-driven notebook writer.

Retrieval reuses the notebook's existing maximum of 12 records / 16 KiB, prioritizes
operator notes, and selects current workers plus fleet notes. It refreshes after
a queued question's review wait. Unavailable or disabled memory is explicitly
reported and does not block chat. Notes remain historical evidence and hypotheses,
never approval or current health proof. The snapshot used for an answer is saved
with that answer; later notebook edits do not rewrite earlier evidence.

Set the option to false to stop adding notebook context after the idle dashboard
restart. Turning off the existing memory toggle also removes it from subsequent
dispatches. Neither operation cancels a dispatched request or erases saved chats.
Earlier answers may quote notes and remain part of conversation history.

Notebook content stays out of general status, diagnostics and Copy handoff.
Attached notebook IDs, digests and worker/action references are blocked from public
web-tool inputs, and Genie is instructed never to send notebook prose to those
tools. The identifier filter is not a general guarantee against a model paraphrasing
private text; only enable sharing for notes appropriate for this provider and chat.
No live installation is opted in by installing this code.


## Follow-up queue

You can send another question while Genie answers. Each question is saved before
acceptance and shown as waiting, then answered in conversation order. The next
answer receives completed earlier turns and a fresh setup snapshot; later queued
questions are not included prematurely. Other conversations remain independent.
This reuses the private conversation files and existing dashboard tick.

If an answer fails, later questions stay saved and pause. Review the unfinished
answer, then use **Continue queued questions**. This continues only the waiting
questions; it never replays the failed request. A stale or duplicate continuation
cannot release a newer pause. Testing mode also holds accepted waiting questions
and resumes them after testing ends. It does not cancel an active answer.

On dashboard restart, a saved reply already marked working becomes interrupted;
following questions pause for review. Questions saved as queued were never sent
to the provider and can resume automatically. Failure to save a new question
is reported as not accepted, and must not detach or discard an answer already
running. Failed result writes stop further dispatch and retain an explicit error.
This establishes process-restart behavior, not a power-loss durability guarantee.

Conversation files retain version 1. A waiting reply is saved with the existing
working state plus an explicit not-dispatched marker. Older readers preserve the
messages but classify all working replies as interrupted; they cannot continue
the new queue. Reopening that older reader's saved interruption never replays it.
Keep the compatible reader for queue continuity, and never replace newly accepted
messages with old chat backups during rollback.
No new model/provider, queue priority, native concurrency or server power is added.

### Activity while waiting

Each unfinished answer shows elapsed time, the latest model step or research
activity, and time since the last reported activity. Hermes reasoning callbacks
provide a character count, never reasoning text. Search queries and page links
remain visible while the answer is pending. An open sources panel stays open
through refreshes. A lost dashboard connection is labelled as unknown progress;
quiet time is not presented as proof of either a stall or continued generation.

A follow-up queued inside a conversation is distinguished from a request already
sent to the provider. Provider queue position is not available through this
progress channel. Providers that buffer their responses may produce no reasoning
activity until they return; the display states that limitation. Older saved
requests still show elapsed time and any recorded research activity.

### Let Genie inspect server configurations

Genie can read the full private configuration library and inspect configured
Docker workers himself. Enable this in the installation's private configuration:

```json
{
  "server_records_directory": "runtime/server-records",
  "genie_chat": {
    "inspection": {
      "workers": {
        "example": {
          "ssh": ["example-host", "example-fallback"],
          "container": "example-engine",
          "launcher": "/srv/inference/launch.sh"
        }
      }
    }
  }
}
```

Merge the example into the existing model connection; keep its other fields.
The worker must already appear in the gateway. The SSH aliases use the operator's
existing OpenSSH configuration and keys. The host needs Python 3 and Docker access.
`launcher` is optional. Use an empty `workers` object for record access alone.

The tools accept a worker ID, never a shell command or file path from the model.
They read the observed/proposed/approved records and a fixed live collector reads
Docker metadata and the selected launcher. No launcher is executed. Configured
SSH fallback is used for connection failures. Unsupported server types report
that inspection is unavailable. These tools do not run inference, hash weights,
restart a server, approve a record, perform a restore drill or publish anything.

Enabling inspection shares full private configuration evidence with the configured
Genie model, including paths and local artifact identities. Review that provider
choice. Credential fields are withheld; launchers with detected credential
assignments and commands with credential options are refused. Keep secrets in
separate credential files. This filtering is not general data-loss prevention.
Private identifiers learned from inspection are also checked before web queries;
Genie must still prepare and review a separate sanitized public reference.

Each inspection's time, result and content revision remain with the answer under
**Server inspection evidence**. Compare an inspection with dated records before
accepting a baseline. Current launch arguments are evidence of the launch setup,
not proof that every advertised runtime feature or restoration path works.

### Installation visibility

The chat's **Genie installation** disclosure reports whether installed `SOUL.md`
and `AGENTS.md` match the bundled defaults. Differences are preserved, including
personal edits; reporting a difference does not authorize an overwrite.

Hermes provenance separates the expected pin, a source marker, an installation
receipt and the runtime's own Git repository. An enclosing Star Gate repository
is never treated as Hermes. A locally recorded source comparison, when present,
is shown with its date and scope; it does not certify later edits or dependencies.
Setup refuses to reuse a dedicated checkout whose tracked source was edited.

The progress display reports elapsed time and the last actual model/tool activity.
A quiet period is not proof of a stalled model. Existing queue/request deadlines
are preserved; this interface introduces no shorter cancellation limit.

Genie can open the `baseline_reconciliation` or `recreation_capture` JSON artifact
referenced by a worker's observed, proposed or approved record. The file must be
inside that installation's configuration-library artifacts directory and match
the recorded SHA-256; symlinks and changed files are refused. The small baseline
manifest is the first place to check existing model-revision and verification
facts. Artifact contents are dated evidence, not fresh inspection or approval.
This does not grant arbitrary file access or permission to execute a recipe.

For self-hosted public research, see the [fetch-protection integration reference](../examples/firecrawl/README.md).
The Gate Genie installer does not automatically patch an independently installed
scraper. A working model connection and a correctly configured research service
are separate setup facts.

For configured Docker workers, `inspect_server` also queries the installed
`vllm`, `torch` and `transformers` distribution versions using Python metadata
inside the exact inspected container ID. It does not import those frameworks or
run inference. Missing packages, a failed query and a container that changed
during the query are reported distinctly from successful evidence. Docker image
RepoDigests are reported separately; an empty local list does not prove that an
image is unavailable elsewhere. Neither labels nor package versions establish
build ancestry or complete source integrity.
