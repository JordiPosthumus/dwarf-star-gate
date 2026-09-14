# Priority Lens

Priority Lens and Proactive Resume were retired on 2026-09-07 at the operator's
request. Their classifiers, preferences, weighted scheduling, continuation
reviewers and enrollment adapters are no longer part of DSG. Earlier designs
and source remain in Git history.

The dashboard's Current Jobs view now supports a separate, explicit
[queue priority control](queue-priority.md): high, normal or idle-only. There is
no content classifier, weighted policy, saved preference system or automatic
continuation. Active requests finish and conversation order is preserved.
The optional continuity adapter and [Agent Watch](agent-watch.md) remain separate
capabilities; neither starts new user turns. Normal Pi provider, model and retry
settings are unchanged.
