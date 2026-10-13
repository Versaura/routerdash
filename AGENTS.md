# AGENTS.md

Guide for AI coding tools (Claude Code, Codex, Copilot, Cursor) and new contributors working on RouterDash.

## What this is

RouterDash is a local web dashboard for one specific router: the **GTPL Camnex CNP4000A** fibre ONT (Realtek chipset, `boa` web server, firmware `GTPL_V4.0.1-260626`). It runs on a Mac on the home network and is opened from phones on the same Wi-Fi at `http://<mac-ip>:8686`.

The router has no API. RouterDash reads its admin web pages and submits its HTML forms exactly as the router's own pages would.

## Commands

```bash
npm install        # one dependency: node-html-parser
npm start          # app on :8686, DNS recorder on :53
npm test           # end-to-end: mock router + fake DNS upstream (needs openssl)
```

Node 18+. No build step, no bundler, no framework.

## Layout

| Path | What it does |
|---|---|
| `server.js` | HTTP server, JSON API, background pollers, scheduler, speed-limit reconciler, activity endpoints |
| `lib/router.js` | Talks to the router: login, page reads, form submits. All router knowledge lives here |
| `lib/form.js` | Port of the router's `postTableEncrypt()` checksum and its form serialisation |
| `lib/dns.js` | DNS forwarder that logs lookups per device, plus `buildTimeline()` |
| `lib/services.js` | Domain → app/website/background catalog and classifier |
| `public/index.html` | The whole UI: one file, vanilla JS, no build |
| `test/mock-router.js` | Fake router used by tests; mirrors real field names and the checksum check |
| `test/smoke.test.js` | End-to-end tests (`node:test`) |
| `docs/` | Architecture, router reverse-engineering notes, API reference |

User data lives in `~/.routerdash/` (outside the repo): `config.json` holds the router password and PIN hash; `data.json` holds names, schedules and limits; `activity/*.jsonl` holds DNS history. Never commit anything from there.

## Rules that matter

1. **Every POST must carry a valid `postSecurityFlag`.** Build bodies with `F.findForm` → `F.applyValues` → `F.serialize`, never by hand. Field order matters: it follows document order, and the checksum covers the exact encoded string. The test `checksum matches the value the real router computed` pins this to a value captured from the real device (40523). If it ever fails, the encoder is wrong.
2. **Mirror what the page's own JavaScript does before submit.** Many pages change fields in `onclick` handlers: disable inputs, rewrite values, build a hidden `lst` field. Read the handler first, then copy it in a `mutate` callback. Examples: Wi-Fi off sets `wlanDisabled` to `ON` and greys out 8 fields; traffic shaping base64-encodes its whole rule into `lst`. `docs/ROUTER-NOTES.md` lists the known ones.
3. **Use `Router.raw()` for all router I/O.** The router's HTTP replies break Node's strict parser, so `raw()` opens a fresh TLS socket per request, speaks HTTP/1.0 and parses leniently. Don't switch to `fetch`/`https.request`.
4. **Serialise router calls** through `router.run()`, which `get()` and `submit()` already do. The router is single-session (sessions are tied to the client IP) and falls over with parallel requests.
5. **Tables drawn by JavaScript aren't in the HTML.** QoS pages fill tables from `xxx.push(new it_nr(...))` script data. Read it with `Router.scriptArray(html, 'arrayName')`.
6. **Nothing destructive without the user.** Don't add code paths that reboot, factory-reset, change the admin password, upgrade firmware, or change WAN/PPPoE/TR-069 settings. These can take the household offline or lock the user out.
7. **Keep forwarding DNS even when recording is paused.** Once the router's DHCP points devices at this Mac, stopping the DNS server breaks name lookups for the whole house.
8. **Privacy.** Activity history stays local. Don't add uploads, analytics or remote logging.

## Changing router behaviour safely

1. Find the page in `docs/ROUTER-NOTES.md`, or read it from the live router: log in through a browser on the LAN and fetch the `.asp` page plus its inline `<script>`.
2. Implement it in `lib/router.js` using `submit(page, formPredicate, values, clickButtonName, mutate)`.
3. Add the page to `test/mock-router.js` with the same form names, and make the mock reject a bad `postSecurityFlag`.
4. Add a case to `test/smoke.test.js`, then run `npm test`.
5. Test once on the real router. Before submitting, compare the logged `POST <action> (<n> bytes)` body with what the router's own page sends (browser devtools → Network).
6. Record any new quirks in `docs/ROUTER-NOTES.md`.

## Style

- Plain CommonJS, `'use strict'`, 2-space indent, no TypeScript.
- UI copy is plain and specific ("Turning Wi-Fi off…", "Fixed. The device gets it when it next reconnects."). Errors say what went wrong and what to do next.
- UI colours are CSS variables in `:root` with a dark-mode block. Don't hard-code colours.
- Keep zero build tooling. If you add a dependency, justify it in the PR.

## Commits

Small, focused commits with imperative subjects ("Add per-device upload limit"). Update `CHANGELOG.md` under *Unreleased* for anything user-visible. Run `npm test` before committing.
