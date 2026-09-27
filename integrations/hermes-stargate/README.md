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

The native runtime carries a versioned three-site patch to the pinned Hermes
Telegram adapter. Setting `platforms.telegram.extra.preserve_pending_updates:
true` prevents queue deletion during cold startup, webhook startup and polling
conflict recovery. DSG's migrated profile must enable it. The default remains
upstream behavior for profiles that omit the setting. This patch contains no
poller or session implementation; the native adapter still handles the channel.
A competing poller must be stopped rather than resolved by discarding messages.

The installer uses a separate policy-version directory, keeps the earlier
runtime intact, verifies the exact patch on reuse, and refuses unrelated tracked
source changes. Review all three source sites when updating the Hermes pin.

Run `npm run genie:native-channel-test -- /absolute/path/to/installed/hermes-source`
after installing the native runtime. The test starts the actual upstream gateway
and Telegram adapter against local fake endpoints in a temporary profile. It
checks startup message preservation, typing, an enrolled tool receipt, rejected
unauthorized input, and history plus queued-message delivery across restart.
It never reads the installation's Telegram token or invokes production tools.
