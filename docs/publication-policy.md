# Public documentation versus private operations

Publish reusable behavior, setup instructions, exact intentionally recommended
profiles, public source/model pins, synthetic regressions and known limitations.
Do not turn this repository into an operator's maintenance journal.

Keep the following out of Git and the published repository. They may live in the
checkout's ignored `config.local.json` and `runtime/` directories; a second source
checkout is neither required nor recommended:

- Fleet inventory, hostnames, private addresses, accounts, service enrollment
  fingerprints, locally built binary fingerprints and enabled policy state.
- Precise maintenance chronology, per-machine runtime measurements, request/action
  identifiers, incident logs and real session examples, even without prompt text.
- Collector data, embeddings, XGB reports/bundles, hardware inventory and raw
  screenshots of operating systems. Numerical metadata can still identify usage.
- Credentials, private harness configuration, model files and KV checkpoints.

The intentionally recommended Spark launch settings and public artifact hashes
remain useful configuration documentation. They do not imply that a particular
person owns that hardware or has enabled those settings. Benchmark publication
requires a separate, deliberate review of scope and identifying details; do not
silently replace removed real results with invented measurements.

## Before committing

```sh
npm run hooks:install
git diff --cached
npm run privacy-check
npm run privacy:test
```

The repository-local pre-commit hook checks **the exact staged blobs**, including
new files, not merely their current working copies. It blocks known secret/path
patterns, private artifact names and some deployment-diary phrases, timestamps
and identifiers. The ordinary check also scans tracked working copies; CI runs
it against the checked-out commit. Regression tests exercise actual Git commits.
The installer refuses to replace an existing custom hook setup.

The hook also checks effective **author and committer email**, including Git
environment overrides. Use the exact noreply address shown in your GitHub email
settings with `git config --local user.email 'YOUR_VERIFIED_NOREPLY_ADDRESS'`.
Names and attribution remain unchanged. If you deliberately want an address to
be public, record that choice locally with
`git config --local --add dsg.publicEmail 'YOUR_REVIEWED_PUBLIC_ADDRESS'`.
Synthetic identity tests use the reserved `example.invalid` domain. Identity
checks do not rewrite existing commits and CI does not enforce your local choice.

The content guard additionally flags custom-domain email, credential-bearing
URLs, common cloud-token shapes, private temporary paths, and PNG text/EXIF
metadata or malformed/trailing PNG payloads. It reports categories, not secret
values. This is not a general binary-file validator: inspect other image formats,
archives and document metadata manually. PNG pixel contents still need review.

Hooks are not installed automatically in new clones. Run the installation command
there, or integrate the check into existing hooks. A local user can bypass hooks;
CI runs only after a push and cannot undo public exposure. These are guardrails,
not authorization, a semantic privacy proof or a Git-history scrubber.

Human review is still required: ask whether the prose describes a reusable
capability or reveals someone's actual activity. Review images and metadata too;
the text scanner does not OCR screenshots. Use the isolated synthetic dashboard
for public captures. Preserve upstream attribution and public source links.

If identifying data was already published, generalizing the current tree does
not remove earlier commits, cached copies, forks or clones. Coordinate any
history rewrite separately; rotate an exposed secret rather than relying on
file deletion. Never force-push shared history as an unannounced cleanup step.

For a publication audit, inspect every reachable public branch/tag, historical
file versions and commit identities/messages—not just the latest checkout.
Review tracked screenshots against their synthetic capture source. Keep audit
reports and matched values outside Git. State the scanned ref and coverage;
unreachable GitHub objects, PR refs, old CI logs, forks and caches need separate
checks and cannot be cleared by a clean working-tree scan.
