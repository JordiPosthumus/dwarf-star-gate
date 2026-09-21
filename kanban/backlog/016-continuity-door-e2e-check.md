# Routine: Continuity Door + fleet health end-to-end check
Door holds calls during core restart; verify after every gateway change:
- /health on :30000, one generation through the door on PoolModel
- no worker quarantined (esp. chunked-body sensitivity on local oMLX/ds4)
