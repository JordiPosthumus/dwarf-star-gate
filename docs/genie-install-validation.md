# Genie first-install validation

Verified during development on 2026-09-14 and 2026-09-15 (UTC), by Codex.

- **Current release recheck, macOS ARM64:** the public `27ecea4` source plus
  the test corrections described below was exported into a new checkout with an
  empty home. Setup downloaded the pinned Hermes runtime and private Python,
  verified the scripted model connection and passed `doctor`. Two chat turns
  used the native, locally edited SOUL and preserved history across a dashboard
  restart. Repeating setup preserved configuration, soul edits and a separate
  personal Hermes. The test uses separate TCP ports and the normal relative
  control socket paths; it checks the dashboard's gateway view and the public
  Door's connection to the empty gateway. This is a real runtime installation
  with a scripted provider, not a new real-model quality assessment.
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
- **Linux x64, 2026-09-15:** a fresh Debian Bookworm container running
  Node 22.22.2 as Linux x64 under Docker Desktop's Rosetta emulation fetched public
  source `89f7b49`. Only the test's interpreter-baseline correction below was
  staged; application/installer code was unchanged. No host files, personal
  configuration, Hermes, Python or uv were supplied. Actual dependency installation,
  scripted connection check, doctor, three services, two chat turns, edited SOUL,
  personal Hermes preservation and history after dashboard restart all passed.
  The installed Hermes's own Git HEAD and installation receipt both named
  `2237be355906fbe6065ce1815711eee52b2d646e`. This proves the x64 Linux binaries and
  installation flow under emulation; it is not native x64 hardware performance
  or a real-model quality result.
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

The current recheck initially failed a test assertion after setup had succeeded:
macOS exposed the fixture under `/var`, while setup correctly recorded its
canonical `/private/var` path. The test now resolves the fixture and both runtime
paths before checking that Hermes and Python belong to the installation. It uses
a short macOS temporary directory so the default Unix socket paths fit the OS
limit, and runs `doctor` before starting services. This corrects the test; it does
not change the installer or remove the OS limit on long installation paths.

The x64 run initially failed after successful setup because Rosetta created an
empty `.cache/rosetta` in the fixture's user home. A separate Node-only container
reproduced this without loading Star Gate or installing Hermes. The test now
launches the same interpreter once before setup and snapshots that baseline;
setup must preserve its paths, modes and file hashes. It does not ignore arbitrary
cache changes or weaken the separate personal-Hermes and SOUL preservation checks.
The failed and successful environments were distinct, initially clean containers.

Run the download/integration proof explicitly from committed or staged source:

```sh
npm run genie:install-test
npm run setup:test
```

The download test exports the Git index into a temporary checkout. It requires
internet access and may take several minutes. Standard unit tests do not silently
install dependencies. Set `SG_KEEP_INSTALL_TEST=1` to retain its private fixture for
inspection; never publish that fixture's generated configuration or conversations.

Not established by these checks: macOS x64 execution, native x64 hardware testing,
native Windows support,
model installation, automatic web-service installation, long-term Genie memory,
server-changing authority or the remaining DSG v6 scheduling features. Users still
supply a reachable model API; Star Gate now supplies the dedicated Hermes runtime.
