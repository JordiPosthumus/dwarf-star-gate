# Genie first-install validation

Verified during development on 2026-09-14 (UTC), by Codex.

- **macOS ARM64:** exported public source into a separate checkout and used an
  empty home, without reading the owner's private configuration or reusing an
  installed Hermes, uv or Python. Setup downloaded its dedicated dependencies
  and obtained a real reply from an explicitly selected, existing local model
  endpoint. Python resolved inside the new installation (CPython 3.12.13);
  Hermes was revision `2237be355906fbe6065ce1815711eee52b2d646e`.
- **Real browser/model check:** the new dashboard answered from the soul's prime
  directive and passions, remembered a name in a follow-up and retained both turns
  after reload. All three foreground services subsequently started together with
  an empty fleet and the conversation persisted. The isolated fixture used separate
  ports and short Unix socket paths to avoid the production installation and macOS's
  socket-path length limit.
- **Linux ARM64:** a fresh Debian Bookworm container with Node 22, Git and tar,
  without Hermes or private configuration, completed `npm run genie:install-test`.
  This downloaded actual Hermes/Python and used a scripted HTTP model. It verified
  native soul injection, default reasoning omission, private configuration,
  preservation of personal Hermes and soul edits, all three services, two-turn
  conversation and history after dashboard restart. This proves installation and
  integration, not the intelligence of the scripted model.
- **Existing-installation checks:** ordinary gateway installation and forwarding
  regressions passed; setup preserves an already configured Genie, does not overwrite
  unrelated settings on invalid input, and does not echo malformed private JSON.
  The actual Hermes tests verify that an edited soul reaches the next turn and an
  empty soul fails without making a provider request. Research permission checks
  remain in force.

The initial macOS development run exposed conflicting uv flags; that was corrected
before the successful installation and fresh Linux runs. A scripted-provider test
also needed to return 404 for Hermes's optional `/api/show` discovery probe rather
than treating every POST as a chat request.

Run the download/integration proof explicitly from committed or staged source:

```sh
npm run genie:install-test
npm run setup:test
```

The download test exports the Git index into a temporary checkout. It requires
internet access and may take several minutes. Standard unit tests do not silently
install dependencies. Set `SG_KEEP_INSTALL_TEST=1` to retain its private fixture for
inspection; never publish that fixture's generated configuration or conversations.

Not established by these checks: x64 platform execution, native Windows support,
model installation, automatic web-service installation, long-term Genie memory,
server-changing authority or the remaining DSG v6 scheduling features. Users still
supply a reachable model API; Star Gate now supplies the dedicated Hermes runtime.
