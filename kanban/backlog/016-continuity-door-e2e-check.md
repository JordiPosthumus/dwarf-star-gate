# Routine: Continuity Door + fleet health end-to-end check
Door holds calls during core restart; verify after every gateway change:
- /health on :30000, one generation through the door on PoolModel
- no worker quarantined (esp. chunked-body sensitivity on local oMLX/ds4)

## PASSED (2026-09-22 ~03:00, after card round 3 + direct-reserve + power backend)
- /health on :30000 (door): 3/6 healthy, 3 available. No worker quarantined.
- Door status: holding=false, core_ready=true, forwarded without failure counts.
- One PoolModel generation through the door: 200, served by glm53f-m3, 561ms.
- Door/core/store all on post-change code paths. Next check: after next core restart.