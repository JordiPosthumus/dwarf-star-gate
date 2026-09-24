# Visual check of compact cards in a real browser
Unit-tested and served, but Jordi should eyeball: dot colors, chips when busy,
Details drawer contents (charts, hardware, lights), media-operation open state,
and the 300px grid density with 5-6 workers. Screenshots welcome for tweaks.


## Browser audit

The live three-column fleet grid, activity strips, native speed charts, expanded
Details panel, disabled maintenance-held routing control, and Settings lock
description were inspected in a real browser. The audit found two status-text
issues: the catalogue attributed maintenance holds to an operator pause, and
the review panel did not say when routine reviews were off. Both have scoped
fixes; catalogue coverage distinguishes maintenance, direct reservation and
operator pause. No serving settings or enabled capabilities change.

Remaining: recheck the labels after the next idle dashboard reload; visual
preferences such as the proposed Details removal remain with #031.
