# Optional Pi integration

Priority Lens and Proactive Resume were retired on 2026-09-07 at the operator's
request. Their classifiers, preferences, weighted scheduling, continuation
reviewers and enrollment adapters are no longer part of DSG. Earlier designs
and source remain in Git history.

The dashboard retains a read-only Current Jobs view with bounded request
previews, state, placement and timing. It does not classify or reprioritize work.
Requests retain ordinary queue order subject to compatibility, affinity and
ownership safeguards. The optional continuity adapter and
[Agent Watch](agent-watch.md) remain separate capabilities; neither starts new
user turns. Normal Pi provider, model and retry settings are unchanged.
