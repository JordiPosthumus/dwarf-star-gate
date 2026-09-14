# Public-research fetch protection

Star Gate checks research URLs before sending them to a scraper. The scraper must
also reject private addresses at connection time and on redirects. A separate DNS
preflight cannot guarantee that the subsequent connection resolves the same way.

`public-dns.ts` is the small connection-time lookup guard qualified with the
self-hosted Firecrawl Playwright service using proxy-chain 2.7.1 and Node 22.
It supplies only the checked lookup results to the socket; it does not resolve
once for checking and then independently resolve again for connection.

For a compatible Firecrawl source checkout, place this helper beside its `api.ts`,
import `publicLookup`, and add this field to the existing proxy-chain
`prepareRequestFunction` return value:

```ts
return {
  upstreamProxyUrl: buildUpstreamProxyUrl(),
  dnsLookup: !ALLOW_LOCAL_WEBHOOKS && !PROXY_SERVER
    ? publicLookup as typeof import('node:dns').lookup
    : undefined,
};
```

Keep the existing target-URL checks, literal-address checks, request interception
and local browser proxy. Literal IP connections can bypass a DNS callback. Both
HTTP forwarding and HTTPS CONNECT must use this callback. If an upstream proxy is
configured, that proxy owns destination resolution and needs its own protection;
this snippet does not establish that protection.

This is an external-service integration reference, **not an automatic installer**.
Installing Star Gate from GitHub does not apply this patch to another Firecrawl
installation. Verify the actual installed fetching code and dependencies, rebuild
the scraper with its existing settings, and roll it out when its work is idle.
Preserve the previous working image and unrelated Compose settings.

Qualification covered the actual built browser-service image: normal HTTP/HTTPS
public pages, private DNS results for HTTP and CONNECT, a public preflight followed
by a private connection-time result, and a verified public redirect to a private
canary. The canary received zero requests in the rejection cases. This does not
certify every Firecrawl engine or an external proxy. The API's separate HTTP fetch
engine also needs its own socket-address protection.
