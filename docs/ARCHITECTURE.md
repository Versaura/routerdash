# Architecture

```
 Phone / laptop browser                 Mac running RouterDash                    Router 192.168.1.1
 ──────────────────────                 ──────────────────────                    ──────────────────
 public/index.html  ──JSON /api/*──▶   server.js ──────────────────────────────▶  boa web server (HTTPS)
   (PIN cookie)                          │  pollers: fast 4 s, slow 30 s            /status.asp, /wlstatbl.asp …
                                         │  scheduler: every 15 s                   /boaform/* (form POSTs)
                                         │  speed-limit reconciler (slow poll)
                                         └─ lib/router.js ─ lib/form.js (checksum)

 Every device on Wi-Fi ──DNS :53──▶   lib/dns.js ──▶ 182.237.9.10 / 8.8.8.8
   (router DHCP hands out                └─ ~/.routerdash/activity/YYYY-MM-DD.jsonl
    the Mac as DNS1)                         └─ lib/services.js classify → buildTimeline
```

## Data flow

**Reads.** The fast poller fetches `wlstatbl.asp` for both radios every 4 s and turns byte counters into per-device bit rates. 32-bit counters wrap, which is handled. The slow poller fetches status, ARP, DHCP leases, radio settings, parental rules and reservations every 30 s, then runs the speed-limit reconciler. The UI polls `GET /api/state` every 4 s, and that request is served from memory.

**Writes.** API handler → `router.submit()`. That loads the page, parses the form, applies values, runs the page-specific `mutate` that mirrors its JavaScript, serialises with the checksum, and POSTs.

**Sessions.** The router ties its session to the client IP; there are no cookies. If a reply looks like the login page, `Router` logs in again and retries once.

## Speed limits

The router's IP QoS → Traffic Shaping table holds rules of (direction, source or destination IP, rate in kb/s). RouterDash owns every rule that targets a single 192.168.1.x address.

On each slow poll, the reconciler does this:

1. It computes the wanted rules: for each device seen with an IP and not on the full-speed list, one downstream rule (`dstip`) and one upstream rule (`srcip`).
2. It deletes rules that aren't wanted and adds missing ones, at most 16 adds per round.
3. Before adding the first rule, it turns IP QoS on.
4. When limits are disabled, it removes every rule and switches QoS back off, if RouterDash was the one that switched it on.

Rules follow IP addresses, so devices should have fixed IPs (MAC-Based Assignment).

## Activity history

Once the router's DHCP DNS option says *Set Manually: DNS1 = the Mac*, devices send their lookups to `lib/dns.js`. It forwards each one unchanged to GTPL's DNS, falling back to 8.8.8.8, and returns the answer. TCP queries are piped through.

Each lookup is logged as `{t, ip, mac, q}`. Repeats of the same name from the same IP within 60 s are skipped. The log is written in batches every 5 s and kept for 30 days.

`buildTimeline()` classifies each name with `services.js`:

- **app**: in the catalog, such as YouTube.
- **site**: not in the catalog, shown by its registrable domain.
- **bg**: OS services, analytics, ads, CDNs, and an app's own push or chat sockets like `g.whatsapp.net`.

App and site lookups for the same service, less than 10 minutes apart, become one session. A session with a single lookup is shown as "briefly". Background lookups are counted separately and never appear in the timeline.

## Scheduler

`data.schedules` holds Wi-Fi off/on and reboot jobs. A 15 s timer checks `HH:MM` against the Mac's clock, and `data.lastRuns` stops a job running twice in the same minute. Router-side bedtimes (parental control) don't use this; the router enforces them itself.

## Security

- The router password is stored in `~/.routerdash/config.json` (mode 0600). The dashboard is protected by a scrypt-hashed PIN, a 30-day HttpOnly cookie, and lockout after 5 wrong tries.
- Certificate checking is relaxed only for the configured router address, because it uses a self-signed certificate.
- Don't expose port 8686 to the internet. For remote access, use Tailscale without Funnel.
