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
