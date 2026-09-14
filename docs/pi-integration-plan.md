# Optional Pi integration

Priority Lens and Proactive Resume were retired on 2026-09-07 at the operator's
request. Their classifiers, preferences, weighted scheduling, continuation
reviewers and enrollment adapters are no longer part of DSG. Earlier designs
and source remain in Git history.

The dashboard retains a Current Jobs view with bounded request
previews, state, placement and timing. It does not classify work. Explicit
[queue priorities](queue-priority.md) are a separate feature; compatibility,
affinity and ownership safeguards still apply. The optional continuity adapter and
[Agent Watch](agent-watch.md) remain separate capabilities; neither starts new
user turns. Normal Pi provider, model and retry settings are unchanged.
