# Changelog

## Unreleased
- Branded as RouterDash by Versaura; new README with banner and screens.
- Works beyond GTPL: LAN range, DNS upstreams and model name now come from the router.
- `npm run check`: read-only compatibility probe for other Realtek-based routers.

## 0.3.0 — 2026-10-13
- Fixed IPs per device (router MAC-Based Assignment).
- Speed limits: a default limit for every device except the full-speed list, plus per-device overrides. Enforced with router traffic-shaping rules and kept in sync every 30 s.
- Activity tab: per-device timeline of apps and websites from DNS lookups, with background services separated out. Kept 30 days on the Mac.
- Fix: the PIN screen stayed visible on every page.
- End-to-end tests against a mock router (`npm test`).

## 0.2.0 — 2026-10-13
- Router connection rewritten to tolerate the router's malformed HTTP replies.
- Fix: the setup error handler crashed the server.

## 0.1.0 — 2026-10-13
- First version: live speed, connected devices, Wi-Fi on/off and schedules, device bedtimes and blocking, port forwarding, URL blocking, restart, PIN-protected dashboard.
