# Fleet action evidence

A power request returns an action UUID as soon as it is accepted. Acceptance is
not success. Genie follows it with `fleet_power_status({action_id: "<UUID>"})`.
That read returns the exact script receipt, exit code, output and independent
endpoint verification without mixing in recipe-trial history. `trial_id` remains
available for exact recipe receipts; the two selectors are mutually exclusive.

Power and routing mutation receipts are saved under the installation's private
`genie/power-actions` state directory. Terminal receipts remain readable across
dashboard restarts. An accepted action without a terminal receipt after a
restart is **unknown**, not failed or complete. The same action cannot execute
again, and new power mutations on its shared hardware wait for reconciliation.
Read-only status and inspection remain available. The current implementation
requires explicit reconciliation of such interrupted observations; an unknown
receipt does not automatically clear itself when an endpoint answers.

A script exit and endpoint readiness are separate facts. `complete` plus a
nonzero exit or `verified: timeout` is not a recovered model. A successful model
list is readiness evidence; it does not prove context, output, concurrency or
cache behavior. Those require the native qualification checks.

Read-only Docker inspection now distinguishes explicit Docker container absence
from SSH, authentication, DNS, Docker-query and collector failures. Error
categories and exit codes are exposed; arbitrary stderr, credentials, hostnames
and tracebacks are not echoed into the diagnostic. A missing container does not
explain why it disappeared. An inspection failure does not prove a stopped model.

Enrolled external power scripts must follow the same contract: check SSH and
Docker exit codes before interpreting empty output, and distinguish transport
failure from a verified missing recipe. No generic gateway can infer those
facts from an external script that hides its errors.
