# Review credential-free trusted LAN access (lan_auth)
Recent commit bd2d032 added shared admission + credential-free trusted LAN access.
Security review: who can reach :30000 door from LAN, api_key "none" on 8013 (localhost
only — confirm binding), CSRF on dashboard write routes.
