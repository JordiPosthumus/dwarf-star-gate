# Gate Genie in Telegram

Open **Gate Genie → Telegram** in the local DSG dashboard.

1. Open [BotFather](https://t.me/BotFather), send `/newbot`, and choose the bot's
   display name and unique username. Use a dedicated bot for this installation.
2. Paste its token into the dashboard's password field and choose **Connect bot**.
   The token is verified with Telegram and stored in a private mode-0600 file
   under `runtime/genie/telegram`. It is never returned by the settings API,
   included in Genie prompts or saved in browser storage.
3. Open **Open Telegram and pair my chat**, then press **Start** in Telegram.
   The one-use link expires after 15 minutes. Pairing accepts one private human
   Telegram account; groups, forwarded pairing messages and other senders cannot
   issue Genie instructions.

Send normal text questions to Gate Genie. The channel uses the dashboard's
existing Genie, model, tools, capability switches and persistent conversation
store. It does not launch a separate Hermes agent or change harness settings.
Messages and answers sent through this channel are handled by Telegram.

The dashboard lets you select an existing Genie conversation. New replies in
that conversation, including replies to dashboard questions and automatic Genie
follow-ups, also appear in Telegram. Selecting a conversation does not post its
old history. Pending questions from the previously selected conversation retain
their original conversation and request IDs.

- `/status` reports the connection, selected conversation, dashboard fleet
  observation and whether a saved reply is waiting. It does not run a new model
  request or imply that a server operation has completed.
- `/last` retrieves the selected conversation's latest finished saved answer.
  It does not rerun its model request or tools.
- `/help` shows these commands.

The first version supports text messages. Photos, voice notes and documents are
not submitted to Genie. Forwarded messages receive an instruction to send an
explicit owner request instead of executing third-party text as an instruction.

The receiver uses outgoing HTTPS long polling; no inbound port, public tunnel or
webhook is needed. Existing webhooks are detected and preserved. Run only one
receiver for a given bot. A competing receiver is reported instead of silently
deleting the other integration. See Telegram's [getUpdates contract](https://core.telegram.org/bots/api#getupdates).

Incoming questions are saved with stable Telegram-derived request IDs before
advancing the receive offset. Repeated updates reuse the existing Genie request.
If the dashboard interrupts a Genie reply, its existing interrupted state is
reported rather than automatically rerunning tools. Replies are retained locally
and split into plain-text messages within Telegram's message-size limit.

Telegram `sendMessage` has no caller-supplied idempotency key. An uncertain send
or a crash after recording send intent is marked unconfirmed and is not blindly
resent. Read the answer in DSG or explicitly use `/last`. Known rate-limit
responses honor the retry delay. This is not an exactly-once delivery guarantee.

**Disconnect Telegram** stops reception and revokes the paired account. Existing
Genie work and conversations remain intact. Configuration/credential replacements
retain timestamped private backups. No model server or gateway restart is needed
to connect or disconnect once this dashboard release is installed.
