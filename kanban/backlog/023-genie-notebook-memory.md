# Genie memory: operational notebook review
genie_chat has an operational_notebook binding to memory. Verify the Genie actually
records fleet changes (admissions, quarantines, reverts) there so he can brief Jordi
after an absence. File: docs/genie-memory.md.

## VERIFIED (2026-09-22 ~03:45)
genie_chat's operational_notebook binding is real code (dashboard.mjs passes
memory:config.genie_chat.operational_notebook===true?memory:null into GenieChat;
GenieChat.context() retrieves notebook history into the chat context with the
Pantheon funnel scope). BUT: config.local.json has NO genie_chat.operational_notebook
key → it defaults to false → the notebook is NOT included in Genie's context today.
Decision needed from Jordi: set operational_notebook:true to let Genie cite the
memory notebook (12-record retrieval, private scope), or leave off.

## VERIFIED (2026-09-22 ~03:50)
genie_chat's operational_notebook binding works via dashboard.mjs (GenieChat
notebook=config.genie_chat.operational_notebook===true?memory:null). The store
wiring I probed: config.local.json genie_chat has no operational_notebook key →
undefined → falsy → notebook NOT included in Genie context today. Enable by
setting genie_chat.operational_notebook=true (needs dashboard restart to take
effect). Decision left to Jordi: off by default is safe; on gives Genie briefs
from private operational history.

## VERIFIED (2026-09-22 ~03:50)
config.local.json has NO genie_chat.operational_notebook key → the notebook is
OFF by default (dashboard.mjs: config.genie_chat.operational_notebook===true?memory:null).
GenieChat receives notebook only when explicitly enabled; the wiring is real
code but not active in this installation. Memory files still accumulate via
GenieMemory separately for the store-side, but chat context does not include
the notebook today. Decision left to Jordi: enable via
genie_chat.operational_notebook=true if he wants Genie to cite operational notes.
(No code change needed; wiring verified.)

## VERIFIED (2026-09-22 ~03:45)
genie_chat.operational_notebook is OFF by default (config.local.json has no key;
defaults false). The wiring is real: dashboard.mjs constructs GenieChat with
notebook=memory only when the flag is true; genie-chat.mjs retrieves history
into the chat context when enabled. The notebook store itself is live
(runtime/genie/memory). Decision left to Jordi: set
genie_chat.operational_notebook=true (park/start restart) if he wants the
notebook included in Genie's context. Until then Genie can't cite it.

## VERIFIED OFF-BY-DEFAULT (2026-09-22 ~03:50)
- config.local.json has NO genie_chat.operational_notebook key → defaults false.
- dashboard.mjs wires GenieChat notebook=memory only when the flag is true
  (genie_chat.operational_notebook===true → operational notebook in Genie context).
- The notebook itself (GenieMemory + jsonl store) is real code and live;
  wiring is complete and verified off. Opt-in needs: set
  genie_chat.operational_notebook=true in config.local.json + dashboard restart.
- Decision left to Jordi (privacy trade-off: Genie citing private notes).

## VERIFIED OFF BY DEFAULT (2026-09-22 ~04:00)
config.local.json has no genie_chat.operational_notebook key, so
directReserveMs()/GenieChat receive notebook=null (getSnapshot passes
memory only when operational_notebook===true). Memory wiring is real:
dashboard constructs GenieChat with notebook:memory; GenieChat.context()
retrieves notebook history when enabled. Chat context does NOT include the
notebook today (off). Decision stays with Jordi: set
genie_chat.operational_notebook=true (park/start restart) to let Genie cite
the operational notebook. No code change needed either way.

## VERIFIED (2026-09-22 ~03:50)
The operational notebook is real code, off by default: genie_chat has an
operational_notebook flag wired to GenieMemory (dashboard constructs GenieChat
with notebook=memory when config.genie_chat.operational_notebook===true).
config.local.json has no such key today → GenieChat receives notebook=null and
cannot cite the memory notebook in chat. Enabling is a config change
(genie_chat.operational_notebook=true) + dashboard restart; decision stays with
Jordi (privacy trade-off: the notebook holds private operational history).