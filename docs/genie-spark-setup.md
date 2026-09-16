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
That switch authorizes preparation; Genie need not ask permission again. Turning
it off prevents new starts. Accepted preparation continues independently of chat,
the dashboard, and its switch.

The gateway transfers its bundled public recipe files, preserving a SHA-256
receipt of that bundle. Genie chooses only an enrolled target ID: it cannot send
SSH commands, change the destination, select another image or override serving
flags through these tools. Existing containers and personal files are preserved.
The command creates fresh, stopped containers and never stops a serving engine.

The capability panel refreshes observed remote status approximately every 15
seconds while open. It shows the target, engine, phase and errors. Chat retains
the actual tool calls and results. SSH uncertainty means status is unknown, not
that the build stopped. A repeated start reads the same directory's receipt;
it does not launch a replacement. One preparation runs per remote SSH account at
a time. Logs and receipts remain in the enrolled directory. Failed or interrupted
preparation needs inspection; automatic retries are not supplied by this tool.

**Prepared is not serving.** Native qualification, configuration approval,
gateway registration and media enrollment still follow separately. No “ready”
claim should be based only on a successful image build. Existing-host native
qualification of the three public recipes is documented in the build recipes;
complete first-install acceptance on a fresh Spark remains outstanding.

Validation distinguishes layers: deterministic tools test enrollment, switches,
unknown outcomes and repeated submissions; the real pinned Hermes runtime has
called status/start/status against a controlled provider and transport; a real
local detached-process test verifies progress, completion and the per-host lock.
These tests do not stand in for downloading and building the complete bundle on a
new physical machine.
