# Review credential-free trusted LAN access (lan_auth)
Recent commit bd2d032 added shared admission + credential-free trusted LAN access.
Security review: who can reach :30000 door from LAN, api_key "none" on 8013 (localhost
only — confirm binding), CSRF on dashboard write routes.

## REVIEWED (2026-09-22 ~03:05)
- :8013 (oMLX direct): bound 127.0.0.1 only — not reachable from LAN. api_key
  "none" is therefore acceptable. CONFIRMED SAFE.
- :30000 (door): binds *:30000 (LAN-facing, intended). lan_auth='none' +
  trustedHomePeer's default home-subnet prefix → any home-subnet peer bypasses
  the bearer key (by design, Jordi's home LAN). Forwarded headers never grant
  access; TCP peer only. Documented behavior.
- :30010 (dashboard): 127.0.0.1 only. Write routes require same-origin + CSRF
  token (timing-safe compare). Genie tool endpoints use random 32-byte tokens.
- api_key is set on the gate config (not 'none'), so non-LAN callers need it.
- Residual: the home-subnet trust rule is the whole security boundary. Anyone on
  that VLAN can use the fleet without a key. Acceptable per design; note it in
  docs (card 022).

## REVIEWED (2026-09-22 ~03:05)
- Direct engine port (oMLX M3): bound loopback only — not reachable from LAN.
  api_key "none" is therefore acceptable. CONFIRMED SAFE.
- Ingress door (:30000): binds on all interfaces (LAN-facing, intended). lan_auth
  'none' + trustedHomePeer's default home-subnet prefix → peers there
  bypass the bearer key (by design). Forwarded headers never grant access; the
  TCP peer is the only signal.
- Dashboard (:30010): loopback only. Write routes require same-origin + CSRF
  token (timing-safe compare). Genie tool endpoints use random tokens.
- The gate api_key is set (not 'none'), so callers outside the trusted subnet
  need the bearer key.
- Residual: the trusted-subnet rule is the whole security boundary — anyone on
  that VLAN can use the fleet keyless. Acceptable per design; note in docs
  (card 022).