# Share on LAN

Open **Settings → Share on LAN**. Switching on reveals the OpenAI API address
ending in `/v1` and the gateway's configured API key. On macOS the primary
address uses that Mac's actual Bonjour `LocalHostName` plus `.local`, discovered
automatically with `scutil` and refreshed at most once per minute. It is not
hard-coded to the developer's machine. DHCP address changes do not require
changing this hostname URL. The current numeric address remains under
**IP fallback** for clients or networks without working mDNS. No machine is
renamed and no DNS, router, bind or credential settings are changed. Click either field to
select it for copying.

The setting takes effect on new requests immediately and survives front-door
restarts. Turning it off rejects new non-loopback requests with HTTP 503 before
forwarding; existing responses and already-admitted waits finish normally.
Local clients using `127.0.0.1` or `::1` continue working. Neither the toggle nor
its state file changes model servers, caches, routing allowances or API keys.

The Continuity Door owns the switch and the private Unix control endpoint.
The dashboard remains bound to loopback, and its mutation requires same-origin
JSON plus a CSRF token. Peer checks use the real socket address rather than
forwarded headers. The TCP listener stays bound while sharing is off, so a port
scan may still find an open port; model requests are rejected at admission.

Before a saved choice exists, the switch preserves the configured public bind:
a gateway already bound to `0.0.0.0` starts shared. The control is available for
Continuity Door installations with a non-loopback bind; it does not silently
rewrite a loopback-only installation's host setting. Connection addresses come
from currently assigned private IPv4 interfaces, excluding VPN-only interfaces.
DHCP changes are reflected in the fallback address. Non-macOS systems and
failed Bonjour-name discovery retain numeric addresses; DSG does not invent a
`.local` name that the host might not advertise. The displayed address can be used from
another device on the same LAN; router guest isolation or host firewalls may
still restrict connectivity. No router port forwarding is configured.

State lives in `runtime/lan-sharing.json`. Writes validate existing state,
keep a timestamped backup, and use an fsynced temporary file plus atomic rename.
An unreadable state is not overwritten. The initial feature deployment requires
one idle front-door reload; subsequent toggles require no service restart.
