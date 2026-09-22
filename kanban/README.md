# Star Gate Kanban

Minimal card system. One file per card, one folder per column.

- `backlog/` — agreed, not started
- `doing/` — actively being worked (max a few at a time)
- `done/` — finished (dated)

## Card format

A card is a small markdown file named `NNN-short-slug.md`:

```markdown
# Title
One-paragraph description of what "done" means.
- step
- step
Notes: context, decisions, links.
```

Move a card by `mv`-ing it between folders. Add a `Done: 2026-09-21 — outcome` line at the bottom when finished.

Rules of the road (matching the Genie autonomy model):
- Anything that restarts the gate or touches serving: allowed, but use the Continuity Door and note it in the card.
- Anything needing Jordi's taste (UI wording, priorities): leave in `backlog/` with a `Needs Jordi:` line.

## Current order — 2026-09-22

`doing` means active; `backlog` means pending. Keep implementation focused:

1. **#032 Household recovery** — finish the outstanding M3 gateway verification.
2. **#030 Shared fleet power controls** — prevent conflicting commands and deliver
   useful UI/Genie controls while keeping household serving available.
3. **#033 Fleet catalogue and truthful status** — reconcile models, workers,
   machines and launch scripts without dropping working capabilities.
4. **#028 Genie admission through dashboard chat** — reuse those controls;
   Telegram (#006) is not a prerequisite.
5. **#004/#005 Media registry and pair placement**, followed by #019 presentation.

#016 is a validation checklist used during releases, not a separate permanent
active task. #014 broad sweep and #034 state-module extraction remain pending;
neither blocks household recovery or working controls. Other backlog cards retain
their scope and decisions. Hourglass runs remain owner-requested only.
