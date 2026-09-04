# Named maintenance locks

Status: **implemented in source; activation requires a controlled gateway and
dashboard cutover.** A named maintenance lock is the durable way to say “this
server is deliberately outside DSG while another person or agent works on it.”
It is stronger and more explanatory than an anonymous Pause.

## Safety contract

- Creating a lock immediately stops new gateway admission. Already admitted work
  is allowed to finish; DS4, model settings and caches are not stopped or edited.
- The lock is saved atomically with the effective paused state and survives DSG
  restarts. A broad operator Resume, an agent hold release, automatic recovery,
  verified profile hand-back and Gate Genie cannot override it.
- A review time is a reminder, not an expiry. An overdue lock becomes a visible
  warning in the health wire but remains a hard veto. Silence, healthy telemetry,
  idle hardware or a newly patched process never proves external work is done.
- Releasing requires the exact lock ID and a release reason. Release deliberately
  leaves an operator pause. A separate Resume performs the existing fresh
  model/context and, when required, generation checks before routing returns.
- Multiple locks may coexist. Each must be released explicitly. Removal is
  refused while any lock or scoped agent hold remains.
- Mutations are serialized through the private Unix operator socket and use UUID
  idempotency keys. Receipts survive restart; an uncertain client response is
  reconciled by request ID rather than replaying a different mutation.

This is an operational ownership fence, not a hostile same-user security
sandbox. A process with the owner's account can access the same private files and
socket. The recorded control channel identifies the client path—not a verified
human identity.

## Dashboard workflow

Open **Settings → Manage DS4 servers**, then choose **Maintenance lock** beside
the server. Supply a short name, an operational reason and optionally a review
reminder in whole hours. Do not place secrets, prompts or conversation text in
those fields.

The Fleet card changes to **Maintenance** and its Play control is disabled. The
Settings row shows every lock, its reason and whether review is overdue. To hand
the server back:

1. Verify the external test or maintenance really finished.
2. Choose **Release _name_** and record why.
3. Choose **Resume routing**. DSG rechecks the already-running endpoint; release
   by itself never starts DS4 or admits work.

## CLI workflow

```sh
./workers.sh lock spark2 \
  --name spark2-speed-test \
  --reason "External DS4 benchmark in progress" \
  --review-after-hours 4
```

The CLI prints its request ID to stderr before sending. Save it. The JSON result
contains `result.lock_id`. On an uncertain response, query the durable receipt:

```sh
./workers.sh maintenance-receipt REQUEST_ID
```

Release only the exact lock, then resume separately:

```sh
./workers.sh unlock LOCK_ID --reason "Benchmark complete and endpoint checked"
./workers.sh resume spark2
```

`--request-id UUID` makes either mutation explicitly retryable. `--config FILE`
or `DWARF_GATE_CONFIG` selects the private DSG deployment as with other worker
commands.

## Private API

The following operator-only routes are accepted on `control_socket`; they are not
available on the inference or dashboard TCP ports:

| Route | Exact body |
| --- | --- |
| `POST /maintenance-lock` | `worker_id`, `name`, `reason`, `review_after_hours` (`null` or 1–8760), `request_id` |
| `POST /release-maintenance-lock` | `lock_id`, `reason`, `request_id` |
| `POST /maintenance-receipt` | `request_id` |

Current locks are included in worker status. Public dashboard snapshots expose
the bounded lock name/times needed for an obvious veto, but not its free-text
reason. The full reason and recent receipts remain behind the private management
path. Names are still local operational metadata and should not contain secrets.

## Relationship to agent holds

A scoped agent drain already creates its own durable owned hold. Use that when an
agent has a DSG credential and can reliably release its own reservation. Use a
maintenance lock when the external process cannot use the agent API, when a human
needs an explicit fleet-wide marker, or when an independent operator veto must
survive agent cleanup. They compose: releasing one never clears the other.
