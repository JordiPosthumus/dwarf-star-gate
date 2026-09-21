# Genie reaches Jordi: Telegram gateway (plan + build)
Jordi wants the Genie to approach him proactively (e.g. "new model available, admit it?")
via Telegram instead of only the dashboard chat.
- Design: Hermes chat runtime (genie_hermes.py) already exists; add an outbound/inbound
  Telegram bridge: bot token in local config, Jordi's chat id allowlist
- Proactive messages: model-discovery events, new-model proposals, media pair-drain
  requests, dead-man revert warnings
- Conversational approval only (no buttons), matching the autonomy model
- Needs Jordi: bot token + chat id; agree message categories that may interrupt him
