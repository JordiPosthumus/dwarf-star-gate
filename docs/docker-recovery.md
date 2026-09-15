# Docker model-service recovery

The Docker adapter restarts the same enrolled container. It does not recreate it,
pull an image, edit its command or environment, or change its restart policy.
Docker's existing policy handles ordinary container exits. Deliberately stopped
or paused containers remain stopped or paused.

For a running failed instance, Star Gate requires current fatal CUDA evidence,
the enrolled container and configuration, no admitted work, and the existing
recovery permission. Genie and the deterministic watcher use the same runner.
One restart is recorded before it is issued; an uncertain acknowledgement is
observed, never replayed. Existing maintenance and operator pauses still apply.

Install `ds4-gateway/recovery-docker.py` on the Linux Docker host in a private,
operator-owned directory. It uses Python's standard library and the Docker CLI.
Place a mode-0600 JSON file beside it containing `container` (the full container
ID) and `port` (the port **inside** the container, which may differ from the
published host port). Inspect without changing the service:

```sh
printf '%s\n' '{"action":"inspect"}' | python3 /opt/stargate/recovery-docker.py /opt/stargate/recovery.json
```

Use that inspection's `machine` and `profile` in the existing private recovery
worker enrollment. Select `adapter: "docker"`; match the gateway worker's
`url`, `backend`, SSH routes and published `remote_port` exactly. Set `helper`
and `config` to the installed absolute paths. The endpoint must already be
exclusively enrolled for recovery. Do not infer restart permission from a saved
configuration record or an inspection alone. Reconcile enrollment when an
approved server change replaces the container.

For Qwen/vLLM, explicitly select `verification: "qwen_vllm"`. It checks the
advertised model/context and two cold-to-warm conversations with thinking enabled,
retaining the actual assistant messages. The evidence distinguishes substantial
hybrid-cache prefix reuse from DS4's near-complete reuse test. It does not change
server settings or establish a new concurrency limit. Existing installations
without this field retain their original DS4 verification.

Before activating a new installation's enrollment, perform a controlled recovery
drill after draining the worker and waiting for its work to finish. Verify actual
model replies and cold-to-warm cache measurements; a successful container start
or a synthetic fixture is insufficient. Restarting clears resident memory caches.
Retain the previous enrollment and exact container/configuration as rollback
evidence. The ordinary Server recovery capability switch controls new automatic
actions; already-issued work finishes reconciliation.
