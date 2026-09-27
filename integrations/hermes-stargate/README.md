# Native Hermes integration (staged)

This plugin supplies current DSG fleet evidence and the existing enrolled domain
tools to Hermes's native gateway. Hermes owns Telegram authorization, typing,
formatting, sessions and message delivery. The plugin contains no Telegram poller
or separate agent loop.

The plugin settings identify the installed `ds4-gateway` module directory and an
owner-only `bridge_descriptor` file. The descriptor contains only the local
`/api/genie/native-tools` endpoint and its authentication token. Before each tool
call, the plugin rereads that descriptor and obtains fresh context and tool
credentials. It cannot continue using stale endpoint tokens after a dashboard
restart. Existing domain-tool execution gates remain authoritative.

Use `stargate_native` as the dedicated gateway profile's platform toolset. Local
research tools are registered as `stargate_web_search` and
`stargate_web_extract` to retain DSG's private-query guard without replacing
Hermes's built-in tools. Profile configuration and secrets belong in private
runtime storage, not this directory.

The implementation has passed an isolated actual-upstream-gateway test with a
local fake model and tool server. It is **not yet a production migration**.
The opt-in `genie_chat.native_hermes.enabled: true` dashboard setting publishes
`genie/native-hermes/bridge.json` beside the configured gateway state file. The
containing directory is private, the descriptor has mode 0600, and restart
rotates its token. This setting exposes domain tools; it does not start a native
gateway or replace the existing Telegram channel.

`installHermes(root, {nativeGateway: true})` in `scripts/genie-runtime.mjs`
installs the pinned Hermes source, private Python and locked messaging
requirements under `runtime/genie-native-runtime`, independently of the existing
core runtime. It does not start a process or configure a bot.

Outstanding work includes shared session serialization, transcript and owner
migration, operation-follow-up delivery, and live Telegram acceptance.
Do not launch this against the live bot while the existing poller is running.
