# Remote repository cleanup: push main, verify privacy, prune branches

Owner request, 2026-09-22: clean up the remote repository for this project —
Git up to date, no personal information pushed, branches cleaned up.

- [ ] Audit unpushed history before any push: grep for private paths, LAN
  hostnames/IPs, hostnames like *.local, api keys, Jordi's home directory
  layout, notebook contents. The commit-time privacy guard covers new commits;
  verify older history manually before it leaves the machine.
- [ ] Push main to origin (branch is ~45+ commits ahead).
- [ ] Prune stale remote branches (codex/* leftovers etc.). Confirm each is
  merged or intentionally abandoned before deleting.
- [ ] Verify GitHub-side defaults: default branch main, no stray PRs/labels
  that reference private machines.
- [ ] After push: confirm the privacy guard's publication policy holds for the
  pushed tree (no private files tracked, .gitignore covers config.local.json,
  runtime/, pickuphere.md).

Done: origin/main up to date with the working tree, history audited for
personal information, remote branch list clean.
