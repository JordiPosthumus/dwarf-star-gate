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