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

Outstanding work includes the dashboard transcript facade, transcript and owner
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

## Shared native conversation input

The opt-in session control adapter routes dashboard input with Hermes's supported
`PluginContext.inject_message` into an **existing** Telegram session. The native
Telegram adapter owns turn scheduling, authorization, history and replies. Do
not use `/api/sessions/{id}/chat` as the shared input path: at the pinned version
that API starts its own agent execution outside the Telegram turn scheduler.

In the dedicated native profile, configure:

```yaml
display:
  busy_input_mode: queue
plugins:
  entries:
    stargate:
      allow_gateway_injection: true
      settings:
        enable_ui_bridge: true
        # Also retain module_directory and bridge_descriptor above.
platforms:
  stargate_control:
    enabled: true
    token: <private-random-control-token>
    gateway_restart_notification: false
    extra:
      allowed_session_keys:
        - <existing-owner-native-session-key>
```

Start with the native runtime's Python, the runtime source on `PYTHONPATH`, and
DSG's `scripts/run-native-hermes.py --config /private/profile/config.yaml`.
This small entry point discovers configured plugin platforms before Hermes
parses its explicit configuration; Hermes otherwise omits unknown platform names
at that stage. It delegates execution entirely to `gateway.run`.

Authenticated `POST /api/platforms/stargate_control/events` takes exactly
`action: send`, a canonical UUID `request_id`, an allowed `session_key`, and
`message`. Use `Authorization: Bearer <private-random-control-token>`.
Read its dispatch receipt with `action: status` and the same `request_id`.
Identical retries return the saved receipt; a different instruction under the
same UUID is rejected. Receipts survive restart in private plugin storage.
They retain the original input so an uncertain dispatch can be reconciled without
losing the owner's instruction. They are ingress receipts, not a second agent
history, and must not be exposed beyond the authenticated owner surface.

`accepted_unverified` means scheduled, **not delivered or completed**. Correlate
`[DSG request <UUID>]` in the native transcript before reporting an outcome.
An uncertain dispatch is never automatically replayed. The adapter rejects
sessions outside its explicit allowlist, and Hermes rechecks authorization and
session identity when dispatching. It creates no new session or agent loop.

The native channel test also exercises this route, retained tool history,
duplicate handling and an input arriving while a Telegram turn is running.
On macOS the upstream API deliberately disables socket address reuse; the test
waits for the same port to become available before restarting. A production
supervisor must account for that release delay and verify API readiness as well
as Telegram readiness. The dashboard facade and production supervisor are not
implemented by this adapter alone.

## Reading native history

`NativeHermesChatClient` in `ds4-gateway/genie-native-chat.mjs` reads messages from
Hermes's authenticated transcript API and uses the control adapter's `session`
observation to resolve the current routing entry. That observation reads the
pinned native adapter's active and pending session maps, including its durable
active-turn marker. Missing scheduler evidence is unavailable, never idle.

The client takes explicit DSG conversation-to-native-session bindings and a
private descriptor with `url` (loopback origin), `api_key`, and `control_token`.
It rereads credentials for every request and rejects remote destinations or
shared descriptor files. `read(id, {offset, limit})` returns a paginated
projection of native user/assistant messages plus original tool results. It
checks the routing entry before and after reading; a changed session invalidates
the observation. A full page is not represented as complete history.

Tool receipts retain their native operation state: a completed tool call that
returned a running operation remains a running operation. Only a final native
assistant record marks a reply complete. Reasoning text is not copied into the
dashboard projection. The client never writes a native transcript and never
uses the native API's separate agent execution route.

`submit` maps existing dashboard/watcher request identities deterministically to
the ingress UUID, preserving duplicate protection across retries and restarts.
The full native fixture exercises the client against actual Hermes APIs,
including busy-state observation and five visible replies after restart.
This client is staged infrastructure: selecting it as the live dashboard chat
backend, migrating historical conversations and preserving the other chat
controls remain required before cutover.
