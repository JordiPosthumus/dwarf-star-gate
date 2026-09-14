# Conversational Genie

This opt-in addition puts a persistent conversation in the gateway's Genie tab.
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

## Connect a dedicated Hermes runtime

Use a dedicated Hermes checkout/environment, not your personal bot's home. The
bridge uses the supported [Hermes Python library API](https://hermes-agent.nousresearch.com/docs/guides/python-library/):
`AIAgent.run_conversation()` with prior message history. The tested source revision
is `2237be355906fbe6065ce1815711eee52b2d646e`; changes to that API need a smoke test.
Hermes retains its own upstream license; it is not vendored by this change.

For a new dedicated checkout, follow Hermes' supported installation instructions
and check out the chosen revision. Use its Python environment. Do not upgrade or
modify an established personal runtime for this feature.

Create an **ignored private** configuration, for example `runtime/genie-chat.local.json`:

```json
{
  "python": "/absolute/path/to/dedicated-hermes/.venv/bin/python",
  "source": "/absolute/path/to/dedicated-hermes",
  "url": "http://127.0.0.1:YOUR_GATEWAY_PORT/v1",
  "model": "YOUR_APPROVED_MODEL_ID",
  "max_tokens": 8192,
  "reasoning_effort": "xhigh"
}
```

Use the actual approved provider settings. Optional `api_key` belongs only in
that private file, with restricted filesystem permissions. Never put a token in
the provider URL. No cloud or alternate-provider fallback is configured here.
Reasoning names vary between models: select a value that your model supports.
An unsupported value is reported as a configuration error, not silently replaced
with a lower setting. The default is `xhigh`; set an explicit supported value for
a different model.

```sh
npm run genie:demo -- runtime/genie-chat.local.json
```

This runs **real Hermes/model conversation against an example fleet**. It still
does not read actual gateway telemetry. The first message makes an inference
request to the provider you explicitly configured; ordinary provider/gateway
budgets apply. It is not a load benchmark.

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
- Ordinary messages expose no tools. An explicitly authorized research message
  exposes only the two web-reading tools, verified before inference. Neither
  profile has server-changing tools. Other Hermes profiles and the existing Genie
  are unchanged.
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

Check **Research web for this question** beside Send to authorize web access for
that message. It resets after acceptance. Requests without that permission cannot
use web tools, even if the model asks for them. The same-origin API uses an explicit
boolean `research` field; changing it requires a new message identifier.

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

The conversation keeps web authorization, source links, access times, fetch hashes
and tool failures with the answer. Search hits are labelled separately from pages
actually read. Page excerpts above 60,000 characters are explicitly marked truncated;
conversation history is not trimmed by this feature. Source text is untrusted data,
and no tool executes commands or applies a recommendation.

This increment provides on-demand research. Periodic reminders and their
approve/skip/postpone controls remain separate work; enabling these services does
not start scheduled research or approve benchmarks, installations or server changes.

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
