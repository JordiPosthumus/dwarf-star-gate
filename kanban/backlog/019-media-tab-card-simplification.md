# Media tab host-card cleanup (after 004/005)
Cards are verbose ("Setup drains existing work..." repeated per card), hardcoded to
per-worker, ACE-Step-only actions. Rewrite around machine-level placement and the
engine registry; collapse repeated prose into one helper line.
