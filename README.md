# RouterDash

A Xiaomi-style dashboard for the GTPL **Camnex CNP4000A** fibre router (firmware `GTPL_V4.0.1`).
It runs on your Mac and you open it from any phone or laptop on your Wi-Fi.

## Start it

```bash
cd ~/Downloads/routerdash     # wherever you unzipped it
npm install
npm start
```

The terminal prints two addresses:

- `http://localhost:8686` — open this on the Mac.
- `http://192.168.1.x:8686` — open this on your phone. In Safari, tap Share → **Add to Home Screen** to get an app icon.

On first open, enter the router username and password (the ones you used at `https://192.168.1.1/admin/login.asp`) and choose a 4–8 digit PIN. The router password is stored only on this Mac, in `~/.routerdash/config.json`, readable only by your user.

## Keep it running

The Wi-Fi and reboot schedules run on this Mac, so it needs to stay on and running RouterDash. You already have pm2 installed:

```bash
pm2 start server.js --name routerdash
pm2 save
pm2 startup        # run the command it prints, so RouterDash starts after a restart
```

To stop the Mac sleeping while plugged in: System Settings → Battery → Options → "Prevent automatic sleeping on power adapter when the display is off".

## What it does

| Feature | Where it runs | Notes |
|---|---|---|
| Live download/upload speed, per device and total | Mac | Measured from the router's Wi-Fi counters every 4 s. Wired traffic isn't counted. |
| Connected devices (band, signal, IP, link speed, time connected, data used) | Mac | Name each device by tapping it. |
| Block a device's internet | **Router** | Uses the router's Parental Control. Keeps working when the Mac is off. |
| Bedtimes per device (days + time window) | **Router** | Same mechanism. Start must be earlier than end; split overnight windows in two. |
| Wi-Fi 2.4 GHz / 5 GHz on/off, now or on a schedule | Mac | The router has no Wi-Fi timer. The band this Mac uses can't be scheduled off, because the Mac would lose the router. Use a cable to schedule both. |
| Scheduled restart | Mac | |
| Port forwarding | Router | See the CGNAT note below. |
| Website and keyword blocking | Router | Applies to all devices. |

## Fixed IP addresses

Open a device → **Fixed IP address** → *Fix this IP*. This uses the router's MAC-Based Assignment, so the device always gets that address. It takes effect the next time the device reconnects to Wi-Fi.

Fix the Mac's own address first (192.168.1.3). Activity history depends on it. Also set the Mac's Wi-Fi to a stable hardware address: System Settings → Wi-Fi → Details (next to your network) → Private Wi-Fi address → **Off** (or **Fixed**).

## Speed limits

Tools → **Speed limits**. When it's on, every device gets the default limit (10 Mbps down / 3 Mbps up to start) except the ones you mark **Full speed** on their device page. You can also give one device its own limit.

- Rules live on the router (IP QoS → Traffic Shaping), one per device and direction. RouterDash checks every 30 seconds and adds or removes rules, so new devices are limited shortly after they join.
- This Mac is added to the full-speed list automatically.
- Turning it off removes every rule RouterDash made and turns QoS back off.
- Run a speed test from a full-speed device after turning it on. On some fibre routers QoS lowers the top speed.
- Rules follow IP addresses, so give full-speed devices a fixed IP.

## Activity history

The Activity tab shows which apps and websites each device used, and when. For example: "YouTube 8:10–8:44 PM", "Instagram 9:05–9:22 PM". Background noise (Apple/Google system services, app analytics, ads, CDNs, WhatsApp's always-on connection) is kept out of the timeline and summarised separately.

How it works: RouterDash runs a small DNS server on this Mac (port 53). Devices look up names through it, it forwards each lookup to GTPL's DNS unchanged, and writes down which device asked for what. History stays on this Mac for 30 days (`~/.routerdash/activity`).

**One-time router setup** (after RouterDash is running and the Mac has its fixed IP):

1. On the router: LAN → DHCP → **DNS option: Set Manually**
2. DNS1 = `192.168.1.3` (this Mac), DNS2 = `182.237.9.10` (GTPL)
3. Apply. Devices pick it up when they reconnect or renew (toggle Wi-Fi off/on to speed it up).

To check it from Terminal: `dig @192.168.1.3 youtube.com` should return an address.

To undo: set DNS option back to **Use DNS Proxy**.

What to expect:
- DNS2 keeps the internet working if the Mac is off or asleep. Devices sometimes use DNS2 anyway, and those lookups aren't recorded, so some gaps are normal.
- iPhones with iCloud Private Relay, Chrome/Firefox "Secure DNS", Android "Private DNS", and VPNs bypass it. Those devices show little or nothing.
- Times are estimates. A session runs from the first lookup to the last, joining gaps under 10 minutes.
- It records site names (youtube.com), not pages or searches.
- Tell the people in your home that this is on.

If macOS refuses port 53, the Activity tab says so. Running `sudo npm start` fixes it.

## Important: port forwarding and CGNAT

Your router's internet address is **10.130.x.x**, a private carrier (CGNAT) address. GTPL shares one public IP between many customers, so a port-forward rule saves fine but **nothing becomes reachable from the internet**. Ask GTPL for a public/static IP (usually a paid add-on), or use Tailscale or Cloudflare Tunnel, which work behind CGNAT.

## Private MAC addresses

iPhones and Android phones use a random MAC per network by default. That makes them show up as "Phone / tablet", and blocks or bedtimes can stop working if the phone changes its address. For your home Wi-Fi, turn this off on each phone:

- iPhone: Settings → Wi-Fi → (i) next to your network → Private Wi-Fi Address → Off
- Android: Wi-Fi → your network → Privacy → Use device MAC

## First run: check each control once

Every save is built from the router's own form and signed with the same checksum its web page uses, which was verified against the router. Still, before relying on a schedule, try each control once while you can see the router's own page:

1. Turn **2.4 GHz** off and on from the Home screen (the Mac is on 5 GHz, so it stays connected).
2. Add a bedtime for a test device, check it appears under Advance → Parental Control on the router, then remove it.
3. Add and remove a test port-forward rule.

If something doesn't take effect, the terminal shows each `POST` the app sent. Send me that line and the router page's behaviour, and I'll adjust the field mapping.

## Notes

- The router allows one admin session at a time. If you log into `192.168.1.1` in a browser while RouterDash runs, one may log the other out. RouterDash logs back in automatically.
- The router uses a self-signed certificate. RouterDash accepts it only for the router's address.
- Change the port with `PORT=9000 npm start`.

## Development

```bash
npm test     # end-to-end tests against a mock router (needs openssl)
```

- [AGENTS.md](AGENTS.md): how the code is organised and the rules for changing it (also read by AI coding tools)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how data flows, speed limits, activity history
- [docs/ROUTER-NOTES.md](docs/ROUTER-NOTES.md): every router page, form field and quirk we rely on
- [docs/API.md](docs/API.md): the dashboard's JSON API and environment variables
- [CHANGELOG.md](CHANGELOG.md)
