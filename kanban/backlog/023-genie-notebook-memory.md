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