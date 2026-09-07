# Calibration — retired

The speculative four-path comparator and synthetic calibration preflight were
removed on 2026-09-07. Neither had production routing or cache-transfer authority.
Their implementation and earlier design remain in Git history.

DSG retains load-based placement, conversation affinity, FIFO scheduling and
independently checked handover of eligible undispatched work. Cache reuse,
misses, restores, inventory and throughput remain passive operational evidence.
See [the simplified system](simplified-system.md#load-balancing).
