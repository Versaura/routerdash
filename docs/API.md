# HTTP API

All endpoints are JSON. Every route except `info`, `setup` and `login` needs the `rd` session cookie, which `setup` and `login` set. POST bodies must use `Content-Type: application/json`. Errors return `{ "error": "message" }` with status 4xx.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/info` | | `{configured, authed}` |
| POST | `/api/setup` | `{host, username, password, pin}` | Tests the router login, saves config, sets the cookie |
| POST | `/api/login` | `{pin}` | Sets the cookie. 5 wrong tries lock it for 60 s |
| GET | `/api/state` | | `{status, radios, devices[], totals, history[], selfBand, error}` (served from memory) |
| POST | `/api/device/name` | `{mac, name}` | |
| POST | `/api/device/block` | `{mac, blocked}` | Adds or removes an all-day `RD-block` parental rule |
| GET | `/api/parental` | | `{enabled, rules[]}` |
| POST | `/api/parental/enable` · `/add` · `/delete` | `{enabled}` · `{mac,name,days[],start,end}` · `{selects[]}` | |
| POST | `/api/wifi` | `{idx: 0 (5 GHz) or 1 (2.4 GHz), enabled}` | Refuses to turn off the Mac's own band |
| POST | `/api/reboot` | | |
| GET/POST | `/api/schedules` | `{type:'wifi', bands[], days[], off, on}` or `{type:'reboot', days[], at}` | |
| POST | `/api/schedules/delete` · `/toggle` | `{id}` · `{id, enabled}` | |
| GET | `/api/reservations` | | `{reservations[]}` |
| POST | `/api/reservations/add` · `/delete` | `{mac, ip}` · `{mac}` | |
| GET | `/api/limits` | | `{enabled, downMbps, upMbps, fullSpeed[], custom{}, ruleCount, error}` |
| POST | `/api/limits` | `{enabled?, downMbps?, upMbps?}` | |
| POST | `/api/limits/device` | `{mac, fullSpeed, downMbps?, upMbps?}` | |
| GET | `/api/portfw` | | `{enabled, rules[], protocols[], wanIp}` |
| POST | `/api/portfw/add` · `/delete` | `{comment, localIp, publicPort, localPort, protocol}` · `{selects[]}` | |
| GET | `/api/urlblock` | | `{enabled, domains[], keywords[]}` |
| POST | `/api/urlblock/enable` · `/add` · `/delete` | `{enabled}` · `{domain}` or `{keyword}` · `{kind, selects[]}` | |
| GET | `/api/activity/status` | | `{enabled, running, error, queries, lastQuery, devicesSeen, macIp, days[]}` |
| GET | `/api/activity` | `?day=YYYY-MM-DD` | `{day, devices[{mac, ip, name, top[], activeMinutes, last}]}` |
| GET | `/api/activity` | `?day=…&mac=…` | `{sessions[], top[], background[]}` |
| POST | `/api/activity/enable` · `/clear` | `{enabled}` · | Pausing stops recording only; lookups are still forwarded |

## Environment variables

| Variable | Default | Use |
|---|---|---|
| `PORT` | 8686 | Dashboard port |
| `DNS_PORT` | 53 | DNS recorder port |
| `DNS_UPSTREAMS` | `182.237.9.10,8.8.8.8` | Comma list; `host:port` allowed |
| `ROUTER_PORT` | 443 | Router HTTPS port (tests use the mock's port) |
| `ROUTERDASH_DIR` | `~/.routerdash` | Config and data folder |
