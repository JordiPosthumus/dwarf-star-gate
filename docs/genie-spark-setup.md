# Genie setup for new Sparks

Genie can prepare the shipped LLM, H3 video and ACE-Step music recipes on an
explicitly enrolled new Spark. In the private gateway configuration:

```json
{
  "spark_setup": {
    "enabled": true,
    "targets": {
      "new-spark": {
        "ssh": "new-spark",
        "directory": "/srv/star-gate/new-spark-setup"
      }
    }
  }
}
```

Use a working SSH alias with a known host key, noninteractive login and Docker
access, and a dedicated destination whose parent is writable by that account. Local worker management must already be enabled. The target needs
Linux ARM64, Python 3.12+, Docker with the NVIDIA runtime, a GB10 GPU and sufficient
free disk for all three models, images and build caches. This command does not
install host drivers, Docker or SSH credentials. Use an idle new Spark; active
GPU work makes preparation refuse to start. Do not enroll an existing serving
machine to repurpose it through this setup tool.

After loading that configuration, enable **New Spark setup** under Genie's
capabilities and ask: “Prepare new-spark with the standard Star Gate engines.”
That asks for preparation only. To continue automatically, ask: “Set up new-spark
and bring its LLM into service.” Genie uses `setup_spark` to save that request.
The existing ten-second dashboard tick wakes him when the next stage is ready:
preparation, then native LLM qualification, then gateway registration. The request
and its conversation survive dashboard restarts. No new scheduler service is used.

The setup switch grants standing permission; Genie need not ask again. Turning
it off or enabling testing mode pauses new stages. Already accepted remote work
continues. SSH uncertainty is observed without replaying work. A failed stage,
changed enrollment or Genie reply without progress is shown as needing attention,
with its conversation and original receipts retained. Repeating `setup_spark`
returns the existing request; it does not reset a failure or restart a build.

The gateway transfers its bundled public recipe files, preserving a SHA-256
receipt of that bundle. Genie chooses only an enrolled target ID: it cannot send
SSH commands, change the destination, select another image or override serving
flags through these tools. Existing containers and personal files are preserved.
Preparation creates fresh, stopped containers and never stops a serving engine.
`qualify_spark_llm` then starts only that prepared LLM on its idle new host,
compares the actual command, environment, runtime and model/cache mounts, and
runs the existing native text, tools, vision, full-context, prefix-cache and
reasoning-EOS checks. Passing leaves that LLM running. Failure is visible; only
its own unchanged idle candidate may be stopped.

Once qualification passes, `register_spark_llm` rechecks the same running
container instance and its current model/context. It saves the observed
configuration plus an immutable revision under the private library’s `history`
directory, adds an SSH-connected paused worker through the existing gateway
controls, and resumes it only if the operator/maintenance state is unchanged.
It never edits or resumes a worker that already existed. The new worker keeps
the selected baseline’s one-request capacity and 262144-token context.

The capability panel refreshes observed remote status approximately every 15
seconds while open. It shows the target, engine, phase and errors. Chat retains
the actual tool calls and results. SSH uncertainty means status is unknown, not
that the build stopped. A repeated start reads the same directory's receipt;
it does not launch a replacement. One preparation runs per remote SSH account at
a time. Logs and receipts remain in the enrolled directory. Failed or interrupted
preparation needs inspection; automatic retries are not supplied by this tool.

**Prepared is not serving.** The separate qualification and registration tools
advance that LLM to serving. Automatic recovery and H3/ACE native qualification
and media enrollment still follow separately; LLM success does not prove those. No “ready”
claim should be based only on a successful image build. Existing-host native
qualification of the three public recipes is documented in the build recipes;
complete first-install acceptance on a fresh Spark remains outstanding.
Runtime checks compare actual serving settings, while retaining both old and
current reference-document hashes: updated prose alone is not a server change.

Validation distinguishes layers: deterministic tools test enrollment, switches,
unknown outcomes and repeated submissions; the real pinned Hermes runtime has
called status/start/status against a controlled provider and transport; a real
local detached-process test verifies progress, completion and the per-host lock.
These tests do not stand in for downloading and building the complete bundle on a
new physical machine.

A real pinned-Hermes conversation has also invoked qualification and registration
against an already prepared candidate on an existing Spark. All eight native
check groups passed, including 262143 prompt tokens plus one completion token
and cold-to-warm prefix-cache hits. The new worker completed real gateway
requests. This is a component integration test with an imported preparation
receipt, not a complete fresh-host installation. Preparation, qualification and
registration remain separate tool calls, connected by the saved setup request.
A pinned-Hermes integration test has exercised all automatic wakeups across a
watcher restart with a scripted provider and transport. This verifies workflow
wiring; the existing native test verifies the actual qualification/admission
steps. Neither is complete fresh-host acceptance.
