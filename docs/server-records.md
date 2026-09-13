# Private server configuration records

Star Gate can show a private configuration library in Settings and give its
selected facts to conversational Genie. Set `server_records_directory` in the
installation's private configuration. Relative paths resolve beside that config
file. Keep the library in an operator-controlled private Git repository, outside
the public source tree.

Each worker can have three separate JSON files: `observed/<worker-id>.json`,
`approved/<worker-id>.json` and `proposed/<worker-id>.json`. Missing records are
normal. An observation is dated evidence, not owner approval or continuous engine
inspection. Neither the library nor this chat grants permission to change a server.

Minimal synthetic observation:

```json
{
  "schema": 1,
  "worker_id": "example",
  "kind": "observed",
  "recorded_at": "2026-01-01T00:00:00Z",
  "runtime": {"name": "example-engine", "version": "example-version"},
  "model": {"name": "example-model"},
  "settings": {"context_length": 262144, "server_concurrency": 2},
  "restoration": {"retention": "unverified", "drill": {"status": "unproven"}},
  "discrepancies": [],
  "configuration": {},
  "evidence": []
}
```

Record only demonstrated settings; omit unknown values. Distinguish settings read
from a launcher or saved file from effective running settings. Use `configuration`
and `evidence` for private launch commands, environment requirements, paths,
secret references, artifact identities and inspection receipts. Store references
to credentials, never credential contents. Do not execute record contents.

Before recording an approved configuration, include the owner's actual approval
date and private receipt reference in `approval.at` and `approval.reference`.
Check the recipe is sufficient to recreate and evaluate that exact version:

- Runtime, dependencies, model and local modifications; exact launch/install
  settings and credential references.
- Previous approved revision and where its artifacts and environment are retained.
  Git history of a launcher does not retain a container image or overwritten environment.
- Concrete restore steps, success checks and outstanding gaps.
- A controlled restore drill receipt, or an explicit `unproven` result. To record a
  completed drill, use `restoration.drill.status: "restored-in-drill"`, `at` and
  `receipt`. This is an operator's evidence record; the reader does not execute or
  independently authenticate the drill. Approval and restoration are separate facts.

Use `retained`, `not_retained` or `unverified` for `restoration.retention`. Record
`previous_approved_revision` where one exists. Automatic rollback must not be
promised for unretained state, model weights/shared model directories, shared
dependencies or environments, drivers, or service-definition changes.

The dashboard reads known worker IDs only and exposes an allowlist of runtime,
model, selected settings, dates, content revisions, restoration status and fixed
discrepancy categories. Commands, filesystem paths, approval references and raw
evidence are excluded. Genie receives that same projection and saves the facts
used with each reply. Consequently these selected configuration facts become
part of private conversation history and are sent to the configured chat model;
choose that provider accordingly.

Invalid records are reported without rewriting them or preventing other records
from loading. The reader rejects symlink library/category entries and symlink
files; it is not a sandbox for a hostile filesystem administrator. Keep the entire
library path operator-controlled. Files larger than 1 MiB are rejected. This
feature does not change recovery enrollment, schedule inspections, or establish
restore readiness by itself.
