# Household availability: restore and prevent stale-lock outage

Done — recovery verification is complete. Detailed deployment evidence, native
receipts, settings comparisons and maintenance chronology are retained privately.

The affinity lock records process birth identity as well as PID, so PID reuse
after a reboot cannot strand recovery. Live legacy locks and unreadable
identities remain protected, and saved affinity state is preserved.

The fleet script runner now uses detached `spawn`. A real subprocess regression
checks process-group separation; reparenting to PID 1 alone does not prove
survival after a dashboard restart. Startup and shutdown receipts independently
verify the expected endpoint/model state instead of treating script exit as
serving proof.

Completion required an actual model-specific generation through the Door,
ordinary pool serving, a released and ready Door, dashboard availability, and
model-server survival after launcher exit and dashboard reload. Native tool-use
and cold-to-warm cache checks provide additional evidence with explicit limits.
Original launcher and settings bytes were compared against their backups.

The checkers retain failures as well as later successes and make no maximum
context/output/cache-capacity or general performance claim from these canaries.
Core-side settings activation remains separately tracked in #035; new-worker
admission remains in #028. Future recipe trials do not reopen this incident.
