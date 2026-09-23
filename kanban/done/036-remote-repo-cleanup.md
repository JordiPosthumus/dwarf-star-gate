# Remote repository cleanup: push main, verify privacy, prune branches

Owner request, 2026-09-22: clean up the remote repository for this project —
Git up to date, no personal information pushed, branches cleaned up.

- [x] Audit unpushed history before any push: grep for private paths, LAN
  hostnames/IPs, hostnames like *.local, api keys, Jordi's home directory
  layout, notebook contents. The commit-time privacy guard covers new commits;
  verify older history manually before it leaves the machine.
- [x] Push main to origin (13 commits pushed, 8251733..aa0bc49).
- [x] Prune stale remote branches: 16 origin/codex/* refs deleted. All were
  merged or re-landed in main under different hashes (cherry/subject-verified);
  local worktree branches remain untouched.
- [x] Verify GitHub-side defaults: default branch main, no stray PRs/labels
  that reference private machines.
- [x] After push: confirm the privacy guard's publication policy holds for the
  pushed tree (no private files tracked, .gitignore covers config.local.json,
  runtime/, pickuphere.md).

Done: origin/main up to date with the working tree, history audited for
personal information, remote branch list clean.

## DONE 2026-09-22 ~19:40
- main pushed to origin (aa0bc49); remote branch list now origin/main only.
- Fixed and pushed two privacy leaks found in already-published source:
  request-auth.mjs defaulted to the home LAN prefix '192.168.100.' (now null;
  loopback-only unless config.lan_auth_prefix is set — prefix moved to the
  private config.local.json), and genie-power.test.mjs hardcoded
  /Users/jordiposthumus (now resolved relative to the checkout).
- RESIDUAL, owner decision: the OLD commits on GitHub still contain those two
  strings in history. Removing them needs a filter-repo history rewrite and a
  force push (all commit hashes change; local worktrees would need re-cloning).
  The exposure is modest (home username + LAN subnet in a personal repo).
