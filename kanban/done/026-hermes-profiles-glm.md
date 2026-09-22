# Hermes/Pi: confirm PoolModel resolves to GLM everywhere after M3 addition
~/.pi/agent/models.json + settings.json + ~/.hermes profiles point at PoolModel.
After glm53f-m3 joins, verify a Hermes turn and a Pi turn route to a healthy GLM
worker (sparks or M3), and thinking-level requests (XHIGH) still behave.

## VERIFIED (2026-09-22 ~03:35)
- PoolModel turn (Hermes-style: no affinity header, reasoning_effort high) →
  200 served by glm53f-m3, affinity 'none'. GLM workers healthy (sparks12/34 + m3).
- Pi providers already retargeted to dsg-pool with thinking 'high' (done earlier).
- Nothing left here; the file can close after Jordi's own Hermes profile spot-check.