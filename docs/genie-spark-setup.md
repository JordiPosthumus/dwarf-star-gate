# Genie setup for new Sparks

## Discovery implementation status

The development implementation adds `discover_sparks` and
`spark_discovery_status` to the Genie setup toolset. Ask “Find the newly connected
Sparks.” The scan runs independently of the tool HTTP request and retains its
scan ID, results and coverage issues in private runtime storage. Reading status
does not restart it. An interrupted dashboard reports lost observation explicitly.
Read-only discovery uses **Server inspection**; it does not turn on **New Spark
setup**, which still governs enrollment and installation.
Each scan retains its own receipt, including after later scans. When a requested
scan finishes after Genie has answered, a durable observer returns to the
originating conversation once to report that exact scan. It respects an owner
stop, paused conversation, the Server inspection switch and testing mode. It
does not rescan or grant maintenance authority. For an original onboarding request, Genie may continue its already authorized access or enrollment steps after reading the result. A discovery-only request remains read-only. An uncertain chat submission
reuses its saved request ID.

Discovery currently probes SSH on bounded directly connected private IPv4
subnets, sends at most two IPv6 all-nodes echo probes per observed link-local
interface (at most 16 interfaces, four at once, four seconds per probe window),
then reads refreshed IPv4/IPv6 neighbor caches. It inspects known SSH connections for
physical identity and peer-neighbor evidence. It reuses configured SSH usernames
and keys, verifies Linux ARM64 GB10 hardware and stable machine/GPU identities,
and deduplicates multiple addresses for the same observed machine. New host keys
are recorded in a private per-scan copy of known hosts; personal SSH files are
not rewritten. Changed keys are not accepted. An open SSH port is not proof of
a Spark. Existing hardware identities are labelled separately from candidates.
Machines identified through existing SSH aliases remain in the result even
when direct-IP login fails. `addresses` contains verified direct SSH paths;
`reported_addresses` contains interface inventory from an authenticated host,
which does not prove gateway reachability. An unverified endpoint may carry
`reported_by` for matching unscoped inventory addresses, never for a remote
link-local zone. Count hardware identities, not endpoints, as machines.
Failed SSH attempts report separate categories for authentication, connection,
name resolution, host-key trust and inspection uncertainty, without raw stderr.

The IPv6 probe can find a directly attached cable peer without an IPv4 address
when both interfaces already have link-local IPv6. Addresses retain their exact
local interface scope. VPN/tunnel interfaces and the gateway's own addresses are
excluded. A silent probe or incomplete neighbor cache never proves absence.
The probe does not assign addresses, bring links up or change routing.

For owner-requested onboarding, Genie can call `enroll_discovered_spark` with
the saved `scan_id`, hardware `candidate_id`, and a new `target_id`. No copied IP
is needed. **New Spark setup** must be enabled. The tool refuses existing
machines and scans whose configured connections have changed. It rechecks the
candidate's hardware identity using only the scan's pinned host keys, without
SSH connection sharing or alternate global/DNS trust. It then backs up normal
`known_hosts`, adds only the verified destination's key, and rechecks identity
through normal SSH before saving the target. Repeating the same saved IDs returns
the enrollment without restarting setup. Readiness and native qualification are
still separate; an enrolled target is not a tested or serving machine.

Existing SSH configuration is preserved. Conflicting keys, disabled host-key
checks, nondefault trust stores, changed destinations, and unsupported ports are
reported for inspection rather than overwritten. If enrollment loses observation
after adding trust, retain the backup and inspect setup status before retrying
the same IDs. No remote installation or service start occurs during enrollment.

## Initial access from a shared password

For an onboarding request, discovery labels eligible authentication-unavailable
private IPv4 endpoints with `endpoint_id` and `initial_access_available`.
Genie uses `request_spark_access(scan_id, endpoint_ids)` to put up to eight of
these endpoints in **Gate Genie → New Spark access**. The owner enters the
shared SSH username/password in that local form, never in chat or Telegram.
Submitting the form saves a memory-only grant and wakes the same conversation;
`bootstrap_spark_access(access_id)` performs the native work. Saved status and
completion follow-ups use the same ID across uncertain responses and restarts.

Each host is checked against its saved SSH host key and GB10 hardware identity
before a key write. Known fleet hardware is excluded. The installer adds an
existing gateway public key to `authorized_keys`, with a private timestamped
backup, preserving existing bytes and restricted keys. It verifies key-only SSH
and the same hardware afterward. Duplicate addresses do not cause duplicate
installations. No private key is created, unlocked, replaced or copied. The
gateway must already have a usable SSH key, and the host must accept ordinary
SSH password authentication. Unsupported keyboard-interactive/password-change
flows report a prerequisite rather than changing authentication settings.

The password is sent to an isolated local SSH helper through a private input
pipe, then to SSH through a terminal; it is absent from command arguments,
environment variables, tool calls, saved state and terminal logs. A grant lasts
15 minutes for starting new steps, is forgotten after the attempt, and disappears
on dashboard restart. In-progress accepted work can finish after revocation.
Wrong passwords require a fresh local grant; no automatic password retries.
A lost key-install reply permits only key-access verification on the same ID,
never an automatic repeat of the write. Active access work blocks an ordinary
dashboard restart. After key access succeeds, fresh discovery and identity-bound
enrollment are still required before the originally requested model setup.

**Automatic onboarding remains incomplete.** DNS-SD service discovery,
unconfigured cable links, IPv6-only setup and
peer-only reachability remain unfinished. Discovered enrollment currently needs
a verified IPv4 path with existing SSH key access. An IPv6
link-local neighbor observed on a remote Spark belongs to that remote interface;
it must not be used as though it were a local gateway interface. An unscoped
remote IPv4 observation alone proves neither reachability nor unreachability. Discovery
always reports partial coverage, and no candidate is marked enrollment-ready.
The new tools do not install models, update firmware or reboot machines.
Native discovery and deployment still need validation for each installation.

The following existing addressed-host workflow remains available:

Give Genie the new Spark's IPv4 address or hostname and SSH username in chat:

> Set up my new Spark at ADDRESS, SSH user USERNAME, as spark3 with the standard
> LLM, H3 and ACE-Step engines. Test them and bring its LLM into service.

With **New Spark setup** enabled, Genie uses `enroll_spark` to check SSH access,
identify the host and save its target in private runtime storage. It is immediately
available to `setup_spark`; no configuration edit or dashboard restart is needed
for each new box. The setup directory is derived from the remote user's home.
Existing worker IDs and resolved SSH destinations cannot be enrolled as new.

SSH must be reachable and accept a key available to the gateway account. First
connection accepts a previously unknown host key, after backing up existing
`known_hosts`; a changed key is refused. Personal SSH configuration and keys are
not rewritten. If login is not ready, Genie reports that prerequisite. Do not
send passwords or private keys in chat. This does not configure the Spark's
initial operating-system account, network or drivers.

Fresh `npm run setup -- --controls` installations connect this capability.
Existing installations preserve their settings; enable the setup integration
once in private configuration if it is not connected. Targets can then be added
through chat. The older explicit enrollment also remains supported:

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
preparation, native media samples, native LLM qualification, then gateway registration. The request
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
`qualify_spark_media` tests the stopped H3 and ACE-Step candidates before the new
LLM is started. It requires an idle GPU and the same per-host setup lock. It leaves existing
serving LLMs untouched and can also qualify a first, unused Spark before a gateway
fleet exists. Borrowing an already serving host still uses the separate media
execution workflow and its one-other-LLM minimum. It submits one standard native job per
engine, retains output bytes, and fully decodes the H3 video/audio and ACE music
with `ffprobe`/`ffmpeg` on the gateway machine. Both programs must be installed
and available in the dashboard's PATH; missing tools fail before an engine starts.
It waits for native idle before stopping only its own unchanged candidates.
The detached runner and native IDs remain inspectable after chat or dashboard
restart. Completed media qualification leaves all prepared engines stopped;
it does not enroll production media switching or recovery. If the new LLM was
already qualified through the earlier workflow, registration remains available;
the watcher does not stop that LLM to retrofit media testing.
`qualify_spark_llm` then starts only that prepared LLM on its idle new host,
compares the actual command, environment, runtime and model/cache mounts, installs
a dedicated copy of the bundled Docker recovery helper, and tests one same-container
restart. It then runs the existing native text, tools, vision, full-context,
prefix-cache and reasoning-EOS checks after the restarted LLM returns. The helper
and its private config live inside that qualification directory; existing helpers
are not replaced. The new host remains outside gateway routing throughout.
This adds one model reload during initial setup. The helper preserves intentionally
stopped containers and existing restart policies. Passing leaves that LLM running. Failure is visible; only
its own unchanged idle candidate may be stopped.

Once qualification passes, `register_spark_llm` rechecks the same running
container instance and its current model/context, plus the tested recovery helper
and configuration hashes when that proof exists. Earlier LLM-only qualifications
remain eligible for registration; they are not silently restarted or described
as recovery-qualified. New restart-qualified registrations also connect their dedicated recovery helper.
Completed media qualifications are matched against the same host/LLM preparation
and freshly inspected stopped engines before connecting music/video switching.
These bindings and the new paused worker are saved together in the core state,
survive a core restart, and become available to Genie’s existing inspection tools.
The new loopback endpoint is dedicated to gateway use; intentional Docker stops
remain respected. Existing recovery/media switches and static enrollments are
unchanged. A disabled capability stays disabled. An older running core that lacks
this enrollment support rejects the combined registration before adding a worker. It saves the observed
configuration plus an immutable revision under the private library’s `history`
directory, adds an SSH-connected paused worker through the existing gateway
controls, and resumes it only if the operator/maintenance state is unchanged.
It never edits or resumes a worker that already existed. The new worker keeps
the selected baseline’s one-request capacity and 262144-token context.

The capability panel refreshes observed remote status approximately every 15
seconds while open. It shows the target, engine, phase and errors. Setup status
also reports the current model-file byte count and latest file activity during
downloads, visible in the capability panel and Genie's tool results.
The byte count includes partial files; it is not
hash verification or a successful installation. Unchanged bytes can mean the
installer is checking a file. These observations do not change its deadlines or
restart its work. Chat retains the actual tool calls and results.
SSH uncertainty means status is unknown, not
that the build stopped. A repeated start reads the same directory's receipt;
it does not launch a replacement. One preparation runs per remote SSH account at
a time. Logs and receipts remain in the enrolled directory. Failed or interrupted
preparation needs inspection. For a confirmed failed preparation, Genie can use
`resume_spark_preparation` with its exact `finished_at` receipt after addressing
the cause. This preserves the same directory, verified bundled sources, download
partials and completed build receipts. A saved full setup request then continues.
Repeated delivery of that same resume observes the attempt instead of starting
another one. Running or uncertain work, changed sources, older preparations
without a source receipt, and qualification failures require inspection; this
action does not restart them. Genie must report recurring failures rather than
retrying indefinitely.

**Prepared is not serving.** The separate native qualification and registration tools
advance that LLM to serving. Recovery and media bindings require their respective qualification evidence; LLM success alone does not prove those. No “ready”
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

The new media qualification tool has been exercised by actual Genie on retained
prepared containers on an existing Spark. It generated a 4.46-second H3 video
with separate audio and ten-second ACE-Step XL/4B music; all files were retained,
hash-checked and fully decoded. Both candidate engines stopped cleanly. This
imported-candidate test is not fresh-host setup acceptance.

The latest recovery-enrollment trial distinguishes native execution from model
narration. Its actual dedicated helper restart and all eight native LLM checks
passed. Registration, media/recovery binding persistence and native helper
inspection passed separately in a disposable core. In the combined Genie trial,
the model described registration receipts without calling registration; the test
failed and no claimed registration happened. A real read-only follow-up inspected
the state and corrected that claim. A subsequent actual-model, multi-turn test
called status, registration and status through the real tool/registration code,
with simulated remote/core state, and accurately reported its fixture result.
These checks support the incremental implementation; they do not establish
complete fresh-host acceptance or guarantee every model reply uses tools correctly.
The setup watcher requires observed progress and exposes a no-progress reply as
needing attention rather than accepting the model's narrative as completion.


## Empty-directory native recipe exercise — 17 September 2026

The combined public recipes have now prepared all three engines in empty model
and installation directories on an existing Spark. Actual Genie invoked the
preparation, media qualification and LLM qualification tools. H3 produced retained
video and audio; ACE-Step produced ten-second XL/4B music. Every output fully
decoded. The LLM passed all eight native check groups after its dedicated helper
restarted it, including 262143 prompt tokens plus one completion token and two
zero-cache cold calls followed by 4800-token cache hits. Error, abort and preemption
counters stayed unchanged. Raw responses and their hashes were retained.

An isolated instance of the gateway then registered the same running, qualified
server with its recovery and both media bindings, observed a matching native
recovery identity and received a real model reply. That registration check was
driven by the acceptance runner; it is not evidence that Genie performed that
isolated registration. Genie's separate production registration attempt correctly
reported rejection because the borrowed machine's SSH endpoint was already
registered. It did not replace that existing worker.

This exercise used an existing host with Docker, drivers and build caches. It does
not establish installation on a pristine physical Spark. A subsequent music-switching cycle on a dynamically registered fresh-recipe
worker in an isolated gateway passed: actual Genie dispatch, retained and fully
decoded audio, automatic original-LLM return, cold-to-warm cache hits and gateway
readmission. This establishes that tested music lifecycle on the existing host;
it still does not establish installation on pristine hardware.

## Arrival readiness

For each new Spark, give Genie its address and SSH username as shown above.
He enrolls it, checks the prerequisites and uses the full setup workflow.
For an already enrolled target, ask: “Set up TARGET with the standard LLM, H3
and ACE-Step engines and bring its LLM into service.”
The saved workflow continues after long stages; the owner need not keep the
chat open or repeatedly say “proceed.” Two enrolled targets can advance while
one host is building; their setup conversations use the same Genie.

The pinned model manifests currently total about 227 GB per host, before Docker
images, build layers and runtime caches. Build and download time depends on the
new host and network; an existing-host cached build does not establish a
fresh-install ETA.

The Hermes integration test covers preparation, media qualification, LLM
qualification and registration across watcher reloads. It uses a scripted model
and simulated remote hosts. Public download availability checks and source hash
verification complement those tests; neither proves a new host will boot the
engines successfully. Native qualification on each arriving machine remains
required.

A separate actual-model rehearsal also called `enroll_spark` with the supplied
address and username, then `setup_spark`, and checked the saved request. Its
remote host was simulated; it proves the conversational/tool path, not a fresh
physical installation. The read-only SSH inspector has separately returned real
OS, GPU, Docker, Python, disk and active-work observations from an existing Spark.

If a prerequisite is fixed, or Genie ended a stage reply without taking its next
step, ask him to continue the same setup. An explicit `setup_spark` call reopens
that saved request and rechecks the same enrolled host. It retains the setup
conversation and previous attention reason. It does not restart a failed native
operation, replay uncertain work, or repeatedly wake Genie for an unchanged
failure. Confirmed failed preparation still uses `resume_spark_preparation`.
